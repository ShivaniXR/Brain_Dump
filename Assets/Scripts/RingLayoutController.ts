/**
 * Brain Dumpd — RingLayoutController (presentation).
 *
 * Renders cards data-driven from a TaskStore: for each active task it binds a pooled
 * card (under "CardPool"), sets its text, positions it at a slot on the task's ring,
 * and flies it in (staggered, eased) from a spawn point in front of the user.
 *
 * This iteration seeds an in-memory sample brain dump so it's demoable in the editor.
 * Next steps replace the seed with the live TaskStore fed by voice/LLM, and branch the
 * layout on anchor state (same-room fly-to-wall vs new-room floating Now stack).
 *
 * Attach to the target root (BrainDumpd_Target); pooled cards live under its "CardPool" child.
 */
import { TaskStore } from "./TaskStore";
import { getTaskStore } from "./TaskStoreProvider";
import { getAnchorState, onAnchorStateChange } from "./AnchorStateProvider";
import { Ring } from "./TaskTypes";

@component
export class RingLayoutController extends BaseScriptComponent {
  @input
  @hint("Seconds each card takes to fly from the spawn point to its ring slot.")
  flyDuration: number = 0.7;

  @input
  @hint("Delay between successive cards starting their fly-in.")
  stagger: number = 0.12;

  // Spawn point (target-local): in front of the user, slightly low.
  private spawnLocal: vec3 = new vec3(0, -18, 70);
  // Ring radii (cm) and card plane depth, from the authored geometry.
  private readonly SLOT_Z = 14;
  private readonly NEXT_R = 9;
  private readonly LATER_R = 15;

  private store: TaskStore;
  private pool: SceneObject[] = [];
  private ringMeshes: SceneObject[] = []; // NowRing / NextRing / LaterRing
  private anims: { obj: SceneObject; from: vec3; to: vec3; delay: number }[] = [];
  private elapsed = 0;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
    this.createEvent("UpdateEvent").bind(() => this.animate());
  }

  private setup(): void {
    this.collectChildren();
    this.store = getTaskStore(); // shared, persistent store (also written by BrainDumpController)
    this.store.onChange(() => this.render()); // re-render whenever a voice dump adds tasks
    onAnchorStateChange(() => this.render()); // re-render when anchoring goes located <-> unlocated
    this.render(); // initial render of any persisted tasks
  }

  private collectChildren(): void {
    const root = this.getSceneObject();
    let cardPool: SceneObject | null = null;
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const ch = root.getChild(i);
      if (ch.name === "CardPool") cardPool = ch;
      else if (ch.name === "NowRing" || ch.name === "NextRing" || ch.name === "LaterRing") {
        this.ringMeshes.push(ch);
      }
    }
    if (!cardPool) {
      print("[BrainDumpd] RingLayoutController: CardPool not found.");
      return;
    }
    for (let i = 0; i < cardPool.getChildrenCount(); i++) {
      const card = cardPool.getChild(i);
      card.enabled = false;
      this.pool.push(card);
    }
  }

  private render(): void {
    // Reset the pool + animation so re-renders (after a new voice dump) rebind cleanly.
    for (let i = 0; i < this.pool.length; i++) this.pool[i].enabled = false;
    this.anims = [];
    this.elapsed = 0;

    // Anchor branch: located (same room) shows the wall rings + all cards; unlocated
    // (new room) hides the rings and shows only Now cards floating in front of the user.
    const located = getAnchorState() !== "unlocated";
    for (let i = 0; i < this.ringMeshes.length; i++) this.ringMeshes[i].enabled = located;

    let poolIdx = 0;
    const rings: Ring[] = located ? ["now", "next", "later"] : ["now"];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const tasks = this.store.getByRing(ring);
      for (let i = 0; i < tasks.length; i++) {
        if (poolIdx >= this.pool.length) break; // pool exhausted (cap on visible cards)
        const card = this.pool[poolIdx];
        poolIdx += 1;

        const text3d = card.getComponent("Component.Text3D") as Text3D;
        if (text3d) text3d.text = tasks[i].title;
        card.enabled = true;

        const slot = this.slotFor(ring, i, tasks.length, located);
        card.getTransform().setLocalPosition(this.spawnLocal);
        this.anims.push({
          obj: card,
          from: new vec3(this.spawnLocal.x, this.spawnLocal.y, this.spawnLocal.z),
          to: slot,
          delay: this.anims.length * this.stagger,
        });
      }
    }
    print(
      "[BrainDumpd] RingLayoutController: rendered " +
        this.anims.length +
        " cards [" +
        getAnchorState() +
        "] (now=" +
        this.store.countOn("now") +
        " next=" +
        this.store.countOn("next") +
        " later=" +
        this.store.countOn("later") +
        ")"
    );
  }

  /**
   * Local-space slot for the i-th card on a ring.
   *  - located: Now = vertical stack at centre; Next/Later = around their ring.
   *  - unlocated: Now = a vertical stack floating in front of the user (portable HUD).
   */
  private slotFor(ring: Ring, i: number, count: number, located: boolean): vec3 {
    if (!located) {
      // Floating Now stack in front of the user (larger +Z = toward camera).
      const mid = (count - 1) / 2;
      return new vec3(0, (mid - i) * 4.2, 62);
    }
    if (ring === "now") {
      const mid = (count - 1) / 2;
      return new vec3(0, (mid - i) * 3.4, this.SLOT_Z);
    }
    const radius = ring === "next" ? this.NEXT_R : this.LATER_R;
    const slots = ring === "next" ? 8 : 6;
    const theta = ((90 - (360 / slots) * i) * Math.PI) / 180; // start at top, go clockwise
    return new vec3(radius * Math.cos(theta), radius * Math.sin(theta), this.SLOT_Z);
  }

  private animate(): void {
    this.elapsed += getDeltaTime();
    for (let i = 0; i < this.anims.length; i++) {
      const c = this.anims[i];
      let t = (this.elapsed - c.delay) / this.flyDuration;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      const eased = 1 - Math.pow(1 - t, 3);
      c.obj.getTransform().setLocalPosition(vec3.lerp(c.from, c.to, eased));
    }
  }
}
