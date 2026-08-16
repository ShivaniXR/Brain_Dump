/**
 * Brain Dumpd — IndicatorController.
 *
 * Drives two affordances that animate around the mic button, based on capture state:
 *   - listening: a soft coral halo (behind the mic) that breathes with input volume
 *                (real mic level if a mic audio track is wired; otherwise a lively fallback).
 *   - thinking:  a blue spinner ring that rotates while the LLM works.
 *   - idle:      both hidden.
 *
 * Attach to the halo SceneObject (RenderMeshVisual). Inputs: indicator (the halo disc),
 * spinner (the loading ring), and optionally micAudioTrack for true volume-reactivity.
 */
import {
  getCaptureState,
  onCaptureStateChange,
  setVolume,
} from "./CaptureStateProvider";

@component
export class IndicatorController extends BaseScriptComponent {
  @input indicator: SceneObject; // coral listening halo (behind the mic)

  @input
  @allowUndefined
  @hint("Blue loading spinner shown while the LLM is thinking; rotated each frame.")
  spinner: SceneObject;

  @input
  @allowUndefined
  @hint("Optional Microphone audio track — wire it for true volume-reactive pulsing.")
  micAudioTrack: AudioTrackAsset;

  @input @hint("Spinner rotation speed (radians/sec).") spinnerSpeed: number = 5;

  private micProvider: MicrophoneAudioProvider | null = null;
  private rmv: RenderMeshVisual | null = null;
  private baseScale: vec3 = new vec3(1, 1, 1);
  private vol = 0;
  private angle = 0;

  onAwake(): void {
    if (this.micAudioTrack) {
      this.micProvider = this.micAudioTrack.control as MicrophoneAudioProvider;
    }
    this.createEvent("OnStartEvent").bind(() => this.setup());
    this.createEvent("UpdateEvent").bind(() => this.step());
  }

  private setup(): void {
    if (this.indicator) {
      this.baseScale = this.indicator.getTransform().getLocalScale();
      this.rmv = this.indicator.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      // NOTE: this script lives on the halo object, so we must keep the SceneObject enabled
      // (disabling it would stop UpdateEvent -> the spinner would never rotate). Toggle the
      // mesh visual instead to show/hide the halo.
      if (this.rmv) this.rmv.enabled = false;
    }
    if (this.spinner) this.spinner.enabled = false;

    onCaptureStateChange((s) => this.applyState(s));
    this.applyState(getCaptureState());
  }

  /** Show exactly one affordance for the current state (or none when idle). */
  private applyState(s: string): void {
    if (this.rmv) this.rmv.enabled = s === "listening"; // halo mesh (object stays enabled)
    if (this.spinner) this.spinner.enabled = s === "thinking";
    if (s === "listening") this.vol = 0;
    if (s === "thinking") this.angle = 0;
  }

  private step(): void {
    const state = getCaptureState();

    if (state === "listening" && this.indicator) {
      const amp = this.micProvider ? this.micLevel() : 0.35 + 0.35 * Math.abs(Math.sin(this.getT() * 7));
      this.vol += (amp - this.vol) * 0.25; // smooth
      setVolume(this.vol);
      this.applyScale(1 + this.vol * 1.1); // breathe: quiet ~ hugs the mic, loud ~ big halo
      this.applyColor(1, 0.45, 0.4, 0.4 + this.vol * 0.45); // coral, more opaque when louder
    } else if (state === "thinking" && this.spinner) {
      this.angle += getDeltaTime() * this.spinnerSpeed;
      this.spinner.getTransform().setLocalRotation(quat.angleAxis(-this.angle, vec3.forward()));
    }
  }

  /** Monotonic time for the fallback pulse (avoids a separate accumulator). */
  private getT(): number {
    return getTime();
  }

  /** RMS of the current mic frame, mapped to ~0..1. */
  private micLevel(): number {
    const p = this.micProvider;
    const buf = new Float32Array(p.maxFrameSize);
    const shape = p.getAudioFrame(buf);
    const n = shape.x < 1 ? 1 : shape.x;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / n);
    const v = rms * 6;
    return v > 1 ? 1 : v;
  }

  private applyScale(f: number): void {
    this.indicator
      .getTransform()
      .setLocalScale(new vec3(this.baseScale.x * f, this.baseScale.y * f, this.baseScale.z));
  }

  private applyColor(r: number, g: number, b: number, a: number): void {
    if (this.rmv) this.rmv.mainPass.baseColor = new vec4(r, g, b, a);
  }
}
