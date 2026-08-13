/**
 * Brain Dumpd — AnchorController.
 *
 * Owns wall anchoring via the SPECS Custom Locations flow and publishes an anchor
 * state that RingLayoutController branches on:
 *   startup: load a saved persistedLocationId -> retrieveLocation -> LocatedAtComponent
 *            fires onFound (same room => "located") or times out (new room => "unlocated").
 *   reAnchor(): map the current space (createMappingSession -> checkpoint) -> storeLocation
 *            -> save the id -> "located".
 *
 * DEVICE-ONLY: mapping, relocalization, and cloud storage cannot run in the editor. In the
 * editor all device calls are skipped and the state is simulated (editorSimulateState +
 * the A key) so the display branches can still be verified. Keys (editor): C = clear board,
 * A = toggle located/unlocated, R = re-anchor.
 */
import { getTaskStore } from "./TaskStoreProvider";
import { setAnchorState, getAnchorState, AnchorState, onReAnchorRequest } from "./AnchorStateProvider";

const ANCHOR_ID_KEY = "brainDumpd.anchor.v1";
const RELOCALIZE_TIMEOUT_S = 8;

@component
export class AnchorController extends BaseScriptComponent {
  @input
  @allowUndefined
  @hint("LocatedAtComponent on the target root (device anchoring). Leave empty in the editor.")
  locatedAt: LocatedAtComponent;

  @input
  @hint('Editor only: initial simulated anchor state — "located" or "unlocated".')
  editorSimulateState: string = "located";

  private isEditor = false;
  private searching = false;
  private elapsed = 0;

  onAwake(): void {
    this.isEditor = global.deviceInfoSystem.isEditor();
    this.createEvent("OnStartEvent").bind(() => this.begin());
    this.createEvent("UpdateEvent").bind(() => this.update());
    this.createEvent("KeyPressEvent").bind((e) => this.onKey(e as any));
    onReAnchorRequest(() => this.reAnchor()); // "new wall" button
  }

  private begin(): void {
    if (this.isEditor) {
      setAnchorState(this.editorSimulateState === "unlocated" ? "unlocated" : "located");
      return;
    }
    // --- device path ---
    const savedId = this.loadSavedId();
    if (!savedId || !this.locatedAt) {
      setAnchorState("unlocated"); // first run / no anchor yet -> needs anchoring
      return;
    }
    setAnchorState("searching");
    this.searching = true;
    this.elapsed = 0;
    this.locatedAt.onFound.add(() => {
      this.searching = false;
      setAnchorState("located");
    });
    this.locatedAt.onLost.add(() => setAnchorState("searching"));

    const cloud = this.cloudModule();
    if (!cloud) {
      setAnchorState("unlocated");
      return;
    }
    cloud.retrieveLocation(
      savedId,
      (loc) => {
        if (this.locatedAt) this.locatedAt.location = loc;
      },
      (err) => {
        print("[Anchor] retrieve error: " + err);
        setAnchorState("unlocated");
      }
    );
  }

  private update(): void {
    if (!this.searching) return;
    this.elapsed += getDeltaTime();
    if (this.elapsed >= RELOCALIZE_TIMEOUT_S) {
      this.searching = false;
      setAnchorState("unlocated");
      print("[Anchor] relocalization timed out — treating as a new space.");
    }
  }

  /** Re-attach the rings to the current wall/space. */
  reAnchor(): void {
    if (this.isEditor) {
      setAnchorState("located");
      print("[Anchor] (editor) simulated re-anchor -> located.");
      return;
    }
    if (!this.locatedAt) {
      print("[Anchor] no LocatedAtComponent assigned — cannot map.");
      return;
    }
    print("[Anchor] mapping the current space...");
    const options = LocatedAtComponent.createMappingOptions();
    const session = LocatedAtComponent.createMappingSession(options);
    session.checkpoint().then((loc) => {
      this.locatedAt.location = loc;
      const cloud = this.cloudModule();
      if (!cloud) return;
      cloud.storeLocation(
        loc,
        (id) => {
          this.saveId(id);
          this.searching = false;
          setAnchorState("located");
          print("[Anchor] mapped + stored new location.");
        },
        (err) => print("[Anchor] store error: " + err)
      );
    });
  }

  private onKey(e: KeyPressEvent): void {
    if (e.key === Keys.C) {
      getTaskStore().clear();
      print("[BrainDumpd] Board cleared.");
    } else if (e.key === Keys.A) {
      const next: AnchorState = getAnchorState() === "located" ? "unlocated" : "located";
      setAnchorState(next);
      print("[Anchor] (editor) toggled anchor state -> " + next);
    } else if (e.key === Keys.R) {
      this.reAnchor();
    }
  }

  private cloudModule(): LocationCloudStorageModule | null {
    try {
      return require("LensStudio:LocationCloudStorageModule") as LocationCloudStorageModule;
    } catch (err) {
      print("[Anchor] cloud storage module unavailable: " + err);
      return null;
    }
  }

  private loadSavedId(): string {
    const store = global.persistentStorageSystem.store;
    return store.has(ANCHOR_ID_KEY) ? store.getString(ANCHOR_ID_KEY) : "";
  }

  private saveId(id: string): void {
    global.persistentStorageSystem.store.putString(ANCHOR_ID_KEY, id);
  }
}
