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

let _idCounter = 0;

/** Wrap an LLM Task into a PlacedTask (ring is assigned later by the store). */
export function makePlacedTask(task: Task): PlacedTask {
  _idCounter += 1;
  return {
    title: task.title,
    urgency: task.urgency,
    category: task.category,
    id: "task_" + Date.now() + "_" + _idCounter,
    ring: task.urgency, // provisional; TaskStore placement resolves the real ring
    status: "active",
    enteredAt: 0, // provisional; RingCapacity stamps this on placement
    createdAt: Date.now(),
  };
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
  return { title, urgency: o.urgency, category: o.category };
}

// JSON parsing of model responses lives in TaskParsing.ts (parseModelResponse),
// alongside the fence-stripping and local fallback logic.
