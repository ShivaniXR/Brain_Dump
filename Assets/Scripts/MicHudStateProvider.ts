/**
 * Brain Dumpd — mic HUD state singleton.
 *
 * Tiny shared flag so other scripts can tell whether the mic is currently docked on the
 * wall (you're in the same room) or floating and following you (you're away). Used by the
 * board to only fly new notes in from the HUD when the mic is actually roaming with you.
 */
let _following = false;

export function setMicFollowing(v: boolean): void {
  _following = v;
}

export function isMicFollowing(): boolean {
  return _following;
}
