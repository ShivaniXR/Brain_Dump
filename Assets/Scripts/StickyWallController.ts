/**
 * Brain Dumpd — StickyWallController (presentation).
 *
 * Data-driven sticky notes. Reads the shared TaskStore and, for each active task,
 * clones a note template (copyWholeHierarchy), colours it by ring, sets its title at
 * runtime, positions it in the Now/Next/Later column, and slaps it on with a staggered
 * pop. Re-renders on any TaskStore change and on anchor-state changes.
 *
 * Anchor branch: located/searching -> all three columns on the wall; unlocated (new
 * room) -> only the Now column (portable), Next/Later hidden.
 *
 * Attach to the StickyWall root. Requires: template (disabled NoteTemplate = group with
 * "Quad" + "Label" children), and the three column materials. Headers named H_now/H_next/
 * H_later under the root get their text set at runtime.
 */
import { TaskStore } from "./TaskStore";
import { getTaskStore } from "./TaskStoreProvider";
import { getAnchorState, onAnchorStateChange } from "./AnchorStateProvider";
import { isMicFollowing } from "./MicHudStateProvider";
import { Ring } from "./TaskTypes";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { InteractableManipulation } from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation";

@component
export class StickyWallController extends BaseScriptComponent {
  @input template: SceneObject;
  @input matNow: Material;
  @input matNext: Material;
  @input matLater: Material;

  @input popDuration: number = 0.32;
  @input stagger: number = 0.09;

  @input
  @allowUndefined
  @hint("Crumpled paper-ball prefab spawned when a note is thrown or dragged off to delete it.")
  paperBall: ObjectPrefab;

  @input
  @hint("Release speed (cm/s) above which a drag counts as a throw-to-delete.")
  throwSpeed: number = 45;

  @input
  @hint("How far below the board (cm) the invisible floor sits — where crumpled balls land and rest.")
  floorDropCm: number = 150;

  @input
  @hint("World size (cm) of the crumpled paper ball.")
  ballScaleCm: number = 11;

  @input
  @allowUndefined
  @hint("Optional chime played when a timed task comes due (in-session reminder).")
  reminderSound: AudioTrackAsset;

  @input
  @allowUndefined
  @hint("The roaming mic HUD — new notes fly from here to the board when dumped away from the wall.")
  micHud: SceneObject;

  private readonly colX: { [k: string]: number } = { now: -42, next: 0, later: 42 };
  private readonly colCap: { [k: string]: number } = { now: 5, next: 5, later: 5 };
  private readonly topY = 18; // first row sits clear of the header underline
  private readonly stepY = 22;
  private readonly peelY = -60; // dragged below this = peeled off = crumple + delete

  private store: TaskStore;
  private clones: SceneObject[] = [];
  private anims: { obj: SceneObject; delay: number }[] = [];
  private elapsed = 0;
  private startScale = new vec3(0.02, 0.02, 0.02);
  private fullScale = new vec3(1, 1, 1);

  // --- in-session reminders (fire only while the Lens is open) ---
  private audio: AudioComponent | null = null;
  private reminders: { note: SceneObject; id: string; time: string }[] = [];
  private firedReminders: { [key: string]: boolean } = {}; // key = id@HH:MM, survives re-renders
  private pulses: { note: SceneObject; t: number }[] = []; // active reminder alarms
  private readonly alarmDuration = 8; // how long a due reminder rings + bounces (seconds)

  // --- fly-in: fresh notes travel from the mic HUD to their slot on the board ---
  private seenIds: { [id: string]: boolean } = {};
  private flyingIn: { obj: SceneObject; target: SceneObject; t: number; from: vec3; to: vec3 }[] = [];
  private readonly holdDuration = 0.7; // note pops in and hovers in front of you first
  private readonly flyDuration = 1.5; // then a slower flight to the wall

  // --- trash / crumple physics state ---
  private trashRoot: SceneObject | null = null;
  private floor: SceneObject | null = null;
  private falling: { obj: SceneObject; body: BodyComponent; life: number; frozen: boolean }[] = [];
  private readonly ballLife = 2.6; // seconds a crumpled ball lives before it fades out
  private readonly shrinkWindow = 0.5; // last seconds spent shrinking to nothing

  // Release-velocity tracking for the currently grabbed note (world cm/s).
  private grabNote: SceneObject | null = null;
  private grabPrevWorld = vec3.zero();
  private grabVel = vec3.zero();

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
    this.createEvent("UpdateEvent").bind(() => this.animate());
  }

  private setup(): void {
    if (this.template) this.template.enabled = false;
    if (this.reminderSound) {
      this.audio = this.getSceneObject().createComponent("Component.AudioComponent") as AudioComponent;
      this.audio.audioTrack = this.reminderSound;
    }
    this.setHeaderText();
    this.store = getTaskStore();
    this.store.onChange(() => this.render());
    onAnchorStateChange(() => this.render());
    this.render();
  }

  private setHeaderText(): void {
    const names: { [k: string]: string } = { H_now: "NOW", H_next: "NEXT", H_later: "LATER" };
    const root = this.getSceneObject();
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const ch = root.getChild(i);
      if (names[ch.name]) {
        const t = ch.getComponent("Component.Text3D") as Text3D;
        if (t) {
          t.text = "";
          t.text = names[ch.name];
        }
      }
    }
  }

  private setChildVisible(name: string, visible: boolean): void {
    const root = this.getSceneObject();
    for (let i = 0; i < root.getChildrenCount(); i++) {
      if (root.getChild(i).name === name) root.getChild(i).enabled = visible;
    }
  }

  private render(): void {
    for (let i = 0; i < this.clones.length; i++) this.clones[i].destroy();
    this.clones = [];
    for (let i = 0; i < this.flyingIn.length; i++) this.flyingIn[i].obj.destroy(); // cancel in-flight
    this.flyingIn = [];
    this.anims = [];
    this.reminders = []; // rebuilt below; firedReminders persists so a chime fires once
    this.pulses = [];
    this.elapsed = 0;
    if (!this.template) {
      print("[StickyWall] no template assigned.");
      return;
    }

    const state = getAnchorState();
    const located = state === "located";
    // The post-it placeholder + its hint only show while placing / re-anchoring — hidden once
    // the wall is locked, and during onboarding (only the welcome note shows then).
    const placing = state === "placing";
    this.setChildVisible("WallBackdrop", placing);
    this.setChildVisible("PlaceHint", placing);
    const chrome = ["H_now", "H_next", "H_later", "SweepButton", "NewWallButton"];
    for (let i = 0; i < chrome.length; i++) this.setChildVisible(chrome[i], located);

    if (!located) {
      print("[StickyWall] placing — placeholder follows your gaze; tap to place.");
      return; // no notes/headers/buttons while placing
    }

    const rings: Ring[] = ["now", "next", "later"];
    let order = 0;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const tasks = this.store.getByRing(ring);
      const cap = this.colCap[ring];
      const shown = tasks.length < cap ? tasks.length : cap;
      for (let i = 0; i < shown; i++) {
        const t = tasks[i];
        const fresh = !this.seenIds[t.id] && Date.now() - t.createdAt < 4000;
        this.makeNote(ring, t.title, i, order, t.id, t.time || "", fresh);
        this.seenIds[t.id] = true;
        order += 1;
      }
      if (tasks.length > cap) {
        this.makeNote(ring, "+" + (tasks.length - cap) + " more", cap, order, null, "", false);
        order += 1;
      }
    }
    print("[StickyWall] rendered " + this.clones.length + " notes [" + getAnchorState() + "]");
  }

  private makeNote(
    ring: Ring,
    title: string,
    slot: number,
    order: number,
    taskId: string | null,
    time: string,
    fresh: boolean
  ): void {
    const note = this.getSceneObject().copyWholeHierarchy(this.template);
    note.enabled = true;

    const display = time ? title + "\n" + time : title; // show the time on the note
    for (let i = 0; i < note.getChildrenCount(); i++) {
      const ch = note.getChild(i);
      if (ch.name.indexOf("Quad") === 0) {
        const rmv = ch.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (rmv) rmv.mainMaterial = this.matFor(ring);
      } else if (ch.name.indexOf("Label") === 0) {
        const t = ch.getComponent("Component.Text3D") as Text3D;
        if (t) {
          t.text = "";
          t.text = display;
        }
      }
    }
    if (taskId && time) this.reminders.push({ note, id: taskId, time });

    const x = this.colX[ring];
    const y = this.topY - slot * this.stepY;
    const tilt = ((order * 37) % 9) - 4; // deterministic -4..+4 deg
    const tr = note.getTransform();
    tr.setLocalPosition(new vec3(x, y, 1));
    tr.setLocalRotation(quat.angleAxis((tilt * Math.PI) / 180, vec3.forward()));
    tr.setLocalScale(this.startScale);

    // A freshly-dumped task flies in from the mic HUD to this slot — but only when the mic is
    // roaming with you (away from the wall). At the wall the note just appears in place.
    const fly = fresh && this.micHud != null && isMicFollowing();
    if (!fly) {
      this.anims.push({ obj: note, delay: order * this.stagger }); // normal pop-in
    }
    // When flying, the note stays at startScale (invisible) until the fly-in lands and reveals it.
    if (taskId) this.addInteractivity(note, taskId);
    this.clones.push(note);
    if (fly) this.spawnFlyIn(ring, note, note.getTransform().getWorldPosition(), title);
  }

  /** Spawn a colored note copy at the mic HUD that flies to `toWorld`, then reveals the real note. */
  private spawnFlyIn(ring: Ring, target: SceneObject, toWorld: vec3, title: string): void {
    const fly = this.getSceneObject().copyWholeHierarchy(this.template);
    fly.enabled = true;
    fly.name = "FlyIn";
    for (let i = 0; i < fly.getChildrenCount(); i++) {
      const ch = fly.getChild(i);
      if (ch.name.indexOf("Quad") === 0) {
        const rmv = ch.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (rmv) rmv.mainMaterial = this.matFor(ring);
      } else if (ch.name.indexOf("Label") === 0) {
        const t = ch.getComponent("Component.Text3D") as Text3D;
        if (t) {
          t.text = "";
          t.text = title;
        }
      }
    }
    // Spawn a little above the mic so the note is readable in front of you before it flies.
    const from = this.micHud.getTransform().getWorldPosition().add(new vec3(0, 14, 0));
    const ft = fly.getTransform();
    ft.setWorldPosition(from);
    ft.setWorldScale(new vec3(0.01, 0.01, 0.01));
    this.flyingIn.push({ obj: fly, target: target, t: 0, from: from, to: toWorld });
    print("[StickyWall] note flying in from HUD: " + title);
  }

  /**
   * Two-phase fly-in: (1) the note pops in and hovers in front of you for holdDuration,
   * then (2) it eases over to its slot on the board and vanishes.
   */
  private updateFlyIn(dt: number): void {
    for (let i = this.flyingIn.length - 1; i >= 0; i--) {
      const f = this.flyingIn[i];
      f.t += dt;
      const ft = f.obj.getTransform();

      if (f.t < this.holdDuration) {
        // Phase 1: pop in and hover in front of the user.
        let k = f.t / 0.3;
        if (k > 1) k = 1;
        const s = this.easeOutBack(k);
        ft.setWorldPosition(f.from);
        ft.setWorldScale(new vec3(s, s, s));
        continue;
      }

      // Phase 2: glide to the board (perspective shrinks it as it recedes).
      let k = (f.t - this.holdDuration) / this.flyDuration;
      if (k >= 1) {
        f.obj.destroy();
        // Landed — reveal the real note in its slot with a pop.
        if (f.target) this.anims.push({ obj: f.target, delay: this.elapsed });
        this.flyingIn.splice(i, 1);
        continue;
      }
      const eased = k * k * (3 - 2 * k); // smoothstep
      ft.setWorldPosition(vec3.lerp(f.from, f.to, eased));
      ft.setWorldScale(new vec3(1, 1, 1));
    }
  }

  /** Make a note draggable: drop it in a column to re-prioritize, drag off the bottom to complete. */
  private addInteractivity(note: SceneObject, taskId: string): void {
    const collider = note.createComponent("Physics.ColliderComponent") as ColliderComponent;
    const box = Shape.createBoxShape();
    box.size = new vec3(36, 21, 2);
    collider.shape = box;

    note.createComponent(Interactable.getTypeName());
    const manip = note.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation;
    manip.onTranslationStart.add(() => this.onNoteGrabbed(note));
    manip.onTranslationEnd.add(() => this.onNoteReleased(note, taskId));
  }

  private onNoteGrabbed(note: SceneObject): void {
    this.grabNote = note;
    this.grabPrevWorld = note.getTransform().getWorldPosition();
    this.grabVel = vec3.zero();
  }

  private onNoteReleased(note: SceneObject, taskId: string): void {
    const wasTracked = this.grabNote === note;
    const releaseVel = this.grabVel;
    const speed = releaseVel.length;
    this.grabNote = null;

    const pos = note.getTransform().getLocalPosition();
    const thrown = wasTracked && speed > this.throwSpeed;
    const draggedOff = pos.y < this.peelY;

    if (thrown || draggedOff) {
      // Crumple into a paper ball, drop it, and delete the task.
      this.trashNote(note, taskId, thrown ? releaseVel : null);
      return;
    }

    // Otherwise: snap to the nearest column and re-prioritize to that ring.
    const cols: Ring[] = ["now", "next", "later"];
    let best: Ring = "now";
    let bestDist = 1e9;
    for (let i = 0; i < cols.length; i++) {
      const d = Math.abs(pos.x - this.colX[cols[i]]);
      if (d < bestDist) {
        bestDist = d;
        best = cols[i];
      }
    }
    print("[StickyWall] dropped in " + best + " -> promote " + taskId);
    this.store.promote(taskId, best);
  }

  /**
   * Turn a note into a physics-simulated crumpled paper ball at its current world pose,
   * launch it (flung with the release velocity, or a soft downward toss for a drag-off),
   * then remove the task from the board. The ball self-destructs after it lands and fades.
   */
  private trashNote(note: SceneObject, taskId: string, throwVel: vec3 | null): void {
    if (!this.paperBall) {
      print("[StickyWall] paperBall prefab not wired — completing without crumple.");
      this.store.complete(taskId);
      return;
    }

    const nt = note.getTransform();
    const worldPos = nt.getWorldPosition();
    const worldRot = nt.getWorldRotation();
    const ringColor = this.ringColorOf(note); // read before the note is destroyed

    this.ensureTrashInfra(worldPos);

    const ball = this.paperBall.instantiate(this.trashRoot);
    ball.name = "CrumpledNote";
    const bt = ball.getTransform();
    bt.setWorldPosition(worldPos);
    bt.setWorldRotation(worldRot);
    bt.setWorldScale(new vec3(this.ballScaleCm, this.ballScaleCm, this.ballScaleCm));
    this.tintBall(ball, ringColor); // crumpled wad matches the note's colour

    const body = ball.createComponent("Physics.BodyComponent") as BodyComponent;
    body.dynamic = true;
    body.shape = Shape.createSphereShape();
    body.mass = 0.02; // light paper
    body.damping = 0.05;
    body.angularDamping = 0.1;

    // Launch: honor the throw, or give a drag-off a gentle downward/outward toss.
    let v: vec3;
    if (throwVel) {
      v = throwVel;
      const sp = v.length;
      const maxSp = 250; // clamp so a hard fling doesn't rocket out of the room
      if (sp > maxSp) v = v.uniformScale(maxSp / sp);
    } else {
      v = new vec3((Math.random() - 0.5) * 30, -40, -30);
    }
    body.velocity = v;
    body.angularVelocity = new vec3(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12
    ); // tumble

    this.falling.push({ obj: ball, body: body, life: 0, frozen: false });
    print("[StickyWall] crumpled + tossed note -> delete " + taskId);

    // Free the slot immediately; the ball lives on independently under the trash root.
    this.store.complete(taskId);
  }

  /** The note's ring colour, read from its "Quad" backing material. */
  private ringColorOf(note: SceneObject): vec4 {
    for (let i = 0; i < note.getChildrenCount(); i++) {
      const ch = note.getChild(i);
      if (ch.name.indexOf("Quad") === 0) {
        const rmv = ch.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (rmv && rmv.mainMaterial) return rmv.mainMaterial.mainPass.baseColor;
      }
    }
    return new vec4(1, 1, 1, 1);
  }

  /** Tint a crumpled ball to a colour, cloning its material so concurrent balls stay independent. */
  private tintBall(ball: SceneObject, color: vec4): void {
    const rmv = this.findRenderMesh(ball);
    if (!rmv || !rmv.mainMaterial) return;
    const mat = rmv.mainMaterial.clone();
    // The paper prefab is a GLTF PBR material: colour is baseColorFactor, and its
    // metallicFactor defaults to 1 (which renders flat grey). Tint + de-metal it.
    const pass = mat.mainPass as any;
    pass.baseColorFactor = new vec4(color.x, color.y, color.z, 1);
    pass.metallicFactor = 0;
    rmv.mainMaterial = mat;
  }

  /** First RenderMeshVisual found anywhere in a hierarchy (the ball prefab may nest its mesh). */
  private findRenderMesh(obj: SceneObject): RenderMeshVisual | null {
    const r = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (r) return r;
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      const found = this.findRenderMesh(obj.getChild(i));
      if (found) return found;
    }
    return null;
  }

  /** Lazily create the world-space trash root and an invisible floor under the board. */
  private ensureTrashInfra(nearWorld: vec3): void {
    if (!this.trashRoot) {
      this.trashRoot = global.scene.createSceneObject("BrainDumpd_TrashRoot");
    }
    if (!this.floor) {
      this.floor = global.scene.createSceneObject("BrainDumpd_Floor");
      const col = this.floor.createComponent("Physics.ColliderComponent") as ColliderComponent;
      const box = Shape.createBoxShape();
      box.size = new vec3(600, 10, 600); // wide, thin slab
      col.shape = box;
    }
    // Keep the floor beneath the board and horizontal in world space.
    const ft = this.floor.getTransform();
    ft.setWorldPosition(new vec3(nearWorld.x, nearWorld.y - this.floorDropCm, nearWorld.z));
    ft.setWorldRotation(quat.quatIdentity());
  }

  private matFor(ring: Ring): Material {
    if (ring === "now") return this.matNow;
    if (ring === "next") return this.matNext;
    return this.matLater;
  }

  private animate(): void {
    const dt = getDeltaTime();
    this.elapsed += dt;
    for (let i = 0; i < this.anims.length; i++) {
      const a = this.anims[i];
      let t = (this.elapsed - a.delay) / this.popDuration;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      const eased = this.easeOutBack(t);
      a.obj.getTransform().setLocalScale(vec3.lerp(this.startScale, this.fullScale, eased));
    }
    this.trackGrabVelocity(dt);
    this.updateFalling(dt);
    this.checkReminders();
    this.updatePulses(dt);
    this.updateFlyIn(dt);
  }

  /** Fire a one-time chime + bounce when a timed task reaches its clock time (Lens open only). */
  private checkReminders(): void {
    if (this.reminders.length === 0) return;
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();
    for (let i = 0; i < this.reminders.length; i++) {
      const r = this.reminders[i];
      const key = r.id + "@" + r.time;
      if (this.firedReminders[key]) continue;
      const parts = r.time.split(":");
      const dueMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      const delta = curMin - dueMin;
      // Fire when the due minute arrives (with a 5-min grace so a slightly late glance
      // still pings), but never for times that were already long past on load.
      if (delta >= 0 && delta <= 5) {
        this.firedReminders[key] = true;
        this.pulses.push({ note: r.note, t: 0 });
        // Loop the chime for the whole alarm; updatePulses stops it when the bounce ends.
        if (this.audio) this.audio.play(-1);
        print("[StickyWall] reminder due (" + r.time + ") for " + r.id);
      }
    }
  }

  /** Advance active reminder alarms; runs after the pop loop so it wins on the pulsing note. */
  private updatePulses(dt: number): void {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt;
      // A sustained attention bounce for the whole alarm window, easing off in the last second.
      let fade = 1;
      if (p.t > this.alarmDuration - 1) fade = Math.max(0, this.alarmDuration - p.t);
      const amp = 0.22 * Math.sin(p.t * 8) * fade;
      const s = 1 + amp;
      p.note
        .getTransform()
        .setLocalScale(new vec3(this.fullScale.x * s, this.fullScale.y * s, this.fullScale.z));
      if (p.t >= this.alarmDuration) {
        p.note.getTransform().setLocalScale(this.fullScale);
        this.pulses.splice(i, 1);
        if (this.audio && this.pulses.length === 0) this.audio.stop(true); // last alarm done (fade out)
      }
    }
  }

  /** Sample the grabbed note's world position to estimate a release velocity (cm/s). */
  private trackGrabVelocity(dt: number): void {
    if (!this.grabNote || dt <= 0) return;
    const now = this.grabNote.getTransform().getWorldPosition();
    const inst = now.sub(this.grabPrevWorld).uniformScale(1 / dt);
    this.grabVel = vec3.lerp(this.grabVel, inst, 0.5); // smooth out jitter
    this.grabPrevWorld = now;
  }

  /** Advance crumpled balls: let physics run, then freeze + shrink out and destroy. */
  private updateFalling(dt: number): void {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.life += dt;

      if (!f.frozen && f.life >= this.ballLife - this.shrinkWindow) {
        f.body.dynamic = false; // stop the sim before the shrink-out so scale doesn't fight it
        f.frozen = true;
      }
      if (f.frozen) {
        let k = (this.ballLife - f.life) / this.shrinkWindow;
        if (k < 0) k = 0;
        const s = this.ballScaleCm * k;
        f.obj.getTransform().setWorldScale(new vec3(s, s, s));
      }
      if (f.life >= this.ballLife) {
        f.obj.destroy();
        this.falling.splice(i, 1);
      }
    }
  }

  private easeOutBack(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
}
