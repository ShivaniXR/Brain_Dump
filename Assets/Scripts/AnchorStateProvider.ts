/**
 * Brain Dumpd — shared anchor-state singleton.
 *
 * AnchorController writes the state; StickyWallController and BrainDumpController read it:
 *   - "onboarding" — first run: a welcome/how-it-works panel is shown before any wall is picked.
 *   - "placing"  — the board is a placeholder following the user's gaze; awaiting a tap/pinch
 *                  to lock it to a wall. Only the backdrop shows; taps go to placement, not voice.
 *   - "located"  — the board is fixed on a wall; full columns + buttons show; taps drive voice.
 */
export type AnchorState = "onboarding" | "placing" | "located";

let _state: AnchorState = "onboarding";
const _listeners: ((s: AnchorState) => void)[] = [];

export function getAnchorState(): AnchorState {
  return _state;
}

export function isPlacing(): boolean {
  return _state === "placing";
}

export function setAnchorState(next: AnchorState): void {
  if (_state === next) return;
  _state = next;
  for (let i = 0; i < _listeners.length; i++) _listeners[i](next);
}

export function onAnchorStateChange(cb: (s: AnchorState) => void): void {
  _listeners.push(cb);
}

// --- re-anchor command channel ("New wall" button -> AnchorController) ---
const _reAnchorListeners: (() => void)[] = [];

export function onReAnchorRequest(cb: () => void): void {
  _reAnchorListeners.push(cb);
}

export function requestReAnchor(): void {
  for (let i = 0; i < _reAnchorListeners.length; i++) _reAnchorListeners[i]();
}
