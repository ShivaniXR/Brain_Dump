/**
 * Brain Dumpd — ring capacity logic (PURE: no Lens/RSG dependencies).
 *
 * Two placement mechanisms, matching the product rules:
 *
 *  1. PROMOTION (a single task moved inward into a possibly-full ring):
 *     if the target ring is full, the task that has been sitting there LONGEST
 *     is displaced outward one ring. This cascades — displacing from Now into a
 *     full Next displaces Next's longest-sitting task into Later. Later is uncapped.
 *
 *  2. FRESH PARSE (a batch of newly parsed tasks placed by urgency):
 *     tasks fill their urgency ring in LLM order; any that don't fit overflow
 *     outward. Existing tasks are never displaced by a fresh parse. So 6 tasks
 *     marked "now" onto an empty board keep the first 3 in Now and put the rest
 *     in Next.
 *
 * "Longest-sitting" is defined by `enteredAt`: a monotonic sequence stamped when a
 * task enters its CURRENT ring (lower = older). A displaced task gets a fresh (higher)
 * stamp, so it becomes the newest occupant of the ring it lands in.
 *
 * Functions are generic over any item shaped like `RingItem`, and preserve the item's
 * other fields (e.g. category, status) via spread. They are pure: they take an item
 * array and return a new array, never mutating the input.
 */
import { type Ring, type Urgency } from "./TaskTypes";

/** Minimal shape the capacity engine needs. PlacedTask and BoardTask both satisfy it. */
export interface RingItem {
  id: string;
  urgency: Urgency; // original inferred urgency (used to pick the starting ring)
  ring: Ring; // current placement (overwritten on placement)
  enteredAt: number; // monotonic seq: when it entered its CURRENT ring (lower = longer sitting)
}

/** A concrete RingItem used by tests / standalone callers. */
export interface BoardTask extends RingItem {
  title: string;
}
export type Board = BoardTask[];

export const RING_CAPACITY: Record<Ring, number> = {
  now: 3,
  next: 8,
  later: Infinity,
};

/** The ring one step outward, or null for the outermost (later). */
export function outwardRing(ring: Ring): Ring | null {
  if (ring === "now") return "next";
  if (ring === "next") return "later";
  return null;
}

export function tasksOn<T extends RingItem>(board: T[], ring: Ring): T[] {
  return board.filter((t) => t.ring === ring);
}

export function countOn(board: RingItem[], ring: Ring): number {
  let n = 0;
  for (let i = 0; i < board.length; i++) if (board[i].ring === ring) n += 1;
  return n;
}

export function isFull(board: RingItem[], ring: Ring): boolean {
  return countOn(board, ring) >= RING_CAPACITY[ring];
}

/** The longest-sitting task on a ring (smallest enteredAt), or null if empty. */
export function longestSittingOn<T extends RingItem>(board: T[], ring: Ring): T | null {
  let oldest: T | null = null;
  for (let i = 0; i < board.length; i++) {
    const t = board[i];
    if (t.ring === ring && (oldest === null || t.enteredAt < oldest.enteredAt)) oldest = t;
  }
  return oldest;
}

/** Sequence generator seeded above the board's current max stamp. Local => pure. */
function makeSeqGen(board: RingItem[]): () => number {
  let n = 0;
  for (let i = 0; i < board.length; i++) if (board[i].enteredAt > n) n = board[i].enteredAt;
  return () => {
    n += 1;
    return n;
  };
}

/**
 * Place `task` onto `ring` with displacement + cascade. If the ring is full, its
 * longest-sitting task is recursively re-placed one ring outward FIRST, then `task`
 * lands with a fresh stamp. Returns a new array; extra fields on `task` are preserved.
 */
function placeWithDisplacement<T extends RingItem>(
  board: T[],
  task: T,
  ring: Ring,
  nextSeq: () => number
): T[] {
  let working = board;
  if (isFull(working, ring)) {
    const victim = longestSittingOn(working, ring);
    const outward = outwardRing(ring);
    // later is uncapped, so a full ring always has an outward target and a victim.
    if (victim && outward) {
      working = working.filter((t) => t.id !== victim.id);
      working = placeWithDisplacement(working, victim, outward, nextSeq);
    }
  }
  const placed = { ...task, ring: ring, enteredAt: nextSeq() } as T;
  return working.concat([placed]);
}

/**
 * Promote an existing task (by id) into `toRing`, displacing the longest-sitting
 * occupant outward if the ring is full (cascading as needed).
 */
export function promote<T extends RingItem>(board: T[], taskId: string, toRing: Ring): T[] {
  const task = board.filter((t) => t.id === taskId)[0];
  if (!task) return board.slice();
  const without = board.filter((t) => t.id !== taskId);
  return placeWithDisplacement(without, task, toRing, makeSeqGen(board));
}

/**
 * Insert an item onto `ring` with displacement + cascade (the promotion mechanism
 * for an item not yet on the board). The item's `ring`/`enteredAt` are overwritten.
 */
export function insertWithDisplacement<T extends RingItem>(board: T[], item: T, ring: Ring): T[] {
  return placeWithDisplacement(board, item, ring, makeSeqGen(board));
}

/**
 * Place a fresh parse batch by urgency, overflowing outward when a ring is full.
 * LLM order is preserved (so early tasks win scarce inner slots), and existing tasks
 * are never displaced. Each item's `ring`/`enteredAt` are (re)assigned.
 */
export function placeParsedBatch<T extends RingItem>(board: T[], items: T[]): T[] {
  let working = board.slice();
  const nextSeq = makeSeqGen(board);
  for (let i = 0; i < items.length; i++) {
    let ring: Ring = items[i].urgency;
    let out = outwardRing(ring);
    while (out !== null && isFull(working, ring)) {
      ring = out;
      out = outwardRing(ring);
    }
    working = working.concat([{ ...items[i], ring: ring, enteredAt: nextSeq() } as T]);
  }
  return working;
}
