/**
 * Brain Dumpd — WallButton.
 *
 * A pressable SIK button on the sticky wall. Attach to a button group (with a "Quad" +
 * "Label" child); it sets the label text at runtime, adds a box collider + Interactable,
 * and on pinch runs its action: "clear" (sweep the wall) or "reanchor" (move to a new wall).
 *
 * DEVICE / hand-tracking: pinch triggers it. Editor keys C (clear) / R (reanchor) via
 * AnchorController remain dev fallbacks.
 */
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { getTaskStore } from "./TaskStoreProvider";
import { requestReAnchor } from "./AnchorStateProvider";

@component
export class WallButton extends BaseScriptComponent {
  @input
  @hint('"clear" (sweep the wall) or "reanchor" (move to a new wall).')
  action: string = "clear";

  @input
  @hint("Text shown on the button.")
  label: string = "Sweep wall";

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
  }

  private setup(): void {
    const so = this.getSceneObject();

    // Label text at runtime (Text3D only sizes correctly when set in-script).
    for (let i = 0; i < so.getChildrenCount(); i++) {
      const ch = so.getChild(i);
      if (ch.name.indexOf("Label") === 0) {
        const t = ch.getComponent("Component.Text3D") as Text3D;
        if (t) {
          t.text = "";
          t.text = this.label;
        }
      }
    }

    const collider = so.createComponent("Physics.ColliderComponent") as ColliderComponent;
    const box = Shape.createBoxShape();
    box.size = new vec3(40, 13, 4); // matches the rounded pill
    collider.shape = box;

    const interactable = so.createComponent(Interactable.getTypeName()) as Interactable;
    interactable.onTriggerStart.add(() => this.trigger());

    print("[BrainDumpd] WallButton (" + this.action + ") ready.");
  }

  private trigger(): void {
    if (this.action === "reanchor") {
      requestReAnchor();
      print("[BrainDumpd] Re-anchor requested (button).");
    } else {
      getTaskStore().clear();
      print("[BrainDumpd] Board cleared (button).");
    }
  }
}
