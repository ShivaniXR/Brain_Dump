/**
 * Brain Dumpd — ClearButton.
 *
 * Turns its SceneObject (the "CLEAR" label beside the target) into a pressable SIK
 * button: adds a box collider + an Interactable at runtime and clears the whole board
 * on trigger, removing every card from the circles.
 *
 * DEVICE / hand-tracking: pinch triggers `onTriggerStart`. The editor has no hand
 * tracking (and no preview-interactor package here), so on-device is where the pinch
 * is exercised; the editor "C" key remains a dev fallback for the same action.
 */
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { getTaskStore } from "./TaskStoreProvider";

@component
export class ClearButton extends BaseScriptComponent {
  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
  }

  private setup(): void {
    const so = this.getSceneObject();

    // Box collider so an interactor can hit the label.
    const collider = so.createComponent("Physics.ColliderComponent") as ColliderComponent;
    const box = Shape.createBoxShape();
    box.size = new vec3(34, 14, 3);
    collider.shape = box;

    // SIK Interactable -> clear the board on pinch/trigger.
    const interactable = so.createComponent(Interactable.getTypeName()) as Interactable;
    interactable.onTriggerStart.add(() => {
      getTaskStore().clear();
      print("[BrainDumpd] Board cleared (button).");
    });

    print("[BrainDumpd] ClearButton ready.");
  }
}
