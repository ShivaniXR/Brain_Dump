/**
 * Brain Dumpd — Task data model + parsing/validation.
 *
 * Data layer only. No scene/visual dependencies here so this stays unit-reasonable
 * and reusable by any provider implementation of the LLM service.
 */

export type Urgency = "now" | "next" | "later";
export type Category = "work" | "home" | "errand";

export const URGENCIES: Urgency[] = ["now", "next", "later"];
export const CATEGORIES: Category[] = ["work", "home", "errand"];

/** A single parsed task as produced by the LLM. */
export interface Task {
  title: string; // imperative, max 6 words
  urgency: Urgency;
  category: Category;
  time?: string; // optional "HH:MM" (24h) if the person mentioned a specific time
}

/** True if `v` is a valid "HH:MM" 24-hour time string. */
export function isTimeString(v: unknown): v is string {
  return typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v);
}

/** A ring on the target. Same value set as Urgency, but a distinct concept:
 *  urgency is what the LLM inferred; ring is where the task actually landed. */
export type Ring = Urgency;

/** A task once it has been placed on the target by the TaskStore.
 *  Shaped to satisfy RingCapacity's RingItem (id, urgency, ring, enteredAt). */
export interface PlacedTask extends Task {
  id: string;
  ring: Ring; // may differ from urgency after overflow/displacement
  status: "active" | "done";
  enteredAt: number; // monotonic stamp for when it entered its current ring (set by TaskStore)
  createdAt: number;
  completedAt?: number;
}

export function isRing(v: unknown): v is Ring {
  return isUrgency(v);
}

/**
 * Rebuild a PlacedTask from untrusted (persisted/JSON) data, or null if it can't be
 * trusted. Used when reloading tasks from persistent storage across sessions.
 */
export function restorePlacedTask(raw: unknown): PlacedTask | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  const base = toTask({ title: o.title as string, urgency: o.urgency, category: o.category } as Task);
  if (!base) return null;
  if (!isRing(o.ring)) return null;
  const result: PlacedTask = {
    id: o.id,
    title: base.title,
    urgency: base.urgency,
    category: base.category,
    ring: o.ring,
    status: o.status === "done" ? "done" : "active",
    enteredAt: typeof o.enteredAt === "number" ? o.enteredAt : 0,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
  };
  if (typeof o.completedAt === "number") result.completedAt = o.completedAt;
  if (isTimeString(o.time)) result.time = o.time;
  return result;
}

let _idCounter = 0;

/** Wrap an LLM Task into a PlacedTask (ring is assigned later by the store). */
export function makePlacedTask(task: Task): PlacedTask {
  _idCounter += 1;
  const placed: PlacedTask = {
    title: task.title,
    urgency: task.urgency,
    category: task.category,
    id: "task_" + Date.now() + "_" + _idCounter,
    ring: task.urgency, // provisional; TaskStore placement resolves the real ring
    status: "active",
    enteredAt: 0, // provisional; RingCapacity stamps this on placement
    createdAt: Date.now(),
  };
  if (task.time) placed.time = task.time;
  return placed;
}

export function isUrgency(v: unknown): v is Urgency {
  return typeof v === "string" && (URGENCIES as string[]).indexOf(v) !== -1;
}

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as string[]).indexOf(v) !== -1;
}

/** Trim a title to at most 6 words as a defensive backstop against the model. */
export function clampTitle(title: string): string {
  const words = title.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.slice(0, 6).join(" ");
}

/**
 * Validate one raw object into a Task, or return null if it can't be trusted.
 * Structured Outputs should guarantee shape, but we never trust the network blindly.
 */
export function toTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? clampTitle(o.title) : "";
  if (!title) return null;
  if (!isUrgency(o.urgency)) return null;
  if (!isCategory(o.category)) return null;
  const task: Task = { title, urgency: o.urgency, category: o.category };
  if (isTimeString(o.time)) task.time = o.time;
  return task;
}

// JSON parsing of model responses lives in TaskParsing.ts (parseModelResponse),
// alongside the fence-stripping and local fallback logic.
