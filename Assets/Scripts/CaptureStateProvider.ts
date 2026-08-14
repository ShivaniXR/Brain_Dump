/**
 * Brain Dumpd — capture-state singleton (voice front end <-> indicator UI).
 *
 * State:
 *   - "idle"       — not recording, not thinking.
 *   - "listening"  — ASR is recording; `volume` (0..1) tracks input level for the pulse.
 *   - "thinking"   — waiting on the LLM.
 *
 * Also carries a record-toggle command channel so the mic button can start/stop recording.
 */
export type CaptureState = "idle" | "listening" | "thinking";

let _state: CaptureState = "idle";
let _volume = 0;
const _stateListeners: ((s: CaptureState) => void)[] = [];

export function getCaptureState(): CaptureState {
  return _state;
}

export function setCaptureState(next: CaptureState): void {
  if (_state === next) return;
  _state = next;
  for (let i = 0; i < _stateListeners.length; i++) _stateListeners[i](next);
}

export function onCaptureStateChange(cb: (s: CaptureState) => void): void {
  _stateListeners.push(cb);
}

/** Smoothed input level, 0..1, updated while listening. */
export function getVolume(): number {
  return _volume;
}

export function setVolume(v: number): void {
  _volume = v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- record toggle channel (mic button -> BrainDumpController) ---
const _recordListeners: (() => void)[] = [];

export function onRecordToggleRequest(cb: () => void): void {
  _recordListeners.push(cb);
}

export function requestRecordToggle(): void {
  for (let i = 0; i < _recordListeners.length; i++) _recordListeners[i]();
}
