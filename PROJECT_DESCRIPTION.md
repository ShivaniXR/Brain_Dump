# Brain Dumpd — Project Description

## What I built

**Brain Dumpd** is a hands-free "brain dump" task board for **Snap Spectacles**. You tap or pinch a mic button and just *talk* — a stream of unstructured thoughts — and the Lens turns it into an organized wall of tasks in your real space.

Under the hood:

- **Guided start.** On first run, a floating **yellow post-it note** explains what does what — tap the mic to talk, tasks sort into Now / Next / Later, grab a note to move it or throw it to toss it, mention a time for a reminder — then a tap begins wall placement. While you're picking the spot, the placeholder is a matching sticky note reading **"Place on a flat surface"** that follows your gaze; the mic button only appears once the wall is locked in.
- **Voice → structured tasks.** Speech is transcribed on-device (ASR), then sent to an LLM (**gpt-4o-mini via the Remote Service Gateway**) that extracts each distinct, actionable task with a **title**, an **urgency** (now / next / later), a **category**, and an optional **time**. A hardened local fallback parser keeps it working if the network hiccups.
- **Sticky notes on your real wall.** Tasks appear as color-coded sticky notes — **coral = Now, yellow = Next, blue = Later** — in three labelled columns, placed on an actual wall you pick via World Query, and **persisted across sessions**.
- **Natural interactions.** Grab a note to move it between columns; **throw it or drag it down and it crumples into a physics paper ball** (in its own colour) and drops away, deleting the task. Sweep the wall or re-anchor the board to a new wall with on-board buttons.
- **Alive, legible feedback.** While recording, a **coral halo pulses with your voice volume**; while the LLM thinks, **three dots orbit the mic**; a task with a time shows it and, when that time arrives (while you're wearing the Lens), the note **rings and bounces for several seconds** to get your attention.
- **A mic that goes where you do.** When you're at the board it **docks on the wall**; walk into another room and it **detaches and follows you** (a little smaller), so you can capture a thought anywhere — and a note dumped away from the board **materializes in front of you, then flies to your wall** and persists there.

## How it responds to the weekly theme — Week 1: Organize

> *Build a spatial experience that helps people organize, plan, or be more productive.*

Brain Dumpd takes the messiest possible input — a person thinking out loud — and turns it into a clear, **spatial** plan. You just talk; the LLM **organizes** every scattered thought into a structured task and sorts it into **Now / Next / Later**, and those tasks become physical sticky notes **anchored on your real wall**. That's the spatial experience: your plan lives in the room around you instead of buried in a phone app — sorted by urgency, glanceable, and persistent across sessions.

It hits all three verbs of the theme directly:
- **Organize** — unstructured speech becomes titled, categorized, prioritized tasks on a tidy wall.
- **Plan** — triage across the three urgency columns, and reprioritize just by grabbing a note and moving it (or throwing it away when it's done).
- **Be more productive** — hands-free capture from anywhere in your space, timed reminders that ring when something's due, and a mic that follows you so a thought is never lost.

It's productivity designed for the space around you, not a screen — an ambient, always-available "second brain."

## Who it's for

People who **think out loud** and get overwhelmed by keeping everything in their head — busy knowledge workers, students, parents, and anyone with an ADHD-style flood of "I need to…" thoughts. It's for the moment you have five things to remember and no hands (or patience) to type them: you just say them, and they're organized and waiting on your wall.
