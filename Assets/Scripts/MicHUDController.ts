/**
 * Brain Dumpd — MicHUDController.
 *
 * Makes the mic button + its indicators a body-locked HUD that follows the user, so a brain
 * dump can be recorded from anywhere — not just standing at the wall. On awake it reparents
 * the mic cluster (mic button, listening halo, thinking spinner) under this object and
 * clusters them on the origin; each frame it eases this object to a spot in front of the
 * camera, facing the user.
 *
 * When the user is near the wall (same room), the cluster docks to a fixed spot on the board
 * (`micDock`); when they walk away (another room), it detaches and follows in front of them.
 *
 * Reparenting happens in onAwake (the OnAwake phase) so it completes before IndicatorController
 * reads the halo's base scale in its OnStart handler.
 */
import { getAnchorState } from "./AnchorStateProvider";
import { setMicFollowing } from "./MicHudStateProvider";

@component
export class MicHUDController extends BaseScriptComponent {
  @input camera: SceneObject;
  @input micButton: SceneObject;

  @input
  @allowUndefined
  halo: SceneObject; // RecordIndicator (listening halo)

  @input
  @allowUndefined
  spinner: SceneObject; // ThinkingSpinner (LLM dots)

  @input
  @allowUndefined
  @hint("Marker on the board where the mic docks when you're in the same room as the wall.")
  micDock: SceneObject;

  @input @hint("Distance in front of the camera when following (cm).") forwardDistance: number = 70;
  @input @hint("How far below eye level to sit the HUD (cm).") downOffset: number = 22;
  @input @hint("Follow smoothing per frame (0..1; higher = snappier).") smoothing: number = 0.16;

  @input @hint("Dock to the wall when the camera is within this of it (cm).") dockEnter: number = 300;
  @input @hint("Undock (follow you) once the camera is beyond this (cm).") dockExit: number = 420;

  @input @hint("Scale of the mic while following you (1 = wall size; 0.55 = ~45% smaller).")
  followScale: number = 0.55;

  private docked = false;

  onAwake(): void {
    this.attach();
    this.createEvent("UpdateEvent").bind(() => this.follow());
  }

  /** Reparent the mic cluster under the HUD and cluster them on the origin. */
  private attach(): void {
    const self = this.getSceneObject();
    this.place(this.micButton, self, vec3.zero(), new vec3(1, 1, 1));
    this.place(this.halo, self, new vec3(0, 0, -0.3), new vec3(13, 13, 1));
    this.place(this.spinner, self, new vec3(0, 0, -0.2), new vec3(1, 1, 1));
  }

  private place(obj: SceneObject, parent: SceneObject, pos: vec3, scale: vec3): void {
    if (!obj) return;
    obj.setParent(parent);
    const t = obj.getTransform();
    t.setLocalPosition(pos);
    t.setLocalRotation(quat.quatIdentity());
    t.setLocalScale(scale);
  }

  private follow(): void {
    if (!this.camera) return;
    const ct = this.camera.getTransform();
    const camPos = ct.getWorldPosition();

    let targetPos: vec3;
    let targetRot: quat;

    // Dock to the wall only when the board is placed AND we're near it (same room).
    const located = getAnchorState() === "located";
    const canDock = located && this.micDock != null;
    if (canDock) {
      const dockPos = this.micDock.getTransform().getWorldPosition();
      const dist = camPos.sub(dockPos).length;
      if (this.docked && dist > this.dockExit) this.docked = false;
      else if (!this.docked && dist < this.dockEnter) this.docked = true;
    } else {
      this.docked = false;
    }
    setMicFollowing(!this.docked); // the board only flies notes in while the mic is roaming

    if (this.docked) {
      targetPos = this.micDock.getTransform().getWorldPosition();
      targetRot = this.micDock.getTransform().getWorldRotation(); // sit flat on the board
    } else {
      targetPos = this.hudTarget(ct, camPos);
      targetRot = quat.lookAt(camPos.sub(targetPos), vec3.up()); // face the user
    }

    // Hidden (scale 0) until a wall is placed; then full size docked, or 30% smaller following.
    const targetScale = !located ? 0 : this.docked ? 1 : this.followScale;

    const st = this.getSceneObject().getTransform();
    st.setWorldPosition(vec3.lerp(st.getWorldPosition(), targetPos, this.smoothing));
    st.setWorldRotation(quat.lerp(st.getWorldRotation(), targetRot, this.smoothing));
    const s = st.getLocalScale().x + (targetScale - st.getLocalScale().x) * this.smoothing;
    st.setLocalScale(new vec3(s, s, s));
  }

  /** A comfortable body-locked spot in front of the user (horizontal-locked, below eye level). */
  private hudTarget(ct: Transform, camPos: vec3): vec3 {
    const fwd = ct.back;
    const flat = new vec3(fwd.x, 0, fwd.z);
    const len = flat.length;
    const dir = len > 0.001 ? flat.uniformScale(1 / len) : fwd;
    return camPos.add(dir.uniformScale(this.forwardDistance)).add(new vec3(0, -this.downOffset, 0));
  }
}
