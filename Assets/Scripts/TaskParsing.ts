/**
 * Brain Dumpd — parsing & fallback layer (PURE: no Lens/RSG dependencies).
 *
 * Kept free of engine imports so it can be unit-tested in isolation. Responsibilities:
 *   - stripCodeFences / parseModelResponse: turn a raw model reply into typed Tasks,
 *     throwing on empty, truncated, fenced-but-broken, or wrong-shape responses.
 *   - fallbackParse: a deterministic local parser used whenever the LLM path fails.
 *   - withTimeout / extractTasksWithFallback: orchestrates "try LLM (with an 8s cap),
 *     otherwise fall back locally" — the single hardened entry point.
 */
import { type Task, type Urgency, type Category, toTask, clampTitle, isTimeString } from "./TaskTypes";

// ---------------------------------------------------------------------------
// Model-response parsing
// ---------------------------------------------------------------------------

/** Strip a surrounding ```lang ... ``` markdown fence, if present. */
export function stripCodeFences(raw: string): string {
  let s = raw.trim();
  if (s.indexOf("```") === -1) return s;
  // Drop an opening fence with an optional language tag, and a closing fence.
  s = s.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, "");
  s = s.replace(/\r?\n?```[ \t]*$/, "");
  return s.trim();
}

/**
 * Parse the model's textual response into typed Tasks.
 * THROWS on empty, malformed/truncated JSON, or a valid-JSON-but-wrong-shape reply
 * (so the caller can fall back). Returns [] only for a valid `{ "tasks": [] }`.
 */
export function parseModelResponse(content: string): Task[] {
  if (content == null || content.trim().length === 0) {
    throw new Error("Empty model response");
  }
  const cleaned = stripCodeFences(content);
  let root: unknown;
  try {
    root = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Malformed JSON: " + e);
  }
  if (!root || typeof root !== "object" || !Array.isArray((root as { tasks?: unknown }).tasks)) {
    throw new Error("Unexpected response shape: missing tasks array");
  }
  const rawList = (root as { tasks: unknown[] }).tasks;
  const tasks: Task[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const t = toTask(rawList[i]);
    if (t) tasks.push(t);
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Local fallback parser
// ---------------------------------------------------------------------------

// Urgency keyword sets (spec words + near-synonyms). Matched as whole-word stems
// via "\bKEYWORD": "urgent" still catches "urgently", but "now" never matches
// inside "know". LATER is tested FIRST so negations like "no rush"/"not urgent"
// aren't swallowed by the NOW word "urgent"; otherwise default to "next".
const NOW_KEYWORDS = [
  "today", "now", "urgent", "asap", "immediately", "right away", "tonight",
  "this morning", "this afternoon", "by end of day", "eod", "right this",
];
const LATER_KEYWORDS = [
  "later", "sometime", "some time", "eventually", "one day", "someday", "some day",
  "down the line", "down the road", "at some point", "some point", "whenever",
  "no rush", "no hurry", "not urgent", "in the future", "future", "long term",
  "long-term", "next month", "next year", "months from now", "low priority",
];

// Light category hints; default is "home" when nothing matches.
const WORK_KEYWORDS = ["meeting", "deadline", "project", "email", "client", "boss", "work", "report", "presentation"];
const ERRAND_KEYWORDS = ["buy", "pick up", "groceries", "store", "shop", "haircut", "appointment", "bank", "pharmacy", "gas"];

/**
 * Repair common ASR punctuation artifacts before parsing. Most importantly, a spoken
 * time is often transcribed with a stray ";" or "." between the digits ("10;30",
 * "10.30"); rewrite those to a colon so neither the LLM nor the splitter treats a
 * single time as two items.
 */
export function normalizeTranscript(text: string): string {
  if (!text) return text;
  return text.replace(/(\d)\s*[;.]\s*(\d)/g, "$1:$2");
}

/**
 * Pull a clock time out of a segment for the fallback path. Handles an explicit
 * "HH:MM" (already normalized), and a bare "at 8pm" / "at 8 am" hour. Returns
 * 24-hour "HH:MM" or "" if none is found.
 */
export function extractTime(text: string): string {
  const hhmm = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (hhmm) {
    const h = hhmm[1].length < 2 ? "0" + hhmm[1] : hhmm[1];
    return h + ":" + hhmm[2];
  }
  const ampm = text.match(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (ampm[2].toLowerCase() === "pm") h += 12;
    return (h < 10 ? "0" + h : "" + h) + ":00";
  }
  return "";
}

/** True if any keyword appears as a whole-word stem (\bkeyword) in the text. */
function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  for (let i = 0; i < keywords.length; i++) {
    const escaped = keywords[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("\\b" + escaped).test(lower)) return true;
  }
  return false;
}

/** Assign urgency by keyword: later-words win first (to survive negations), then now, else "next". */
export function fallbackUrgency(text: string): Urgency {
  if (containsAny(text, LATER_KEYWORDS)) return "later";
  if (containsAny(text, NOW_KEYWORDS)) return "now";
  return "next";
}

function fallbackCategory(text: string): Category {
  if (containsAny(text, WORK_KEYWORDS)) return "work";
  if (containsAny(text, ERRAND_KEYWORDS)) return "errand";
  return "home";
}

// Leading filler phrases to trim so fallback titles stay concise/imperative.
const LEADING_FILLER = /^(?:so|and|then|also|but|well|um|uh|i (?:really )?(?:need|have|want|would like|got|gotta|should|must)(?: to)?|i'm going to|i am going to|i'll|maybe i|let me|remember to|don't forget to)\b[ ,]*/i;

function cleanTitle(segment: string): string {
  let s = segment.trim();
  // Trim leading filler repeatedly (handles "so I need to ...").
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(LEADING_FILLER, "").trim();
  }
  return s;
}

/**
 * Deterministic local parser. Splits the transcript on sentence terminators and
 * conjunction boundaries, then builds one task per meaningful segment with an
 * urgency assigned by keyword. Never throws; returns [] for empty input.
 */
export function fallbackParse(transcript: string): Task[] {
  if (!transcript || transcript.trim().length === 0) return [];

  // Note: no ";" in the terminator set — a spoken time heard as "10;30" must not split a task.
  const segments = normalizeTranscript(transcript)
    .split(/[.!?]+|\b(?:and then|and also|and|then|also|but)\b|,\s*(?=(?:and|then|also)\b)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const tasks: Task[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Skip trivial fragments (need at least two words to be a task).
    if (seg.split(/\s+/).filter((w) => w.length > 0).length < 2) continue;
    const urgency = fallbackUrgency(seg);
    const category = fallbackCategory(seg);
    const title = clampTitle(cleanTitle(seg));
    if (title.length > 0) {
      const task: Task = { title, urgency, category };
      const time = extractTime(seg);
      if (time) task.time = time;
      tasks.push(task);
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Orchestration: try LLM with a timeout, otherwise fall back
// ---------------------------------------------------------------------------

export type LLMCall = (transcript: string) => Promise<string>;

export type ExtractSource = "llm" | "fallback";

export interface ExtractResult {
  tasks: Task[];
  source: ExtractSource;
  reason?: string; // why the fallback fired, when source === "fallback"
}

/** Reject with a timeout error if `p` doesn't settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("LLM call timed out after " + ms + "ms"));
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          if (typeof clearTimeout === "function") clearTimeout(timer);
          resolve(v);
        }
      },
      (e) => {
        if (!settled) {
          settled = true;
          if (typeof clearTimeout === "function") clearTimeout(timer);
          reject(e);
        }
      }
    );
  });
}

/**
 * Hardened extraction: run the LLM call under an `timeoutMs` cap and parse it;
 * if the call rejects, times out, or returns unusable content, parse the
 * transcript locally instead. Never rejects for parseable transcripts.
 */
export function extractTasksWithFallback(
  transcript: string,
  llmCall: LLMCall,
  timeoutMs: number
): Promise<ExtractResult> {
  // Repair ASR artifacts once so BOTH the LLM and the local fallback see clean text.
  const clean = normalizeTranscript(transcript);
  return withTimeout(llmCall(clean), timeoutMs)
    .then((content) => {
      const tasks = parseModelResponse(content); // throws on bad content
      return { tasks, source: "llm" as ExtractSource };
    })
    .catch((err) => {
      return {
        tasks: fallbackParse(clean),
        source: "fallback" as ExtractSource,
        reason: String(err && err.message ? err.message : err),
      };
    });
}
