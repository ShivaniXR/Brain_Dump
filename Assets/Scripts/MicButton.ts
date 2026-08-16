/**
 * Brain Dumpd — MicButton.
 *
 * A pressable SIK button (rounded disc with a 2D mic icon). Tap/pinch toggles recording:
 * first press starts the brain dump (ASR), next press stops it. Requests the toggle via
 * CaptureStateProvider; BrainDumpController performs the start/stop.
 */
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { requestRecordToggle } from "./CaptureStateProvider";

@component
export class MicButton extends BaseScriptComponent {
  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
  }

  private setup(): void {
    const so = this.getSceneObject();

    const collider = so.createComponent("Physics.ColliderComponent") as ColliderComponent;
    const box = Shape.createBoxShape();
    box.size = new vec3(24, 24, 4); // matches the circular mic button
    collider.shape = box;

    const interactable = so.createComponent(Interactable.getTypeName()) as Interactable;
    interactable.onTriggerStart.add(() => {
      requestRecordToggle();
      print("[BrainDumpd] Mic button pressed — toggling recording.");
    });

    print("[BrainDumpd] MicButton ready.");
  }
}
