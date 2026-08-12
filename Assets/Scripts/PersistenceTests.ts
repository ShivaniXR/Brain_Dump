/**
 * Brain Dumpd — persistence test suite (TEMPORARY; scene object disabled by default).
 *
 * Saves a board (with overflow + a promotion + a completion), simulates a session
 * restart by constructing a fresh TaskStore against the SAME persistent store, and
 * asserts the reloaded board is identical — ring membership, per-ring ordering,
 * enteredAt stamps, and completion state. Runs in the Lens runtime; grep "[PERSIST]".
 */
import { TaskStore, KeyValueStore } from "./TaskStore";
import { makePlacedTask, Ring } from "./TaskTypes";

// Simple in-memory KeyValueStore, used as a fallback if the real persistent store
// isn't available in this environment. Behaves like GeneralDataStore for our needs.
class FakeStore implements KeyValueStore {
  private data: { [k: string]: string } = {};
  getString(key: string): string {
    return this.data[key] || "";
  }
  putString(key: string, value: string): void {
    this.data[key] = value;
  }
  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }
  remove(key: string): void {
    delete this.data[key];
  }
}

@component
export class PersistenceTests extends BaseScriptComponent {
  private passed = 0;
  private failed = 0;

  onAwake(): void {
    this.runAll();
  }

  private check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
      this.passed += 1;
      print("[PERSIST] PASS: " + name);
    } else {
      this.failed += 1;
      print("[PERSIST] FAIL: " + name + (detail ? " — " + detail : ""));
    }
  }

  /** A fully-ordered, comparable fingerprint of a store's board state. */
  private snapshot(s: TaskStore): string {
    const rings: Ring[] = ["now", "next", "later"];
    const parts: string[] = [];
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const ids = s
        .getByRing(r)
        .map((t) => t.id + "@" + t.enteredAt)
        .join(",");
      parts.push(r + "[" + ids + "]");
    }
    const done = s
      .getCompleted()
      .map((t) => t.id + ":" + t.status + ":" + (t.completedAt !== undefined ? t.completedAt : "-"))
      .join(",");
    parts.push("done{" + done + "}");
    return parts.join(" | ");
  }

  private pickStore(): { store: KeyValueStore; label: string } {
    // Prefer the real Lens persistent store; fall back to an in-memory fake.
    if (
      typeof global !== "undefined" &&
      (global as any).persistentStorageSystem &&
      (global as any).persistentStorageSystem.store
    ) {
      return { store: global.persistentStorageSystem.store, label: "PersistentStorageSystem" };
    }
    return { store: new FakeStore(), label: "FakeStore(fallback)" };
  }

  private runAll(): void {
    print("[PERSIST] ===== Persistence suite starting =====");

    const picked = this.pickStore();
    const kv = picked.store;
    const key = "brainDumpd.test.persist";
    print("[PERSIST] using backing store: " + picked.label);

    // Start clean so re-runs are deterministic.
    if (kv.has(key)) kv.remove(key);

    // -- Session 1: build a non-trivial board and mutate it. Each op auto-persists. --
    const s1 = new TaskStore(kv, key);
    const batch = [];
    for (let i = 1; i <= 6; i++) {
      batch.push(makePlacedTask({ title: "task " + i, urgency: "now", category: "home" }));
    }
    s1.addAll(batch); // 6 "now": Now gets first 3, Next gets the rest (overflow)
    const promoteId = s1.getByRing("next")[0].id;
    s1.promote(promoteId, "now"); // full Now -> displaces longest-sitting outward
    const completeId = s1.getByRing("now")[0].id;
    s1.complete(completeId); // one task completed

    const snap1 = this.snapshot(s1);
    print("[PERSIST] session 1 board: " + snap1);

    // Sanity: the board is actually non-empty and has one completed task.
    this.check(
      "session 1 has state to persist",
      s1.getAll().length > 0 && s1.getCompleted().length === 1,
      "active=" + s1.getAll().length + " done=" + s1.getCompleted().length
    );

    // -- Simulate a session restart: a fresh TaskStore auto-loads from the same store. --
    const s2 = new TaskStore(kv, key);
    const snap2 = this.snapshot(s2);
    print("[PERSIST] session 2 board: " + snap2);

    this.check(
      "reloaded active count matches",
      s2.getAll().length === s1.getAll().length,
      "s1=" + s1.getAll().length + " s2=" + s2.getAll().length
    );
    this.check(
      "reloaded completed count matches",
      s2.getCompleted().length === s1.getCompleted().length,
      "s1=" + s1.getCompleted().length + " s2=" + s2.getCompleted().length
    );
    this.check(
      "reloaded board identical (ring membership + ordering + enteredAt + completion)",
      snap1 === snap2,
      "\n  s1=" + snap1 + "\n  s2=" + snap2
    );

    // -- Deeper check: every ring's ordered id/enteredAt sequence matches exactly. --
    const rings: Ring[] = ["now", "next", "later"];
    let allRingsMatch = true;
    for (let i = 0; i < rings.length; i++) {
      const a = s1.getByRing(rings[i]).map((t) => t.id + "@" + t.enteredAt).join(",");
      const b = s2.getByRing(rings[i]).map((t) => t.id + "@" + t.enteredAt).join(",");
      if (a !== b) allRingsMatch = false;
    }
    this.check("per-ring ordering preserved exactly", allRingsMatch);

    // -- Completion state (completedAt) survives the round trip. --
    const done2 = s2.getCompleted()[0];
    this.check(
      "completed task retains status + completedAt",
      !!done2 && done2.status === "done" && typeof done2.completedAt === "number"
    );

    // Cleanup so we don't leave test data in the real store.
    if (kv.has(key)) kv.remove(key);

    print("[PERSIST] ===== SUMMARY: " + this.passed + " passed, " + this.failed + " failed =====");
    print(this.failed === 0 ? "[PERSIST] RESULT: ALL TESTS PASSED" : "[PERSIST] RESULT: SOME TESTS FAILED");
  }
}
