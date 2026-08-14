/**
 * Brain Dumpd — AnchorController: gaze-to-place wall placement + persistence.
 *
 * PLACING (default at start, and on "New wall"): the board becomes a placeholder that follows
 * the surface the user looks at — each frame a World Query hit test casts forward from the
 * camera and moves the board onto the hit surface (facing the user). A tap/pinch confirms:
 * the board locks, all columns appear, and the pose is saved.
 *
 * LOCATED: the board is fixed on the wall. Returning next session restores the saved pose
 * (valid in Interactive Preview's fixed environment); on device, Custom Locations
 * (`LocatedAtComponent` + `LocationCloudStorage`) can relocalize the exact wall when wired.
 *
 * State is published via AnchorStateProvider. Editor keys: C = clear, R = re-place.
 */
import { getTaskStore } from "./TaskStoreProvider";
import { setAnchorState, getAnchorState, isPlacing, onReAnchorRequest } from "./AnchorStateProvider";

const POSE_KEY = "brainDumpd.wallPose.v1";
const LOCATION_ID_KEY = "brainDumpd.anchor.v1";

@component
export class AnchorController extends BaseScriptComponent {
  @input
  @hint("Camera to cast the placement ray from (its forward = look direction).")
  camera: SceneObject;

  @input
  @hint("The board to place (StickyWall root).")
  stickyWall: SceneObject;

  @input
  @allowUndefined
  @hint("Optional LocatedAtComponent for device relocalization (Custom Locations).")
  locatedAt: LocatedAtComponent;

  @input
  @hint("Max ray distance for the wall hit test (cm).")
  maxDistance: number = 500;

  @input
  @hint("How far to sit the board off the wall surface (cm).")
  offsetFromWall: number = 2;

  private isEditor = false;
  private session: HitTestSession;
  private hitPending = false;
  private placingSince = 0;
  private lastFollowLog = 0;
  private hasHit = false; // has a wall been hit during the current placing session?

  onAwake(): void {
    this.isEditor = global.deviceInfoSystem.isEditor();
    const wq = require("LensStudio:WorldQueryModule") as WorldQueryModule;
    this.session = wq.createHitTestSession();
    this.session.start();

    this.createEvent("OnStartEvent").bind(() => this.begin());
    this.createEvent("UpdateEvent").bind(() => this.updateFollow());
    this.createEvent("TapEvent").bind(() => this.onTap());
    this.createEvent("KeyPressEvent").bind((e) => this.onKey(e as any));
    onReAnchorRequest(() => this.startPlacing()); // "New wall" button
  }

  private begin(): void {
    if (this.restorePose()) {
      setAnchorState("located");
      this.tryRelocalize(); // device: refine to the exact wall if possible
    } else {
      this.startPlacing();
    }
  }

  private startPlacing(): void {
    setAnchorState("placing");
    this.placingSince = getTime();
    this.hasHit = false;
    print("[Anchor] PLACING — look at a wall; tap/pinch to place the board.");
  }

  /** While placing, keep the board on the surface the user is looking at. */
  private updateFollow(): void {
    if (!isPlacing() || this.hitPending || !this.camera || !this.stickyWall) return;
    const ct = this.camera.getTransform();
    const start = ct.getWorldPosition();
    const dir = ct.back; // camera's looking direction (SIK treats -forward as "in front")
    const end = start.add(dir.uniformScale(this.maxDistance));
    this.hitPending = true;
    this.session.hitTest(start, end, (hit) => {
      this.hitPending = false;
      if (!isPlacing()) return;
      const now = getTime();
      if (hit === null) {
        if (now - this.lastFollowLog > 1) {
          this.lastFollowLog = now;
          print(
            "[Anchor] no surface. cam(" +
              start.x.toFixed(0) + "," + start.y.toFixed(0) + "," + start.z.toFixed(0) +
              ") look(" + dir.x.toFixed(2) + "," + dir.y.toFixed(2) + "," + dir.z.toFixed(2) + ")"
          );
        }
        return;
      }
      this.hasHit = true;
      const t = this.stickyWall.getTransform();
      t.setWorldPosition(hit.position.add(hit.normal.uniformScale(this.offsetFromWall)));
      t.setWorldRotation(quat.lookAt(hit.normal, vec3.up()));
      if (now - this.lastFollowLog > 1) {
        this.lastFollowLog = now;
        print(
          "[Anchor] following wall at (" +
            hit.position.x.toFixed(0) + "," + hit.position.y.toFixed(0) + "," + hit.position.z.toFixed(0) + ")"
        );
      }
    });
  }

  private onTap(): void {
    if (!isPlacing()) return; // when located, taps belong to voice
    if (getTime() - this.placingSince < 0.4) return; // ignore the tap that opened placement
    if (!this.hasHit) {
      print("[Anchor] no wall in view yet — look at a wall, then tap to place.");
      return;
    }
    this.confirmPlacement();
  }

  private confirmPlacement(): void {
    if (!this.stickyWall) return;
    const t = this.stickyWall.getTransform();
    const pos = t.getWorldPosition();
    const rot = t.getWorldRotation();
    this.savePose(pos, rot);
    setAnchorState("located");
    print(
      "[Anchor] placed at (" +
        pos.x.toFixed(0) + "," + pos.y.toFixed(0) + "," + pos.z.toFixed(0) + ")"
    );
    this.mapAndStore(); // device persistence (guarded)
  }

  private onKey(e: KeyPressEvent): void {
    if (e.key === Keys.C) {
      getTaskStore().clear();
      print("[BrainDumpd] Board cleared.");
    } else if (e.key === Keys.R) {
      this.startPlacing();
    }
  }

  // --- device Custom Locations (guarded; no-ops in editor / when unwired) ---

  private tryRelocalize(): void {
    const savedId = this.loadSavedId();
    if (this.isEditor || !savedId || !this.locatedAt) return;
    this.locatedAt.onFound.add(() => setAnchorState("located"));
    const cloud = this.cloudModule();
    if (cloud) {
      cloud.retrieveLocation(
        savedId,
        (loc) => {
          if (this.locatedAt) this.locatedAt.location = loc;
        },
        (err) => print("[Anchor] retrieve error: " + err)
      );
    }
  }

  private mapAndStore(): void {
    if (this.isEditor || !this.locatedAt) return;
    const options = LocatedAtComponent.createMappingOptions();
    const mapping = LocatedAtComponent.createMappingSession(options);
    mapping.checkpoint().then((loc) => {
      this.locatedAt.location = loc;
      const cloud = this.cloudModule();
      if (!cloud) return;
      cloud.storeLocation(
        loc,
        (id) => {
          this.saveId(id);
          print("[Anchor] location mapped + stored.");
        },
        (err) => print("[Anchor] store error: " + err)
      );
    });
  }

  // --- persistence helpers ---

  private savePose(pos: vec3, rot: quat): void {
    const data = { p: [pos.x, pos.y, pos.z], r: [rot.x, rot.y, rot.z, rot.w] };
    global.persistentStorageSystem.store.putString(POSE_KEY, JSON.stringify(data));
  }

  private restorePose(): boolean {
    const store = global.persistentStorageSystem.store;
    if (!store.has(POSE_KEY) || !this.stickyWall) return false;
    try {
      const d = JSON.parse(store.getString(POSE_KEY));
      const t = this.stickyWall.getTransform();
      t.setWorldPosition(new vec3(d.p[0], d.p[1], d.p[2]));
      // Saved as [x,y,z,w]; Lens quat constructor is (w,x,y,z).
      t.setWorldRotation(new quat(d.r[3], d.r[0], d.r[1], d.r[2]));
      print("[Anchor] restored saved wall pose.");
      return true;
    } catch (e) {
      return false;
    }
  }

  private cloudModule(): LocationCloudStorageModule | null {
    try {
      return require("LensStudio:LocationCloudStorageModule") as LocationCloudStorageModule;
    } catch (err) {
      return null;
    }
  }

  private loadSavedId(): string {
    const s = global.persistentStorageSystem.store;
    return s.has(LOCATION_ID_KEY) ? s.getString(LOCATION_ID_KEY) : "";
  }

  private saveId(id: string): void {
    global.persistentStorageSystem.store.putString(LOCATION_ID_KEY, id);
  }
}
