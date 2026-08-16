/**
 * Brain Dumpd — OnboardingController.
 *
 * On first run (no saved wall), AnchorController sets the state to "onboarding". This shows a
 * welcome / how-it-works panel floating in front of the user and waits for a tap; the tap
 * kicks off wall placement (via the shared re-anchor channel) and the panel hides itself.
 */
import { getAnchorState, onAnchorStateChange, requestReAnchor } from "./AnchorStateProvider";

@component
export class OnboardingController extends BaseScriptComponent {
  @input camera: SceneObject;

  @input
  @allowUndefined
  @hint("The welcome panel visuals to show while onboarding.")
  panel: SceneObject;

  @input @hint("Distance in front of the camera (cm).") forwardDistance: number = 95;
  @input @hint("How far below eye level (cm).") downOffset: number = 4;

  onAwake(): void {
    onAnchorStateChange((s) => this.apply(s));
    this.createEvent("OnStartEvent").bind(() => this.apply(getAnchorState()));
    this.createEvent("UpdateEvent").bind(() => this.follow());
    this.createEvent("TapEvent").bind(() => this.onContinue());
  }

  private apply(s: string): void {
    if (this.panel) this.panel.enabled = s === "onboarding";
  }

  private onContinue(): void {
    if (getAnchorState() !== "onboarding") return;
    requestReAnchor(); // -> AnchorController.startPlacing()
  }

  private follow(): void {
    if (getAnchorState() !== "onboarding" || !this.camera) return;
    const ct = this.camera.getTransform();
    const camPos = ct.getWorldPosition();
    const fwd = ct.back;
    const flat = new vec3(fwd.x, 0, fwd.z);
    const len = flat.length;
    const dir = len > 0.001 ? flat.uniformScale(1 / len) : fwd;
    const target = camPos
      .add(dir.uniformScale(this.forwardDistance))
      .add(new vec3(0, -this.downOffset, 0));
    const st = this.getSceneObject().getTransform();
    st.setWorldPosition(vec3.lerp(st.getWorldPosition(), target, 0.2));
    st.setWorldRotation(quat.lookAt(camPos.sub(st.getWorldPosition()), vec3.up()));
  }
}
