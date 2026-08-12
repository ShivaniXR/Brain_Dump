/**
 * Brain Dumpd — ring capacity test suite (TEMPORARY; scene object disabled by default).
 * Runs in the Lens runtime on awake and prints PASS/FAIL + summary. Grep "[RING]".
 */
import {
  Board,
  BoardTask,
  promote,
  insertWithDisplacement,
  placeParsedBatch,
  longestSittingOn,
  countOn,
  tasksOn,
} from "./RingCapacity";
import { Ring, Urgency, makePlacedTask } from "./TaskTypes";
import { TaskStore } from "./TaskStore";

@component
export class RingCapacityTests extends BaseScriptComponent {
  private passed = 0;
  private failed = 0;

  onAwake(): void {
    this.runAll();
  }

  private check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
      this.passed += 1;
      print("[RING] PASS: " + name);
    } else {
      this.failed += 1;
      print("[RING] FAIL: " + name + (detail ? " — " + detail : ""));
    }
  }

  private mk(id: string, ring: Ring, enteredAt: number, urgency: Urgency = "now"): BoardTask {
    return { id, title: id, urgency, ring, enteredAt };
  }

  private ringOf(board: Board, id: string): string {
    const t = board.filter((x) => x.id === id)[0];
    return t ? t.ring : "<absent>";
  }

  /** Ids on a ring in placement order (board array order). */
  private idsOn(board: Board, ring: Ring): string {
    return tasksOn(board, ring)
      .map((t) => t.id)
      .join(",");
  }

  private runAll(): void {
    print("[RING] ===== Ring capacity suite starting =====");

    // -- Test 1: promotion into a full ring displaces the longest-sitting task --
    {
      const board: Board = [
        this.mk("A", "now", 1),
        this.mk("B", "now", 2),
        this.mk("C", "now", 3),
        this.mk("X", "next", 4),
      ];
      const out = promote(board, "X", "now");
      this.check(
        "promote into full Now displaces oldest (A) outward",
        countOn(out, "now") === 3 &&
          this.ringOf(out, "X") === "now" &&
          this.ringOf(out, "A") === "next" &&
          this.ringOf(out, "B") === "now" &&
          this.ringOf(out, "C") === "now",
        "now=[" + this.idsOn(out, "now") + "] A->" + this.ringOf(out, "A")
      );
    }

    // -- Test 2: cascading displacement Now -> Next -> Later --
    {
      const board: Board = [
        this.mk("N1", "now", 1),
        this.mk("N2", "now", 2),
        this.mk("N3", "now", 3),
      ];
      for (let i = 1; i <= 8; i++) board.push(this.mk("E" + i, "next", 3 + i, "next")); // enteredAt 4..11
      board.push(this.mk("X", "later", 12, "later"));

      const out = promote(board, "X", "now");
      this.check(
        "cascade: X->Now, N1->Next, E1->Later",
        this.ringOf(out, "X") === "now" &&
          this.ringOf(out, "N1") === "next" &&
          this.ringOf(out, "E1") === "later" &&
          countOn(out, "now") === 3 &&
          countOn(out, "next") === 8 &&
          countOn(out, "later") === 1,
        "now=" + countOn(out, "now") + " next=" + countOn(out, "next") + " later=" + countOn(out, "later") +
          " X->" + this.ringOf(out, "X") + " N1->" + this.ringOf(out, "N1") + " E1->" + this.ringOf(out, "E1")
      );
    }

    // -- Test 3: a fresh parse of 6 urgent tasks -> first 3 Now, rest Next --
    {
      const parsed: Board = [];
      for (let i = 1; i <= 6; i++) parsed.push(this.mk("u" + i, "now", 0, "now"));
      const out = placeParsedBatch([] as Board, parsed);
      this.check(
        "6 urgent -> Now[u1,u2,u3], Next[u4,u5,u6]",
        this.idsOn(out, "now") === "u1,u2,u3" && this.idsOn(out, "next") === "u4,u5,u6",
        "now=[" + this.idsOn(out, "now") + "] next=[" + this.idsOn(out, "next") + "]"
      );
    }

    // -- Test 4: ordering rule — displaced task is the longest-sitting (by enteredAt),
    //    not by array position or id. Q has the smallest enteredAt though it is neither
    //    first in the array nor lowest id. --
    {
      const board: Board = [
        this.mk("P", "now", 30),
        this.mk("Q", "now", 10), // longest-sitting
        this.mk("R", "now", 20),
      ];
      this.check(
        "longestSittingOn picks Q (min enteredAt)",
        (longestSittingOn(board, "now") || { id: "?" }).id === "Q"
      );
      const out = insertWithDisplacement(board, this.mk("X", "now", 0, "now"), "now");
      this.check(
        "insert into full Now displaces Q (oldest), keeps P & R",
        this.ringOf(out, "Q") === "next" &&
          this.ringOf(out, "P") === "now" &&
          this.ringOf(out, "R") === "now" &&
          this.ringOf(out, "X") === "now" &&
          countOn(out, "now") === 3,
        "Q->" + this.ringOf(out, "Q") + " now=[" + this.idsOn(out, "now") + "]"
      );
    }

    // -- Guard: a fresh parse never displaces existing tasks; it overflows outward --
    {
      const board: Board = [this.mk("A", "now", 1), this.mk("B", "now", 2), this.mk("C", "now", 3)];
      const out = placeParsedBatch(board, [this.mk("z", "now", 0, "now")]);
      this.check(
        "fresh parse overflows (z->Next), existing Now untouched",
        this.ringOf(out, "z") === "next" &&
          this.ringOf(out, "A") === "now" &&
          this.ringOf(out, "B") === "now" &&
          this.ringOf(out, "C") === "now" &&
          countOn(out, "now") === 3,
        "z->" + this.ringOf(out, "z")
      );
    }

    // -- Wiring: TaskStore delegates placement to RingCapacity --
    {
      const store = new TaskStore(null); // null = no persistence (hermetic)
      const parsed = [];
      for (let i = 1; i <= 6; i++) {
        parsed.push(makePlacedTask({ title: "u" + i, urgency: "now", category: "home" }));
      }
      store.addAll(parsed); // fresh parse: 6 now -> overflow
      this.check(
        "TaskStore.addAll(6 now) -> Now 3 / Next 3 (overflow)",
        store.countOn("now") === 3 && store.countOn("next") === 3,
        "now=" + store.countOn("now") + " next=" + store.countOn("next")
      );

      const promoteId = store.getByRing("next")[0].id;
      store.promote(promoteId, "now"); // promotion into full Now -> displacement
      const nowHasPromoted = store.getByRing("now").filter((t) => t.id === promoteId).length === 1;
      this.check(
        "TaskStore.promote into full Now displaces, count stays 3",
        store.countOn("now") === 3 && nowHasPromoted && store.countOn("next") === 3,
        "now=" + store.countOn("now") + " promotedIn=" + nowHasPromoted
      );

      store.complete(promoteId); // manual completion frees a slot, no auto-promote
      this.check(
        "TaskStore.complete frees slot (Now 2), no auto-promote",
        store.countOn("now") === 2 && store.getCompleted().length === 1,
        "now=" + store.countOn("now") + " done=" + store.getCompleted().length
      );
    }

    print("[RING] ===== SUMMARY: " + this.passed + " passed, " + this.failed + " failed =====");
    print(this.failed === 0 ? "[RING] RESULT: ALL TESTS PASSED" : "[RING] RESULT: SOME TESTS FAILED");
  }
}
