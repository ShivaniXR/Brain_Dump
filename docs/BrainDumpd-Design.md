# Brain Dumpd — Design Document

**Platform:** Snap Spectacles (SPECS), Lens Studio 5.23, Spectacles-only target.
**Concept:** User speaks a stream of unstructured thoughts → an LLM parses them into
discrete tasks with an urgency level → tasks are placed on a wall-anchored *target*
made of three concentric rings that form a shallow cone protruding toward the user.

- **Now** — centre disc, protrudes furthest toward the user, **max 3 tasks**
- **Next** — middle ring, **max 8 tasks**
- **Later** — outer ring, sits nearly on the wall, **unbounded**

> Status: DESIGN ONLY. No code is written yet. API names marked *(verify)* should be
> confirmed against `Support/*.d.ts` and the Lens Studio knowledge base (needs Snapchat
> login) before implementation. The architecture does not depend on those exact names.

---

## 1. Platform grounding (what SPECS gives us)

| Need | SPECS mechanism | Notes |
|---|---|---|
| Voice capture / ASR | **`AsrModule`** (`startTranscribing`/`stopTranscribing`, `onTranscriptionUpdateEvent` with `text`/`isFinal`, `AsrMode.HighAccuracy`) — locked, see §10 | Replaces the now-deprecated `VoiceMLModule` transcription path. Requires microphone permission. |
| LLM call | **Remote Service Gateway (RSG)** → **OpenAI `gpt-4o-mini`** with Structured Outputs (locked, see §10) | Package installed. Fallback: Gemini Flash (one-file swap in `LLMService`). |
| Wall detection | **World Mesh** + **Depth / World Query** raycast | Gives hit point + surface normal for a vertical plane. |
| Spatial persistence | **Spatial Anchors** (`AnchorModule` / `AnchorComponent`) *(verify names)* | Relocalizes an anchor across sessions in the same mapped space. |
| Data persistence | `PersistentStorageSystem` (key-value, per-Lens, on device) | Store the task list as JSON. |
| Interaction | **SpectaclesInteractionKit** (pinch, direct/indirect manipulation) — installed | Grab/move cards, pinch-to-complete. |
| World-space UI | **SpectaclesUIKit** — installed; Text + mesh components | Ring visuals, labels, HUD. |

**Design principle that falls out of this:** *spatial persistence and data persistence are
independent layers.* Task data lives in `PersistentStorageSystem` and always survives; the
spatial anchor is best-effort. If relocalization fails, we re-place an empty target and
re-hydrate tasks onto it — no data is ever lost to a spatial failure.

---

## 2. Data model

A task carries **two placement concepts** that must stay separate:

- `urgency` — what the LLM inferred the user *meant* (now / next / later).
- `ring` — where the task *actually landed* after capacity + overflow rules.

They differ whenever a ring is full. Keeping both lets the UI explain "you said this was
urgent, but Now was full, so it's in Next."

```ts
type Ring = "now" | "next" | "later";

interface Task {
  id: string;              // uuid, generated on creation
  text: string;            // concise task text from the LLM
  rawSource?: string;      // original phrase span, for debugging / undo
  urgency: Ring;           // LLM-inferred intent
  ring: Ring;              // actual placement after overflow rules
  status: "active" | "done";
  createdAt: number;       // epoch ms
  completedAt?: number;
  enteredAt: number;       // monotonic stamp for when it entered its current ring
                           //   (lower = longer-sitting; drives displacement victim choice)
  localPose?: {            // set only if the user manually moved the card
    pos: [number, number, number];
    rot: [number, number, number, number];
  };
}

interface PersistState {
  schemaVersion: number;   // bump on shape changes; enables migration
  tasks: Task[];
  anchorRef?: string;      // handle/id to reload the spatial anchor
}
```

---

## 3. Scene hierarchy

Managers sit at the top of the hierarchy so they initialize before anything that depends on
them (per Lens Studio execution order). The target is parented under the anchor so it moves
with relocalization.

```text
Scene
├── Managers                      (empty SceneObject, top of hierarchy)
│   ├── AppController             state machine + wiring
│   ├── VoiceCaptureController    ASR start/stop, interim/final transcript
│   ├── LLMService                RSG call + JSON parse/validate
│   ├── TaskStore                 source of truth, capacity rules, persistence
│   └── AnchorController          wall raycast, anchor create/save/load
│
├── WallAnchor                    (holds AnchorComponent; pose set at placement)
│   └── TargetRoot                cone origin, oriented to face the user
│       ├── NowRing               centre disc; large +Z offset (toward user)
│       │   └── SlotContainer     ≤ 3 card slots
│       ├── NextRing              middle ring; medium +Z offset
│       │   └── SlotContainer     ≤ 8 card slots
│       └── LaterRing             outer ring; ~0 offset (near wall)
│           └── SlotContainer     unbounded (radial/scrolling layout)
│
├── TaskCardPrefab                instantiated per task (pooled)
├── HUD                           "listening…", "thinking…", counts, error toasts
└── Camera / SIK rig              (from Specs Base Template)
```

**Cone geometry:** the target is wall-anchored, so the wall is behind the target and the
apex points at the user. `NowRing` gets the largest forward (+Z, toward user) offset;
`LaterRing` sits nearly flat on the wall. Suggested starting values (tune against FOV):
Now +6 cm, Next +3 cm, Later 0 cm off the wall plane; ring radii ~8 / 18 / 30 cm; whole
target placed ~150–200 cm from the user.

---

## 4. Script modules & responsibilities

1. **AppController** — finite state machine and the only place transitions live:
   `Idle → Anchoring → Ready → Listening → Transcribing → Parsing → Placing → Ready`,
   with an `Error` branch off any state that returns to `Ready`. Wires events between
   modules; owns nothing else.
2. **VoiceCaptureController** — starts/stops listening, emits `onInterim(text)` and
   `onFinal(text)`. Handles mic permission, end-of-utterance (silence) detection, and a
   hard max-duration cap.
3. **LLMService** — turns a final transcript into `Task[]`. Builds a strict prompt (schema +
   few-shot), calls RSG, validates/repairs the returned JSON, enforces a max-tasks-per-
   utterance cap, and surfaces timeout/quota/parse errors as typed failures.
4. **RingCapacity** (`RingCapacity.ts`) — **pure** capacity engine (no engine deps, unit-tested):
   `placeParsedBatch` (fresh-parse overflow), `promote` / `insertWithDisplacement` (displacement +
   cascade), and helpers (`countOn`, `isFull`, `longestSittingOn`, `outwardRing`). Generic over any
   `RingItem` so it preserves the caller's extra fields.
5. **TaskStore** — single source of truth. Holds the active board + completed list; `add`/`addAll`,
   `promote`, `complete`, `getByRing`, `clear`. **Delegates all capacity/placement to RingCapacity.**
   **Persists** the full board (active + completed, incl. each task's `ring`, `enteredAt`, and
   completion state) to an injectable `KeyValueStore` — the Lens `PersistentStorageSystem` by
   default — auto-saving on every mutation and auto-loading on construction, so a fresh session
   restores the previous board identically (verified by `PersistenceTests.ts`). No rendering logic.
6. **RingLayoutController** — subscribes to `TaskStore` changes; positions cards into ring
   slots, applies the cone Z-depths, and animates entries/exits and overflow/displacement.
7. **AnchorController** — wall raycast against World Mesh, create/save/load the spatial
   anchor, parent `TargetRoot`, and drive the re-place flow.
8. **TaskCard** (on prefab) — renders text + urgency colour; pinch-to-complete; optional
   grab-to-move between rings via SIK.

Clean separation to protect: **capacity/placement logic lives only in `RingCapacity` (pure,
unit-tested); `TaskStore` is a thin stateful wrapper over it; `RingLayoutController` is pure
presentation.** The scene layer never re-implements placement rules.

---

## 5. Wall anchoring & persistence strategy

**Placement (first run):**
1. User faces a wall; a pinch triggers placement.
2. Raycast camera-forward against World Mesh / Depth → hit point + surface normal.
3. Reject if no hit, hit too close/far, or normal isn't roughly vertical (guided retry).
4. Orient `TargetRoot` so its forward faces the user and its plane is parallel to the wall.
5. Create a **Spatial Anchor** at that pose; store its ref in `PersistState.anchorRef`.

**Across sessions:**
- On launch, attempt to reload + relocalize the anchor from `anchorRef`; on success, parent
  `TargetRoot` to it and re-hydrate cards.
- Task data (`PersistState.tasks`) loads from `PersistentStorageSystem` **regardless** of
  anchor success.
- If relocalization fails (new room, mapping lost), enter the **re-place flow**: keep all
  task data, ask the user to pinch a new wall, mint a fresh anchor, re-lay-out the same tasks.

**Why decoupled:** relocalization is the single most environment-sensitive step; binding task
survival to it would make a failed demo also a data-loss demo. Separating them means the worst
spatial outcome is "re-place the target," not "lost my brain dump."

**Schema migration:** `schemaVersion` is checked on load; unknown/newer versions fall back to
a defensive parse that drops unrecognized fields rather than throwing.

### 5.1 SPECS anchor API (confirmed)

Uses **`LocatedAtComponent`** (attaches `TargetRoot` to a real-world `LocationAsset`; fires
`onFound` when the space relocalizes, `onLost` when it drops) + **`LocationCloudStorage`**
(`storeLocation` → `persistedLocationId`; `retrieveLocation(id)` → the map next session). The
`persistedLocationId` is saved next to the tasks in `PersistentStorageSystem`. Caveats: cloud-
backed (network dependency, ties into F3); relocalization is **device-only** — it cannot be
verified in the editor preview.

### 5.2 Reload, relocalization & fly-in behavior (confirmed)

Placement (which ring each task belongs to) is always computed by `RingCapacity`. What differs by
branch is *display*:

- **Same room** (`onFound`): rings appear on the anchored wall; every card spawns floating in
  front of the user and **flies (staggered) to its ring slot** (Now→centre, Next→middle, Later→outer).
- **New/different room** (anchor retrieved but never `onFound`): the wall rings are not shown.
  - **Now cards float in front of the user** — a portable stack (≤3) that travels with them.
  - **Next/Later cards are hidden** — they exist only on the rings in the anchored room.
  - A **fresh brain dump in a new room**: new **Now** cards stay (join the floating stack); new
    **Next/Later** cards **fly off and disappear** (they belong to the wall in the old room).
- **Re-anchor:** a button beside the target re-attaches the rings to a new wall (mints a fresh
  `LocationAsset`, stores it, saves the new id). After re-anchoring, all cards display on the new wall.

**Animation:** cards always originate in front of the user; staggered timing; easing at
implementer's discretion. Owned by `RingLayoutController` (pure presentation).

---

## 6. Capacity & overflow behavior

Capacities: **Now ≤ 3, Next ≤ 8, Later ∞.** The LLM sets `urgency`; the placement engine sets
`ring`. Implemented as pure functions in `RingCapacity.ts` (unit-tested), which `TaskStore`
delegates to. **Two distinct mechanisms** apply depending on how a task arrives:

**A. Fresh parse (a batch of newly parsed tasks) — overflow, no displacement.**
- Each task fills its `urgency` ring in the LLM's own order; if that ring is full, it overflows
  to the next outer ring (Now→Next→Later). `urgency` is preserved; only `ring` changes.
- Existing tasks are **never** displaced by a fresh parse — new tasks flow around them.
- So a parse returning **more than 3 "now" tasks keeps the first 3 in Now (LLM order) and puts
  the remainder in Next**; likewise Next overflows to Later.

**B. Promotion (a single task moved inward into a possibly-full ring) — displacement + cascade.**
- If the target ring is full, the task that has been **sitting there longest is displaced
  outward one ring**. This cascades: promoting into a full Now displaces Now's longest-sitting
  task into Next, and if Next is also full, its longest-sitting task into Later. Later is uncapped,
  so the cascade always terminates.
- "Longest-sitting" is defined by `enteredAt` — a monotonic stamp set when a task enters its
  current ring; a displaced task gets a fresh stamp, becoming the newest occupant where it lands.

Overflow/displacement must be *visible*: briefly flash the task in its intended ring, then animate
the movement, so the user understands why "urgent" landed in Later (or why a Now card slid out).

**Freeing slots on completion:** completing a Now/Next task removes it and frees a slot, but does
**not** auto-promote (locked: manual). Promotion is the explicit user action that triggers
mechanism B above.

**Edge cases to specify:**
- Empty utterance / LLM returns zero tasks → no-op with a gentle "nothing to add" toast.
- One utterance yields more tasks than total remaining capacity → excess flows to Later
  (which is unbounded), so nothing is dropped.
- Duplicate/near-duplicate text → allowed by default (dedup is a stretch; risky to over-merge).

---

## 7. Failure modes

| # | Failure | Trigger | Mitigation |
|---|---|---|---|
| F1 | **ASR mis/no transcription** | Loud venue, accent, mic permission denied, no network for cloud ASR | Show live interim transcript so the user sees errors; allow re-record; on-device fallback path. |
| F2 | **LLM failure** | Timeout, RSG quota exhausted, malformed/hallucinated JSON, over/under-splitting | **Structured Outputs (`strict` json_schema) makes schema-valid JSON the guaranteed common case.** Hardened path (`TaskParsing.ts`): 8s timeout cap + a **local keyword fallback parser** that runs on any failure (reject/timeout/empty/truncated/fenced-broken/wrong-shape) — splits the transcript on sentence/conjunction boundaries and assigns urgency by keyword, so a task list is always produced. Markdown fences are stripped; validation drops bad entries. Covered by an 8-case suite (`BrainDumpTests.ts`). |
| F3 | **Anchoring failure** | No wall hit, poor lighting, sparse features, wall too far, drift | Guided placement + distance/normal checks; re-place flow; data decoupled from anchor. |
| F4 | **Persistence failure** | Schema change between builds, corrupt JSON, anchor lost across rooms | `schemaVersion` + defensive parse; data survives anchor loss; never throw on load. |
| F5 | **Capacity confusion** | Task lands in an outer ring unexpectedly | Overflow flash-then-cascade animation; ring labels + live counts. |
| F6 | **Performance / thermal** | Continuous ASR + world mesh + many text meshes + animations | Cap task count; pool cards; disable world mesh after anchor is set; throttle updates; no per-frame allocation. |
| F7 | **Latency UX** | speak→ASR→LLM→place is several seconds | Staged feedback (listening → thinking → placing); never a silent gap. |
| F8 | **FOV / legibility** | Narrow SPECS FOV; small/distant text | Size target to FOV; readable font sizes; comfortable placement distance; keep Now inside central view. |

---

## 8. Highest-risk parts on SPECS specifically

Ranked, with the reasoning that they are *both* central to the concept *and* SPECS-specific:

1. **LLM round-trip via Remote Service Gateway** — the heart of the concept and the most
   failure-prone: network dependency, token quota, latency, and JSON reliability. RSG isn't
   installed yet and needs token setup. **De-risk first, in isolation.**
2. **Persistent wall anchoring / relocalization** — powerful but environment-sensitive;
   demoing in an unmapped space is a classic hackathon face-plant. Mitigated structurally by
   decoupling data from the anchor, but the *placement* UX still needs to be solid.
3. **Voice capture in a noisy venue** — ASR quality degrades exactly where a hackathon is
   loudest. Interim-transcript feedback + re-record is the safety net.
4. **Performance / thermal budget** — continuous perception + world-space text + animation on
   a thermally constrained device. Cap counts and shut down world mesh after anchoring.
5. **FOV / ergonomics** — narrow FOV means the three-ring target and its text must be
   deliberately sized and placed, not assumed.

Comparatively low risk: SIK interactions, key-value persistence of task data, and rendering
the ring meshes.

---

## 9. Recommended de-risking / build order (for when we build)

1. **Skeleton with fake data** — scene hierarchy, three rings at cone depths, `TaskStore` +
   `RingLayoutController` driven by hardcoded tasks. Proves layout, capacity, overflow
   animation with zero external dependencies.
2. **RSG spike (isolated)** — one script: hardcoded transcript string → RSG → validated
   `Task[]` printed to log. Proves the riskiest dependency before it's entangled in the app.
3. **Anchor spike (isolated)** — place + save + relocalize a single cube on a wall across a
   restart. Proves spatial persistence independently.
4. **Voice spike (isolated)** — `AsrModule` interim + final transcript to the HUD.
5. **Integrate** along the state machine, then persistence, then polish (overflow animation,
   completion, ergonomics).

Each spike is throwaway and independent, so a failure in one doesn't block the others.

---

## 10. Decisions to lock before building

- **Capacity policy: LOCKED → hybrid (revised 2026-08-13; supersedes the earlier "Option A only").**
  Two mechanisms (implemented + unit-tested in `RingCapacity.ts`, see §6):
  **(A) Fresh parse → overflow, no displacement** — tasks fill their urgency ring in LLM order and
  overflow outward past full rings; existing tasks are never bumped; >3 "now" keeps the first 3 in
  Now and puts the rest in Next.
  **(B) Promotion into a full ring → displace the longest-sitting occupant outward, cascading**
  Now→Next→Later (later uncapped). Victim chosen by `enteredAt`.
  Completion is manual (no auto-promote). Overflow/displacement must be *visible* (flash, then animate).
- **Completion behavior: LOCKED → manual promotion.** Completing a Now/Next task removes it
  and frees a slot; the slot stays empty until the user explicitly grabs a card into it.
  Placement stays stable and predictable — no surprise auto-promotions. Auto-promote is a
  post-hackathon toggle, not built.
- **LLM transport & model: LOCKED → OpenAI `gpt-4o-mini` via Remote Service Gateway, using
  Structured Outputs (`response_format: json_schema`, `strict: true`).** Chosen because the
  task is extraction/classification (not reasoning), the mini tier keeps latency low (F7),
  and Structured Outputs *guarantees* schema-valid JSON, largely eliminating F2's parse/repair
  loop. **Fallback: Google Gemini Flash** if 4o-mini latency disappoints on-device or the RSG
  OpenAI quota runs dry — `LLMService` isolates transport so this is a one-file swap.
  DeepSeek rejected (no upside, weakest JSON guarantees).
- **ASR path: LOCKED → `AsrModule`** (migrated from VoiceML on 2026-08-13). Session model:
  `startTranscribing(options)` / `stopTranscribing()`, with `onTranscriptionUpdateEvent`
  (`text` + `isFinal`) driving accumulation and the live HUD (F1 mitigation), and
  `onTranscriptionErrorEvent` surfacing `AsrStatusCode`. Options: `AsrMode.HighAccuracy`,
  `silenceUntilTerminationMs = 3000` (tolerate thinking pauses in a brain dump — tune down for
  snappier end-of-speech). **Reason for change:** VoiceML's transcription API is deprecated in
  Lens Studio 5.23 ("will stop functioning in an upcoming version"); `AsrModule` is the
  supported forward path and is what SpectaclesUIKit's `VoiceInputProvider` uses internally.
- **Placement trigger: LOCKED → pinch-to-place.** User faces a wall and pinches (SIK) to
  confirm placement; the raycast/normal checks in §5 gate a valid wall before the anchor is
  minted. Gives the user control over exactly where the target lands.
- **Confirm-before-commit: LOCKED → immediate commit** for demo snappiness — parsed tasks fly
  straight to the rings. A confirm-before-commit **toggle** is built in as an off-by-default
  option (useful for noisy-venue safety / F1 + F2), but the default path is immediate.
