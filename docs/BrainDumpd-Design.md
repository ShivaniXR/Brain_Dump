# Brain Dumpd — Design Document

**Platform:** Snap Spectacles (SPECS), Lens Studio 5.23, Spectacles-only target.
**Concept:** User speaks a stream of unstructured thoughts → an LLM parses them into
discrete tasks with an urgency level → tasks appear as **colour-coded sticky notes** on a
**wall-anchored board** laid out in three columns.

- **Now** — coral column, **max 3 tasks**
- **Next** — yellow column, **max 8 tasks**
- **Later** — blue column, **unbounded**

> **Presentation note:** an earlier design placed tasks on a three-ring "cone" target (and a
> Calder-mobile variant was prototyped); both were dropped for legibility/feel. The current
> presentation is the **Sticky Wall** (§3). The data/logic layers below are unchanged by that
> pivot — only the presentation module differs.

> **Status: substantially built.** Data model, parsing/fallback, capacity engine, persistence,
> and dedup are implemented and unit-tested. The Sticky Wall presentation, the Sweep/New-wall
> buttons, and grab/peel wiring are built and editor-verified. **Device-only (built, not yet
> verified on hardware):** hand-tracking interactions (button pinch, note drag/peel) and real
> wall mapping/relocalization.

---

## 1. Platform grounding (what SPECS gives us)

| Need | SPECS mechanism | Notes |
|---|---|---|
| Voice capture / ASR | **`AsrModule`** (`startTranscribing`/`stopTranscribing`, `onTranscriptionUpdateEvent` with `text`/`isFinal`, `AsrMode.HighAccuracy`) — locked, see §10 | Replaces the now-deprecated `VoiceMLModule` transcription path. Requires microphone permission. |
| LLM call | **Remote Service Gateway (RSG)** → **OpenAI `gpt-4o-mini`** with Structured Outputs (locked, see §10) | Package installed. Fallback: Gemini Flash (one-file swap in `LLMService`). |
| Wall mapping | **Custom Locations** mapping session (`createMappingSession` → `checkpoint`) | Maps the current space to a `LocationAsset` when (re-)anchoring. |
| Data persistence | `PersistentStorageSystem` (key-value, per-Lens, on device) | Stores the task board + the `persistedLocationId` as JSON. |
| Interaction | **SpectaclesInteractionKit** (`Interactable`, `InteractableManipulation`) — installed | Drag notes between columns to re-prioritize; drag a note off the bottom to complete (peel); pressable wall buttons. |
| World-space UI | **SpectaclesUIKit** — installed; Text3D + box/plane meshes | Sticky-note panels, column headers, wall buttons. |
| Spatial persistence | **Custom Locations**: `LocatedAtComponent` + `LocationCloudStorage` (confirmed, see §5.1) | Relocalizes the board's wall across sessions in the same space. |

**Design principle that falls out of this:** *spatial persistence and data persistence are
independent layers.* Task data lives in `PersistentStorageSystem` and always survives; the
spatial anchor is best-effort. If relocalization fails, we re-place an empty target and
re-hydrate tasks onto it — no data is ever lost to a spatial failure.

---

## 2. Data model

A task carries **two placement concepts** that must stay separate:

- `urgency` — what the LLM inferred the user *meant* (now / next / later).
- `ring` — where the task *actually landed* after capacity + overflow rules.

> **Terminology:** `ring` is the code/data name for the tier a task sits in (`Ring` type,
> `ring` field, `RingCapacity`), kept from the earlier ring design. In the Sticky Wall a task's
> `ring` is simply which **column** it's in — Now / Next / Later.

They differ whenever a tier is full. Keeping both lets the UI explain "you said this was
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

Controllers initialize before dependents (Lens Studio execution order). The board is parented
under the wall anchor so it relocalizes with the room.

```text
Scene
├── BrainDumpd                    ASR capture + LLM commit            [BrainDumpController]
│   └── RemoteServiceGatewayCredentials   RSG API token (must be present + filled)
├── AnchorController             Custom Locations map/save/relocalize; publishes anchor state
├── StickyWall                    board root, anchored to the wall     [StickyWallController]
│   ├── WallBackdrop              editor stand-in for the real wall (a flat panel)
│   ├── H_now / H_next / H_later  column headers ("NOW" / "NEXT" / "LATER")
│   ├── NoteTemplate              disabled; cloned per task (group: "Quad" + "Label")
│   ├── SweepButton               "Sweep wall" → clear board          [WallButton action=clear]
│   ├── NewWallButton             "New wall"   → re-anchor             [WallButton action=reanchor]
│   └── (note clones)             one per visible task, created at runtime
└── Camera / SIK rig              (from Specs Base Template)
```

**Board layout:** three vertical columns at fixed x (Now −42 / Next 0 / Later +42 cm); notes
stack downward (~20 cm step). Each note is a small coloured box (~26×16 cm) with a Text3D
label and a small random tilt (±4°) so it reads as hand-placed. Notes are cloned from
`NoteTemplate` with `copyWholeHierarchy` at render time, coloured by ring (coral/yellow/blue),
and titled from the task at runtime. Two teal wall buttons sit along the bottom. The board sits
~100 cm from the user.

**Cross-cutting singletons** (ES-module, not scene objects): **`TaskStoreProvider`** (the shared
persistent `TaskStore`) and **`AnchorStateProvider`** (anchor state + a re-anchor command channel
from the "New wall" button to `AnchorController`).

---

## 4. Script modules & responsibilities

1. **BrainDumpController** (`BrainDumpController.ts`) — voice front end. Pinch/tap toggles ASR
   (`AsrModule`), accumulates the transcript, sends it to `LLMService`, and commits the resulting
   tasks to the shared `TaskStore` (`makePlacedTask` → `addAll`). Editor-only `simulateDump` flag
   injects a canned transcript through the real pipeline for mic-free testing.
2. **LLMService** (`LLMService.ts`) — `TaskExtractor` interface + `OpenAITaskExtractor` (gpt-4o-mini
   via RSG, Structured Outputs). The provider swap point; nothing else touches RSG.
3. **TaskParsing** (`TaskParsing.ts`) — **pure** hardened parse: fence-stripping, strict
   `parseModelResponse`, the local keyword **fallback parser**, and `extractTasksWithFallback`
   (8 s timeout → fallback). Unit-tested (`BrainDumpTests.ts`, 15 cases).
4. **RingCapacity** (`RingCapacity.ts`) — **pure** capacity engine (unit-tested): `placeParsedBatch`
   (fresh-parse overflow), `promote` / `insertWithDisplacement` (displacement + cascade), helpers
   (`countOn`, `isFull`, `longestSittingOn`, `outwardRing`). Generic over any `RingItem`. ("Ring"
   here = the three tiers = the three columns.)
5. **TaskStore** (`TaskStore.ts`) — single source of truth. Active board + completed list;
   `add`/`addAll` (with **dedup**), `promote`, `complete`, `getByRing`, `clear`, `describe` (sorted
   log dump), `onChange`. **Delegates all placement to RingCapacity.** **Persists** the full board
   to an injectable `KeyValueStore` (Lens `PersistentStorageSystem` by default) on every mutation,
   auto-loading on construction (verified by `PersistenceTests.ts`). Shared via `TaskStoreProvider`.
6. **StickyWallController** (`StickyWallController.ts`) — presentation. Subscribes to `TaskStore`
   and anchor-state changes; clones a note per task into its column, colours it, titles it, tilts
   it, and slaps it on (staggered easeOutBack). Adds each note's grab/peel interactivity
   (`Interactable` + `InteractableManipulation`): drop in a column → `promote`; drag off the
   bottom → `complete`. Caps each column (Now 3 / Next 5 / Later 5) with a "+N more" token.
7. **AnchorController** (`AnchorController.ts`) — Custom Locations map/save/relocalize; publishes
   `located`/`searching`/`unlocated` via `AnchorStateProvider`; `reAnchor()`; device calls guarded
   behind `isEditor()`. Editor keys C/A/R for testing.
8. **WallButton** (`WallButton.ts`) — a pressable SIK button (runtime collider + `Interactable`);
   `action: "clear" | "reanchor"`. Used for the Sweep-wall and New-wall buttons.

Clean separation to protect: **capacity/placement lives only in `RingCapacity` (pure,
unit-tested); `TaskStore` is a thin stateful wrapper; `StickyWallController` is pure presentation.**
The scene layer never re-implements placement rules.

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

### 5.2 Reload, relocalization & display behavior (confirmed)

Placement (which column a task belongs to) is always computed by `RingCapacity`. What differs by
branch is *display*:

- **Same room** (`onFound`): the three columns show on the anchored wall; notes **slap on**
  (staggered scale-in with a small overshoot) as they render.
- **New/different room** (anchor retrieved but never `onFound`): the Next/Later columns + their
  headers are hidden; only the **Now** notes (≤3) show as a portable set in front of the user.
  Next/Later tasks still exist in the store — they reappear once the board is (re-)anchored.
- **Re-anchor** ("New wall" button): maps the current space, stores a fresh `LocationAsset`, saves
  the new id, and the full board re-displays on the new wall.

**Animation:** notes scale in from near-zero with an easeOutBack overshoot, staggered. Owned by
`StickyWallController` (pure presentation).

### 5.3 Implementation status

- **`AnchorController`** — built. Loads a saved `persistedLocationId` → `retrieveLocation` →
  `LocatedAtComponent`; `onFound` → `located`, an 8 s timeout → `unlocated`. `reAnchor()` maps the
  space (`createMappingSession` → `checkpoint`) → `storeLocation` → saves id → `located`. Device calls
  guarded behind `isEditor()`. State + re-anchor command via **`AnchorStateProvider`**.
- **`StickyWallController`** — built; branches on anchor state (located/searching = all columns;
  unlocated = Now-only). Data-driven from `TaskStore`, with grab/peel interactivity per note.
  Editor-verified: rendering, live updates, columns/colours, entrance, and no-error init of the
  interactivity.
- **Sweep-wall / New-wall buttons** (`WallButton`) — built; init-verified. Editor keys C / R are
  fallbacks for clear / re-anchor.
- **DEVICE-ONLY, not yet verified:** mapping / relocalization / cloud store; button **pinch**; and
  note **drag/peel** — all require hand tracking or real space (the preview-interactor package isn't
  installed).

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

**Display caps (Sticky Wall):** distinct from the capacity rules above, each **column** shows at
most a few notes (Now 3 / Next 5 / Later 5); extra tasks collapse into a **"+N more"** token at the
bottom of the column so the wall stays legible. Overflow/displacement is conveyed by notes
re-rendering into their actual column; a dedicated "flash in intended column, then slide out" cue
is future polish, not yet built.

**Freeing slots on completion:** completing a Now/Next task removes it and frees a slot, but does
**not** auto-promote (locked: manual). Promotion is the explicit user action that triggers
mechanism B above.

**Edge cases to specify:**
- Empty utterance / LLM returns zero tasks → no-op with a gentle "nothing to add" toast.
- One utterance yields more tasks than total remaining capacity → excess flows to Later
  (which is unbounded), so nothing is dropped.
- Duplicate titles → **deduped** (`TaskStore.addAll` skips a task whose normalized title already
  exists on the active board; completed tasks can recur). LLM rephrasings still slip through —
  semantic dedup is a future enhancement.

---

## 7. Failure modes

| # | Failure | Trigger | Mitigation |
|---|---|---|---|
| F1 | **ASR mis/no transcription** | Loud venue, accent, mic permission denied, no network for cloud ASR | Show live interim transcript so the user sees errors; allow re-record; on-device fallback path. |
| F2 | **LLM failure** | Timeout, RSG quota exhausted, malformed/hallucinated JSON, over/under-splitting | **Structured Outputs (`strict` json_schema) makes schema-valid JSON the guaranteed common case.** Hardened path (`TaskParsing.ts`): 8s timeout cap + a **local keyword fallback parser** that runs on any failure (reject/timeout/empty/truncated/fenced-broken/wrong-shape) — splits the transcript on sentence/conjunction boundaries and assigns urgency by keyword, so a task list is always produced. Markdown fences are stripped; validation drops bad entries. Covered by an 8-case suite (`BrainDumpTests.ts`). |
| F3 | **Anchoring failure** | No wall hit, poor lighting, sparse features, wall too far, drift | Guided placement + distance/normal checks; re-place flow; data decoupled from anchor. |
| F4 | **Persistence failure** | Schema change between builds, corrupt JSON, anchor lost across rooms | `schemaVersion` + defensive parse; data survives anchor loss; never throw on load. |
| F5 | **Capacity confusion** | Task lands in an outer column unexpectedly | Column headers + live counts; overflow "+N more" token; (flash-then-slide cue is future polish). |
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
5. **FOV / ergonomics** — narrow FOV means the board and its note text must be deliberately
   sized and placed, not assumed.

Comparatively low risk: key-value persistence of task data and rendering the sticky notes.
(SIK interactions moved *up* in risk once we committed to per-note drag/peel — device-only.)

---

## 9. Build order (largely executed)

> Steps 1–5 below are essentially done. The layer order held up; the presentation module was
> rebuilt twice (rings → mobile → Sticky Wall) without touching the data/logic layers, which
> validates the separation. Remaining work is the on-device pass (§5.3) and polish.

1. **Skeleton with fake data** — scene hierarchy + presentation driven by hardcoded tasks,
   proving layout/capacity/entrance with zero external dependencies. *(Done — now the Sticky Wall.)*
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

- **Presentation: LOCKED → Sticky Wall** (pivoted 2026-08-14 from the three-ring "cone"; a
  Calder-mobile variant was also prototyped and dropped). Colour-coded sticky notes in Now/Next/Later
  columns on a wall-anchored board; slap-on entrance; drag-to-column re-prioritize; drag-off-to-complete.
  Reason: legibility (rings couldn't fit 8 Next cards) and a grounded, tactile feel.
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
- **Placement / re-anchor: LOCKED → "New wall" button → mapping session.** Pressing New wall maps
  the current space (`createMappingSession` → `checkpoint`) and stores the `LocationAsset`; there is no
  separate raycast-and-pinch placement step — the board anchors wherever you map it. Editor key R is
  the dev fallback.
- **Confirm-before-commit: LOCKED → immediate commit** for demo snappiness — parsed tasks slap
  straight onto the wall. (A confirm-before-commit toggle remains a possible off-by-default option
  for noisy-venue safety / F1 + F2; not currently built.)
