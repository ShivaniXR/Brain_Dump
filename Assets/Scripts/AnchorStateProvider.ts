/**
 * Brain Dumpd — shared anchor-state singleton.
 *
 * AnchorController writes the current spatial state; RingLayoutController subscribes and
 * branches its display:
 *   - "searching"  — trying to relocalize a saved location (treat like located for display)
 *   - "located"    — same room: rings shown on the wall, all cards fly to slots
 *   - "unlocated"  — new/different room: rings hidden, only Now cards float in front
 */
export type AnchorState = "searching" | "located" | "unlocated";

let _state: AnchorState = "searching";
const _listeners: ((s: AnchorState) => void)[] = [];

export function getAnchorState(): AnchorState {
  return _state;
}

export function setAnchorState(next: AnchorState): void {
  if (_state === next) return;
  _state = next;
  for (let i = 0; i < _listeners.length; i++) _listeners[i](next);
}

export function onAnchorStateChange(cb: (s: AnchorState) => void): void {
  _listeners.push(cb);
}

// --- re-anchor command channel (button -> AnchorController) ---
const _reAnchorListeners: (() => void)[] = [];

export function onReAnchorRequest(cb: () => void): void {
  _reAnchorListeners.push(cb);
}

export function requestReAnchor(): void {
  for (let i = 0; i < _reAnchorListeners.length; i++) _reAnchorListeners[i]();
}
