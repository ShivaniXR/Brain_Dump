/**
 * Brain Dumpd — Calder-mobile MOTION SPIKE (throwaway feel-test).
 *
 * Drives ONE beam so we can tune the movement before building the full sculpture:
 *   - Critically-damped spring on the beam's yaw (rotation about the vertical filament
 *     axis). Starts displaced and settles with no overshoot in ~1.5s.
 *   - Very slow idle drift (a few degrees over ~20-30s) layered as the spring's target,
 *     as if moved by air.
 *   - The hanging card yaw-billboards to the camera every frame, so its position swings
 *     with the beam but the text stays upright and readable ("counter-rotation").
 *
 * Attach to the pivot object (PrimaryBeam); the card child must be named "Card".
 * Smooth-damp is the classic critically-damped spring (Game Programming Gems / Unity
 * SmoothDamp) — guarantees the "settle, no oscillation" quality.
 */
@component
export class MotionSpike extends BaseScriptComponent {
  @input
  @hint("Idle drift amplitude in degrees (a few = calm).")
  driftAmplitudeDeg: number = 10;

  @input
  @hint("Idle drift period in seconds (20-30 = very slow).")
  driftPeriodSec: number = 25;

  @input
  @hint("Spring smoothing time; ~0.5 settles in ~1.5s with no overshoot.")
  smoothTime: number = 0.5;

  @input
  @hint("Initial displacement (deg) so you can watch it settle on load.")
  initialDisturbanceDeg: number = 40;

  @input
  @allowUndefined
  @hint("Camera to face; if empty, faces the world origin (fine for Preview).")
  camera: SceneObject;

  private angle = 0; // current yaw (deg)
  private vel = 0; // yaw velocity (deg/s)
  private t = 0;
  private card: SceneObject;

  onAwake(): void {
    this.angle = this.initialDisturbanceDeg;
    this.createEvent("OnStartEvent").bind(() => this.findCard());
    this.createEvent("UpdateEvent").bind(() => this.step());
  }

  private findCard(): void {
    const so = this.getSceneObject();
    for (let i = 0; i < so.getChildrenCount(); i++) {
      if (so.getChild(i).name === "Card") {
        this.card = so.getChild(i);
        return;
      }
    }
  }

  private step(): void {
    const dt = getDeltaTime();
    this.t += dt;

    // Idle drift target (slow air-current sway).
    const target = this.driftAmplitudeDeg * Math.sin((2 * Math.PI * this.t) / this.driftPeriodSec);

    // Critically-damped smooth-damp toward the target.
    const smooth = this.smoothTime < 0.0001 ? 0.0001 : this.smoothTime;
    const omega = 2 / smooth;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.angle - target;
    const temp = (this.vel + omega * change) * dt;
    this.vel = (this.vel - omega * temp) * exp;
    this.angle = target + (change + temp) * exp;

    // Apply yaw (about world/local up).
    this.getTransform().setLocalRotation(quat.angleAxis((this.angle * Math.PI) / 180, vec3.up()));

    // Yaw-billboard the card: position swings with the beam, text stays upright + facing us.
    if (this.card) {
      const cardPos = this.card.getTransform().getWorldPosition();
      const camPos = this.camera ? this.camera.getTransform().getWorldPosition() : vec3.zero();
      const dir = camPos.sub(cardPos);
      const yaw = Math.atan2(dir.x, dir.z);
      this.card.getTransform().setWorldRotation(quat.angleAxis(yaw, vec3.up()));
    }
  }
}
