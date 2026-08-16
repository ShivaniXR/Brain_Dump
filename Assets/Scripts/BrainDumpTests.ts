/**
 * Brain Dumpd — parsing-layer test suite (TEMPORARY; remove before shipping).
 *
 * Runs in the Lens runtime on awake and prints PASS/FAIL per case plus a summary.
 * Uses injected fake LLM calls (no network) so every branch is deterministic.
 * Verify results with RunAndCollectLogsTool and grep for "[TEST]".
 */
import {
  extractTasksWithFallback,
  fallbackParse,
  fallbackUrgency,
  normalizeTranscript,
  LLMCall,
} from "./TaskParsing";
import { Task } from "./TaskTypes";

// Deterministic transcript used for every fallback case. Splits on "and also"/"and"
// into 3 segments whose keywords map to now / later / next respectively.
const TRANSCRIPT =
  "Call the plumber urgently and also water the plants sometime and email my boss.";

@component
export class BrainDumpTests extends BaseScriptComponent {
  private passed = 0;
  private failed = 0;

  onAwake(): void {
    this.runAll();
  }

  private check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
      this.passed += 1;
      print("[TEST] PASS: " + name);
    } else {
      this.failed += 1;
      print("[TEST] FAIL: " + name + (detail ? " — " + detail : ""));
    }
  }

  private checkFallback3(name: string, r: { source: string; tasks: Task[] }): void {
    const urg = r.tasks.map((t) => t.urgency).join(",");
    this.check(
      name,
      r.source === "fallback" && r.tasks.length === 3 && urg === "now,later,next",
      "source=" + r.source + " n=" + r.tasks.length + " urg=[" + urg + "]"
    );
  }

  private async runAll(): Promise<void> {
    print("[TEST] ===== Brain Dumpd parsing suite starting =====");

    const resolveWith = (s: string): LLMCall => () => Promise.resolve(s);
    const neverResolves: LLMCall = () => new Promise<string>(() => {});
    const rejects: LLMCall = () => Promise.reject(new Error("network down"));

    // 1. Valid JSON -> use LLM output directly.
    let r = await extractTasksWithFallback(
      TRANSCRIPT,
      resolveWith('{"tasks":[{"title":"Buy milk","urgency":"now","category":"errand"}]}'),
      5000
    );
    this.check(
      "valid JSON -> llm",
      r.source === "llm" &&
        r.tasks.length === 1 &&
        r.tasks[0].title === "Buy milk" &&
        r.tasks[0].urgency === "now" &&
        r.tasks[0].category === "errand",
      "source=" + r.source + " n=" + r.tasks.length
    );

    // 2. Truncated JSON -> JSON.parse fails -> fallback.
    r = await extractTasksWithFallback(
      TRANSCRIPT,
      resolveWith('{"tasks":[{"title":"Buy milk","urgency":"now","category":"errand"}'),
      5000
    );
    this.checkFallback3("truncated JSON -> fallback", r);

    // 3. JSON wrapped in markdown fences -> stripped, then parsed via LLM.
    r = await extractTasksWithFallback(
      TRANSCRIPT,
      resolveWith('```json\n{"tasks":[{"title":"Call mom","urgency":"next","category":"home"}]}\n```'),
      5000
    );
    this.check(
      "markdown-fenced JSON -> llm",
      r.source === "llm" && r.tasks.length === 1 && r.tasks[0].title === "Call mom",
      "source=" + r.source + " n=" + r.tasks.length
    );

    // 4. Plain prose (non-JSON) -> fallback.
    r = await extractTasksWithFallback(
      TRANSCRIPT,
      resolveWith("Sure! Here are the tasks I found: buy milk and call your mom."),
      5000
    );
    this.checkFallback3("plain prose -> fallback", r);

    // 5. Empty response -> fallback.
    r = await extractTasksWithFallback(TRANSCRIPT, resolveWith(""), 5000);
    this.checkFallback3("empty response -> fallback", r);

    // 6. Network timeout (call never resolves, 40ms cap) -> fallback.
    r = await extractTasksWithFallback(TRANSCRIPT, neverResolves, 40);
    this.checkFallback3("network timeout -> fallback", r);

    // 7. Bonus: outright call rejection -> fallback.
    r = await extractTasksWithFallback(TRANSCRIPT, rejects, 5000);
    this.checkFallback3("network error -> fallback", r);

    // 8. Bonus: valid but empty tasks array -> LLM path, no fallback, no tasks.
    r = await extractTasksWithFallback("", resolveWith('{"tasks":[]}'), 5000);
    this.check(
      "valid empty tasks -> llm []",
      r.source === "llm" && r.tasks.length === 0,
      "source=" + r.source + " n=" + r.tasks.length
    );

    // 9. Keyword mapping: synonyms + whole-word-stem matching (no false positives).
    this.check("synonym: asap -> now", fallbackUrgency("Send the invoice asap") === "now");
    this.check("synonym: immediately -> now", fallbackUrgency("Reply immediately") === "now");
    this.check("synonym: tonight -> now", fallbackUrgency("Pack the bag tonight") === "now");
    this.check("stem: urgently -> now", fallbackUrgency("Handle this urgently") === "now");
    this.check("synonym: someday -> later", fallbackUrgency("Learn guitar someday") === "later");
    this.check("synonym: down the line -> later", fallbackUrgency("Refactor it down the line") === "later");
    this.check(
      'false positive guard: "know" is not now',
      fallbackUrgency("I know I should call the dentist") === "next",
      "got " + fallbackUrgency("I know I should call the dentist")
    );

    // 10. "later" detection (the reported bug: nothing ever landed in later).
    this.check('word "later" -> later', fallbackUrgency("Fix the fence later") === "later");
    this.check('phrase "no rush" -> later', fallbackUrgency("Repaint the door, no rush") === "later");
    this.check(
      'negation "not urgent" -> later (not swallowed by "urgent")',
      fallbackUrgency("This is not urgent") === "later",
      "got " + fallbackUrgency("This is not urgent")
    );

    // 11. ASR time artifact: "10;30" must not split one task into two.
    this.check(
      'normalize "10;30" -> "10:30"',
      normalizeTranscript("meet at 10;30 today") === "meet at 10:30 today"
    );
    const meeting = fallbackParse("I have a meeting with John tonight at 10;30");
    this.check(
      "spoken time stays one task",
      meeting.length === 1 && meeting[0].urgency === "now",
      "n=" + meeting.length + " urg=[" + meeting.map((t) => t.urgency).join(",") + "]"
    );

    print("[TEST] ===== SUMMARY: " + this.passed + " passed, " + this.failed + " failed =====");
    print(this.failed === 0 ? "[TEST] RESULT: ALL TESTS PASSED" : "[TEST] RESULT: SOME TESTS FAILED");
  }
}
