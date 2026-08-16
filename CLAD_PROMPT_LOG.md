# Brain Dumpd — CLAD Prompt Log

**Project:** Brain Dumpd — a Snap Spectacles (SPECS) AR Lens
**Built with:** CLAD + Claude Code driving Lens Studio via the Lens Studio MCP tools
**Tooling used by the assistant:** Lens Studio MCP (VirtualScene, scene-graphql, asset-graphql, RecompileTypeScript, RunAndCollectLogs, PreviewPanel/screenshots, WorldQuery, IconSelector, GenerateFast3DAssets, KnowledgeBase), TypeScript for all Lens scripts, OpenAI (gpt-4o-mini) via the Remote Service Gateway.

## How the AI-assisted workflow ran

Every feature followed the same loop: I described what I wanted → Claude proposed an approach (and asked focused questions when a decision was mine to make) → it wrote/edited the TypeScript, built the scene through the MCP tools, recompiled, ran the lens, read the runtime logs, and captured preview screenshots to verify before moving on. Data-layer logic (parsing, ring capacity, persistence) was covered with runnable tests. Design directions were chosen from side-by-side options rather than guessed.

Below is a representative, chronological log of the prompts I gave.

---

## Phase 1 — Setup & design

- "Can you access my Lens Studio folder along with the CLAD MCP?"
- "I'm building a SPECS Lens called **Brain Dumpd** for a hackathon — speak an unstructured brain dump, an LLM turns it into tasks with urgency, shown in my space. Produce a design document."
- "Install all the required packages."
- "Which LLM should we use?" → "Lock GPT." → "Overflow policy — option A."
- "Completion behaviour = manual; ASR path = voice ML; placement trigger = pinch to place; immediate for demo snappiness, confirmation as a toggle."

## Phase 2 — Data layer (voice → tasks)

- "I'm done with Snapchat login + token. Implement the data layer only — strict JSON array of tasks, keep the LLM call in its own module."
- "Test it in preview."
- "Harden the parsing layer. Add a local fallback parser, then write and run tests."
- "Yes, do the change to keyword arrays."
- "Implement the ring/column capacity logic as pure functions. Write tests."
- "Update the design doc and wire TaskStore to RingCapacity."
- "Persist all tasks between sessions. Verify with a test."
- "Why is the RSG token blanking that was there at first?"

## Phase 3 — Design pivot (rings → sticky wall)

- "I don't like the rings — what can we redesign it to?"
- "A Calder-style mobile… what do you think of something like this?"
- "I'm not feeling it, give me more design ideas."
- "What I didn't like: urgency = distance, river of time, anti-overwhelm. I liked **sticky notes on your real wall** the most."
- "1. Columns. 2. I'm okay with the colours you suggested. Start building."
- "Update the design doc to the sticky wall."

## Phase 4 — Placement, persistence & interactions

- "Increase the size of the text; the sticky notes aren't attaching to any walls in preview — why?"
- "Lens Studio preview does have real walls we can use."
- "Wire the World Query wall placement now. Also persistence."
- "Can't see NEXT and LATER tags, and the re-anchor button isn't working. At the start the user should see a place-anchor placeholder."
- "Clear my test placement so it starts fresh."
- "I can't drag it to a wall yet… [logs] …[Anchor] placed at (0,5,-100)…"
- "No surface in view even when I'm clearly facing a wall."
- "Wire it to real data and build grab/peel interactions. The clear-cards and reattach-to-a-different-wall buttons are missing."
- "Continue with the buttons and grab/peel." / "Increase the size of the text, change the colour of the buttons."

## Phase 5 — Voice states & mic button

- "Add listening and thinking states. While recording, show a pulsing indicator on the surface that responds to input volume. While waiting on the LLM, show a compact processing state in the same place. Also add a rounded button with a 2D mic that tap/pinch toggles recording."

## Phase 6 — Crumple-to-delete (physics)

- "Is it possible that if I grab a card and throw it or drag it down, it crumples into a ball, drops on the floor, and is deleted?"
- "Build it with physics — and a crumple custom shader if it doesn't take long. Let's discuss."
  - (Chose: real generated crumpled-paper-ball mesh over a vertex shader.)
- "Can the crumpled paper ball be the same colour as the note that's been removed?"

## Phase 7 — Button & toolbar redesign

- "Its perfect. Can we work on how the buttons look now?"
  - (Chose: rounded pill + icon + label.)
- "I want the mic button to be circular. Remove icons from Sweep wall and New wall. Keep icon only for mic (no text)."
- "Make the mic disc smaller and use a smoother circle."
- "The record indicator and LLM-working indicator need to be polished too."

## Phase 8 — Headers, roaming mic & reminders

- "1. The backplates for NOW/NEXT/LATER don't look good — redesign them. 2. The mic should follow me into another room; when I speak elsewhere, notes are made in front of me then fly to the wall with persistence. 3. If a note mentions a time and lands in NOW, can I be reminded?"
  - (Chose: underline-tab headers; full roaming mic + fly-to-board; in-session reminder — Spectacles can't fire notifications while the Lens is closed.)

## Phase 9 — Parsing bug + LLM debugging

- "The texts aren't parsing properly. Nothing goes into LATER, and 'I have a meeting with John tonight at 10:30' forms two different notes."
- "Yes, debug — I've regenerated the tokens now."
  - (Root cause: an expired OpenAI token had been silently falling back to the local keyword parser; regenerating fixed it. Also hardened: normalize "10;30"→"10:30", stop splitting on ";", real LATER detection, tighter prompt.)

## Phase 10 — Context-aware mic & motion polish

- "If I'm in the same room as the persistent wall, the mic sits on the wall like before; if I go to another room, it should come with me."
- "Decrease the size of the following mic button by 30%."
- "Make the notes flying to the wall a bit slower — they should first be generated in front of the user, then fly away."

## Phase 11 — Final fixes, onboarding & docs

- "A few fixes: 1. When the mic is on the wall and I speak, the note is generated twice (one on the wall and one animated from the mic) — the fly-in should only happen when the mic is floating and I'm away from the wall. 2. The 'time mentioned' alarm should last a bit longer and have a sound. 3. Add a start/onboarding screen explaining what does what, before we select the wall. 4. Update the prompt log and project description accordingly."
  - (Discovered a Lens constraint: a Lens can't mix licensed and non-licensed audio — since the mic uses a non-licensed Microphone track, the reminder sound had to be a non-licensed SFX, not a music-library track. Started with the "UI SFX Pack" notification sound, later swapped manually by the creator — see Phase 14.)
- "Make these two documents for me: 1. a CLAD prompt log, 2. a project description."

## Phase 12 — Post-it styling & longer columns

- "1. I want the onboarding to look like a post-it note. 2. The wall-placement placeholder is currently a white plane — make it the onboarding post-it note instead. 3. Increase the column length of Now, Next and Later. 4. Update the project description and prompt log accordingly."
  - (Restyled the onboarding welcome as a tilted yellow sticky note with dark handwriting-style text; swapped the white placement placeholder for a matching yellow post-it that follows your gaze; raised the per-column capacity and dropped the toolbar down so the columns run longer.)

## Phase 13 — Mic visibility, placeholder hint & note spacing

- "1. The mic should be visible only after the wall placement is done. 2. When the user changes the wall, only a blank post-it is visible — can we have 'place on a flat surface' text appear, or redesign the placeholder? 3. The first note on the board overlaps the header underline in all three columns. 4. Update the project description and prompt log."
  - (Mic HUD now scales to zero and hides during onboarding + placement, appearing only once the wall is locked; added a "Place on a flat surface" label to the placeholder post-it; nudged the top of each column down so the first note clears the header underline.)

## Phase 14 — Alarm loop & mic size

- "1. The alert sound should play on loop for the amount of time the note is pulsing. 2. Make the floating mic's size a little smaller. Note: I've changed the sound file manually. Update the docs."
  - (Reminder chime now loops (`play(-1)`) for the full ~8s bounce and is stopped/faded when it ends, instead of playing once; shrank the roaming mic's follow scale from 0.7 to 0.55. The reminder audio clip itself was swapped manually by the creator — the exact sound is whatever is wired into the StickyWall `reminderSound` input.)

---

*This log is a faithful, condensed record of the prompts and the build-verify workflow used with CLAD to create Brain Dumpd.*
