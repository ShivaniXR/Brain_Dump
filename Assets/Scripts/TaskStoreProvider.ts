/**
 * Brain Dumpd — shared TaskStore singleton.
 *
 * ES modules load once per lens, so every component that imports this gets the SAME
 * persistent TaskStore instance. BrainDumpController writes to it (voice -> LLM ->
 * tasks); RingLayoutController subscribes via onChange and re-renders. It uses the
 * default (Lens persistent) backing store, so the board survives session restarts.
 */
import { TaskStore } from "./TaskStore";

let _instance: TaskStore | null = null;

export function getTaskStore(): TaskStore {
  if (_instance === null) {
    _instance = new TaskStore(); // default => Lens PersistentStorageSystem
    // Testing aid: log the sorted board to the Logger on every change + once at startup.
    const store = _instance;
    store.onChange(() => print(store.describe()));
    print(store.describe());
  }
  return _instance;
}
