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

  private readonly colX: { [k: string]: number } = { now: -42, next: 0, later: 42 };
  private readonly colCap: { [k: string]: number } = { now: 3, next: 5, later: 5 };
  private readonly topY = 24;
  private readonly stepY = 20;
  private readonly peelY = -55; // dragged below this = peeled off = complete

  private store: TaskStore;
  private clones: SceneObject[] = [];
  private anims: { obj: SceneObject; delay: number }[] = [];
  private elapsed = 0;
  private startScale = new vec3(0.02, 0.02, 0.02);
  private fullScale = new vec3(1, 1, 1);

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
    this.createEvent("UpdateEvent").bind(() => this.animate());
  }

  private setup(): void {
    if (this.template) this.template.enabled = false;
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

  private setHeaderVisible(name: string, visible: boolean): void {
    const root = this.getSceneObject();
    for (let i = 0; i < root.getChildrenCount(); i++) {
      if (root.getChild(i).name === name) root.getChild(i).enabled = visible;
    }
  }

  private render(): void {
    for (let i = 0; i < this.clones.length; i++) this.clones[i].destroy();
    this.clones = [];
    this.anims = [];
    this.elapsed = 0;
    if (!this.template) {
      print("[StickyWall] no template assigned.");
      return;
    }

    const located = getAnchorState() !== "unlocated";
    this.setHeaderVisible("H_next", located);
    this.setHeaderVisible("H_later", located);

    const rings: Ring[] = located ? ["now", "next", "later"] : ["now"];
    let order = 0;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const tasks = this.store.getByRing(ring);
      const cap = this.colCap[ring];
      const shown = tasks.length < cap ? tasks.length : cap;
      for (let i = 0; i < shown; i++) {
        this.makeNote(ring, tasks[i].title, i, order, tasks[i].id);
        order += 1;
      }
      if (tasks.length > cap) {
        this.makeNote(ring, "+" + (tasks.length - cap) + " more", cap, order, null);
        order += 1;
      }
    }
    print("[StickyWall] rendered " + this.clones.length + " notes [" + getAnchorState() + "]");
  }

  private makeNote(ring: Ring, title: string, slot: number, order: number, taskId: string | null): void {
    const note = this.getSceneObject().copyWholeHierarchy(this.template);
    note.enabled = true;

    for (let i = 0; i < note.getChildrenCount(); i++) {
      const ch = note.getChild(i);
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

    const x = this.colX[ring];
    const y = this.topY - slot * this.stepY;
    const tilt = ((order * 37) % 9) - 4; // deterministic -4..+4 deg
    const tr = note.getTransform();
    tr.setLocalPosition(new vec3(x, y, 1));
    tr.setLocalRotation(quat.angleAxis((tilt * Math.PI) / 180, vec3.forward()));
    tr.setLocalScale(this.startScale);

    this.anims.push({ obj: note, delay: order * this.stagger });
    if (taskId) this.addInteractivity(note, taskId);
    this.clones.push(note);
  }

  /** Make a note draggable: drop it in a column to re-prioritize, drag off the bottom to complete. */
  private addInteractivity(note: SceneObject, taskId: string): void {
    const collider = note.createComponent("Physics.ColliderComponent") as ColliderComponent;
    const box = Shape.createBoxShape();
    box.size = new vec3(26, 16, 2);
    collider.shape = box;

    note.createComponent(Interactable.getTypeName());
    const manip = note.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation;
    manip.onTranslationEnd.add(() => this.onNoteReleased(note, taskId));
  }

  private onNoteReleased(note: SceneObject, taskId: string): void {
    const pos = note.getTransform().getLocalPosition();
    if (pos.y < this.peelY) {
      print("[StickyWall] peel -> complete " + taskId);
      this.store.complete(taskId); // re-render snaps the wall back
      return;
    }
    // Snap to the nearest column and re-prioritize to that ring.
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

  private matFor(ring: Ring): Material {
    if (ring === "now") return this.matNow;
    if (ring === "next") return this.matNext;
    return this.matLater;
  }

  private animate(): void {
    this.elapsed += getDeltaTime();
    for (let i = 0; i < this.anims.length; i++) {
      const a = this.anims[i];
      let t = (this.elapsed - a.delay) / this.popDuration;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      const eased = this.easeOutBack(t);
      a.obj.getTransform().setLocalScale(vec3.lerp(this.startScale, this.fullScale, eased));
    }
  }

  private easeOutBack(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
}
