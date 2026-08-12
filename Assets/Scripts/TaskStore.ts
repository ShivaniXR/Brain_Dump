/**
 * Brain Dumpd — TaskStore: the single source of truth for placed tasks.
 *
 * A thin stateful wrapper over the pure RingCapacity engine. It holds the active
 * board (and a separate list of completed tasks so done tasks never count toward
 * capacity) and delegates every placement decision:
 *   - add / addAll  -> RingCapacity.placeParsedBatch (fresh parse: overflow outward,
 *                      LLM order preserved, existing tasks never displaced)
 *   - promote       -> RingCapacity.promote (displace the longest-sitting occupant
 *                      outward, cascading Now -> Next -> Later)
 *
 * Completion is manual (locked decision): completing a task frees its slot but never
 * auto-promotes another task inward.
 */
import { PlacedTask, Ring } from "./TaskTypes";
import { placeParsedBatch, promote as ringPromote, countOn as ringCountOn } from "./RingCapacity";

export class TaskStore {
  private active: PlacedTask[] = [];
  private completed: PlacedTask[] = [];

  /** All active tasks (board order). */
  getAll(): PlacedTask[] {
    return this.active.slice();
  }

  /** Active tasks currently on a given ring. */
  getByRing(ring: Ring): PlacedTask[] {
    return this.active.filter((t) => t.ring === ring);
  }

  /** How many active tasks sit on a ring right now. */
  countOn(ring: Ring): number {
    return ringCountOn(this.active, ring);
  }

  /** Fresh-parse placement of one task: overflow outward, no displacement. */
  add(task: PlacedTask): void {
    this.active = placeParsedBatch(this.active, [task]);
  }

  /** Fresh-parse placement of a batch, preserving LLM order. */
  addAll(tasks: PlacedTask[]): void {
    this.active = placeParsedBatch(this.active, tasks);
  }

  /**
   * Promote an active task into `toRing`, displacing the longest-sitting occupant
   * outward (cascading) if the ring is full.
   */
  promote(id: string, toRing: Ring): void {
    this.active = ringPromote(this.active, id, toRing);
  }

  /** Mark a task done and remove it from the board. Never auto-promotes (locked: manual). */
  complete(id: string): void {
    const t = this.active.filter((x) => x.id === id)[0];
    if (!t) return;
    t.status = "done";
    t.completedAt = Date.now();
    this.active = this.active.filter((x) => x.id !== id);
    this.completed = this.completed.concat([t]);
  }

  getCompleted(): PlacedTask[] {
    return this.completed.slice();
  }

  clear(): void {
    this.active = [];
    this.completed = [];
  }
}
