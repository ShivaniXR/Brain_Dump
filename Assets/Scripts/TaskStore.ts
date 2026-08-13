/**
 * Brain Dumpd — TaskStore: the single source of truth for placed tasks, with
 * cross-session persistence.
 *
 * A thin stateful wrapper over the pure RingCapacity engine. It holds the active
 * board (and a separate list of completed tasks so done tasks never count toward
 * capacity) and delegates every placement decision:
 *   - add / addAll  -> RingCapacity.placeParsedBatch (fresh parse: overflow outward,
 *                      LLM order preserved, existing tasks never displaced)
 *   - promote       -> RingCapacity.promote (displace the longest-sitting occupant
 *                      outward, cascading Now -> Next -> Later)
 *
 * Persistence: every mutation serializes the full board (active + completed, including
 * each task's ring, enteredAt, and completion state) to a KeyValueStore under one key.
 * A new TaskStore auto-loads that snapshot on construction, so a fresh session restores
 * the previous board identically — including per-ring ordering.
 */
import { PlacedTask, Ring, restorePlacedTask } from "./TaskTypes";
import { placeParsedBatch, promote as ringPromote, countOn as ringCountOn } from "./RingCapacity";

/** Minimal persistence surface. Lens `global.persistentStorageSystem.store` satisfies it. */
export interface KeyValueStore {
  getString(key: string): string;
  putString(key: string, value: string): void;
  has(key: string): boolean;
  remove(key: string): void;
}

const STORAGE_VERSION = 1;
const DEFAULT_STORAGE_KEY = "brainDumpd.tasks.v1";

interface PersistState {
  version: number;
  active: PlacedTask[];
  completed: PlacedTask[];
}

export class TaskStore {
  private active: PlacedTask[] = [];
  private completed: PlacedTask[] = [];
  private store: KeyValueStore | null;
  private storageKey: string;
  private listeners: (() => void)[] = [];

  /** Subscribe to board changes (fired after any mutation persists). */
  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private notify(): void {
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i]();
  }

  /** Persist + notify. Called by every mutation. */
  private commitChange(): void {
    this.persist();
    this.notify();
  }

  /**
   * @param store  where to persist. `undefined` (default) uses the Lens persistent
   *               store; pass a fake for tests, or `null` to disable persistence.
   * @param storageKey  the key under which the board is stored.
   */
  constructor(store?: KeyValueStore | null, storageKey: string = DEFAULT_STORAGE_KEY) {
    this.store = store === undefined ? global.persistentStorageSystem.store : store;
    this.storageKey = storageKey;
    this.load();
  }

  // --- queries -------------------------------------------------------------

  getAll(): PlacedTask[] {
    return this.active.slice();
  }

  getByRing(ring: Ring): PlacedTask[] {
    return this.active.filter((t) => t.ring === ring);
  }

  countOn(ring: Ring): number {
    return ringCountOn(this.active, ring);
  }

  getCompleted(): PlacedTask[] {
    return this.completed.slice();
  }

  /**
   * A multi-line, ring-grouped dump of the board for logging/testing. Within each ring
   * tasks are sorted by enteredAt (longest-sitting first), showing title, category,
   * original urgency, and the enteredAt stamp.
   */
  describe(): string {
    const rings: Ring[] = ["now", "next", "later"];
    const lines: string[] = ["[Board] ===== tasks ====="];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const tasks = this.getByRing(ring).sort((a, b) => a.enteredAt - b.enteredAt);
      lines.push("[Board] " + ring.toUpperCase() + " (" + tasks.length + "):");
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        lines.push(
          "[Board]   " +
            (i + 1) +
            ". " +
            t.title +
            "  <cat:" +
            t.category +
            " urg:" +
            t.urgency +
            " @" +
            t.enteredAt +
            ">"
        );
      }
    }
    lines.push("[Board] completed: " + this.completed.length);
    return lines.join("\n");
  }

  // --- mutations (each persists) -------------------------------------------

  private normalizeTitle(title: string): string {
    return title.trim().toLowerCase();
  }

  /** Drop tasks whose title already exists on the active board, and de-dup within the batch. */
  private dedup(tasks: PlacedTask[]): PlacedTask[] {
    const seen: { [key: string]: boolean } = {};
    for (let i = 0; i < this.active.length; i++) seen[this.normalizeTitle(this.active[i].title)] = true;
    const fresh: PlacedTask[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const key = this.normalizeTitle(tasks[i].title);
      if (seen[key]) continue; // duplicate of a board task or an earlier task in this batch
      seen[key] = true;
      fresh.push(tasks[i]);
    }
    return fresh;
  }

  /** Fresh-parse placement of one task: overflow outward, no displacement. Skips duplicates. */
  add(task: PlacedTask): void {
    const fresh = this.dedup([task]);
    if (fresh.length === 0) return; // already on the board
    this.active = placeParsedBatch(this.active, fresh);
    this.commitChange();
  }

  /** Fresh-parse placement of a batch, preserving LLM order. Skips duplicate titles. */
  addAll(tasks: PlacedTask[]): void {
    const fresh = this.dedup(tasks);
    if (fresh.length === 0) return; // nothing new to add
    this.active = placeParsedBatch(this.active, fresh);
    this.commitChange();
  }

  /**
   * Promote an active task into `toRing`, displacing the longest-sitting occupant
   * outward (cascading) if the ring is full.
   */
  promote(id: string, toRing: Ring): void {
    this.active = ringPromote(this.active, id, toRing);
    this.commitChange();
  }

  /** Mark a task done and remove it from the board. Never auto-promotes (locked: manual). */
  complete(id: string): void {
    const t = this.active.filter((x) => x.id === id)[0];
    if (!t) return;
    t.status = "done";
    t.completedAt = Date.now();
    this.active = this.active.filter((x) => x.id !== id);
    this.completed = this.completed.concat([t]);
    this.commitChange();
  }

  clear(): void {
    this.active = [];
    this.completed = [];
    this.commitChange();
  }

  // --- persistence ---------------------------------------------------------

  /** Serialize the full board (active + completed) to the backing store. */
  private persist(): void {
    if (!this.store) return;
    const state: PersistState = {
      version: STORAGE_VERSION,
      active: this.active,
      completed: this.completed,
    };
    this.store.putString(this.storageKey, JSON.stringify(state));
  }

  /**
   * Reload the board from the backing store, replacing in-memory state. Never throws;
   * a missing/corrupt snapshot leaves the store empty. Array order (hence per-ring
   * ordering) is preserved exactly as it was saved.
   */
  load(): void {
    if (!this.store || !this.store.has(this.storageKey)) return;
    const raw = this.store.getString(this.storageKey);
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return; // corrupt snapshot -> stay empty
    }
    const state = parsed as Partial<PersistState>;
    this.active = this.restoreList(state.active);
    this.completed = this.restoreList(state.completed);
  }

  private restoreList(rawList: unknown): PlacedTask[] {
    if (!Array.isArray(rawList)) return [];
    const out: PlacedTask[] = [];
    for (let i = 0; i < rawList.length; i++) {
      const t = restorePlacedTask(rawList[i]);
      if (t) out.push(t);
    }
    return out;
  }
}
