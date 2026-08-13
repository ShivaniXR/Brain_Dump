/**
 * Brain Dumpd — Sticky Wall MOTION/LOOK SPIKE (throwaway feel-test).
 *
 * Sets each note's text at runtime (Text3D only sizes correctly when text is assigned
 * in-script, not via the editor) and plays a staggered "slap onto the wall" entrance:
 * each note + label pops in with a small overshoot and settles.
 *
 * Attach to the StickyWall root. Note quads are named Note_*, texts T_*, headers H_*.
 */
@component
export class StickyWallSpike extends BaseScriptComponent {
  @input
  @hint("Seconds for each note's pop-in.")
  popDuration: number = 0.32;

  @input
  @hint("Delay between successive notes slapping on.")
  stagger: number = 0.09;

  private titles: { [name: string]: string } = {
    T_now1: "Attend meeting",
    T_now2: "Call plumber",
    T_next1: "Get haircut",
    T_next2: "Submit project",
    T_next3: "Reply to boss",
    T_later1: "Plan vacation",
    T_later2: "Read book",
    H_now: "NOW",
    H_next: "NEXT",
    H_later: "LATER",
  };

  private items: { obj: SceneObject; start: vec3; target: vec3; delay: number }[] = [];
  private elapsed = 0;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.setup());
    this.createEvent("UpdateEvent").bind(() => this.animate());
  }

  private setup(): void {
    const root = this.getSceneObject();
    let order = 0;
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const ch = root.getChild(i);
      const name = ch.name;

      // Runtime text assignment forces the Text3D mesh to size correctly.
      // Clear first so the value genuinely changes and the mesh regenerates.
      if (this.titles[name]) {
        const t3d = ch.getComponent("Component.Text3D") as Text3D;
        if (t3d) {
          t3d.text = "";
          t3d.text = this.titles[name];
        }
      }

      // Animate note quads + text/headers in; leave the backdrop static.
      const animatable = name.indexOf("Note_") === 0 || name.indexOf("T_") === 0 || name.indexOf("H_") === 0;
      if (!animatable) continue;

      const target = ch.getTransform().getLocalScale();
      const start = new vec3(target.x * 0.02, target.y * 0.02, target.z * 0.02);
      ch.getTransform().setLocalScale(start);
      this.items.push({ obj: ch, start: start, target: target, delay: order * this.stagger });
      order += 1;
    }
    print("[StickyWall] setup: animating " + this.items.length + " items, text set at runtime.");
  }

  private animate(): void {
    this.elapsed += getDeltaTime();
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      let t = (this.elapsed - it.delay) / this.popDuration;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      const eased = this.easeOutBack(t);
      it.obj.getTransform().setLocalScale(vec3.lerp(it.start, it.target, eased));
    }
  }

  private easeOutBack(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
}
