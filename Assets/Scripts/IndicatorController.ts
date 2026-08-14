/**
 * Brain Dumpd — IndicatorController.
 *
 * Drives one indicator disc on the wall based on capture state:
 *   - listening: coral, pulses with input volume (real mic level if a mic audio track is
 *                wired; otherwise a lively fallback pulse).
 *   - thinking:  a compact blue pulse in the same place while the LLM runs.
 *   - idle:      hidden.
 *
 * Attach near the mic button. Inputs: indicator (the disc), and optionally micAudioTrack
 * (a Microphone audio track asset) for true volume-reactivity.
 */
import { getCaptureState, onCaptureStateChange, setVolume } from "./CaptureStateProvider";

@component
export class IndicatorController extends BaseScriptComponent {
  @input indicator: SceneObject;

  @input
  @allowUndefined
  @hint("Optional Microphone audio track — wire it for true volume-reactive pulsing.")
  micAudioTrack: AudioTrackAsset;

  private micProvider: MicrophoneAudioProvider | null = null;
  private rmv: RenderMeshVisual | null = null;
  private baseScale: vec3 = new vec3(1, 1, 1);
  private vol = 0;
  private t = 0;

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
      this.indicator.enabled = false;
    }
    onCaptureStateChange((s) => {
      if (this.indicator) this.indicator.enabled = s !== "idle";
    });
  }

  private step(): void {
    if (!this.indicator || !this.indicator.enabled) return;
    this.t += getDeltaTime();
    const state = getCaptureState();

    if (state === "listening") {
      const amp = this.micProvider ? this.micLevel() : 0.35 + 0.35 * Math.abs(Math.sin(this.t * 7));
      this.vol += (amp - this.vol) * 0.25; // smooth
      setVolume(this.vol);
      this.applyScale(1 + this.vol * 0.9);
      this.applyColor(1, 0.35, 0.32, 1); // coral
    } else if (state === "thinking") {
      const pulse = 0.55 + 0.08 * Math.sin(this.t * 7); // compact + gentle
      this.applyScale(pulse);
      this.applyColor(0.35, 0.55, 1, 1); // blue
    }
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
