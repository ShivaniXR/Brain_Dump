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
import { Task, PlacedTask, Ring, makePlacedTask } from "./TaskTypes";

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
  private anims: { obj: SceneObject; from: vec3; to: vec3; delay: number }[] = [];
  private elapsed = 0;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
    this.createEvent("UpdateEvent").bind(() => this.animate());
  }

  private setup(): void {
    this.collectPool();
    this.store = new TaskStore(null); // in-memory demo store (no persistence side effects)
    if (this.store.getAll().length === 0) this.seedSample();
    this.render();
  }

  private collectPool(): void {
    const root = this.getSceneObject();
    let cardPool: SceneObject | null = null;
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const ch = root.getChild(i);
      if (ch.name === "CardPool") {
        cardPool = ch;
        break;
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

  private seedSample(): void {
    // 4 "now" (one overflows to Next), 2 "next", 1 "later" — exercises overflow + spread.
    const sample: Task[] = [
      { title: "Attend important meeting", urgency: "now", category: "work" },
      { title: "Call the plumber urgently", urgency: "now", category: "home" },
      { title: "Finish the tax forms", urgency: "now", category: "home" },
      { title: "Prepare demo slides", urgency: "now", category: "work" },
      { title: "Get a haircut", urgency: "next", category: "errand" },
      { title: "Submit hackathon project", urgency: "next", category: "work" },
      { title: "Apply for residency program", urgency: "later", category: "work" },
    ];
    const tasks: PlacedTask[] = sample.map((t) => makePlacedTask(t));
    this.store.addAll(tasks);
  }

  private render(): void {
    this.anims = [];
    let poolIdx = 0;
    const rings: Ring[] = ["now", "next", "later"];
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

        const slot = this.slotFor(ring, i, tasks.length);
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
        " data-driven cards (now=" +
        this.store.countOn("now") +
        " next=" +
        this.store.countOn("next") +
        " later=" +
        this.store.countOn("later") +
        ")"
    );
  }

  /** Local-space slot for the i-th card on a ring. Now = vertical stack; Next/Later = around the ring. */
  private slotFor(ring: Ring, i: number, count: number): vec3 {
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
