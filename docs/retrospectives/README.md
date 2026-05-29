# Retrospectives

This directory holds one **phase close-out** per FleetCo phase: `phase-1.md`, `phase-2.md`, and so on.

A close-out is **synthesis and handoff**, not a re-narration. `docs/CURRENT_PHASE.md` already carries the detailed, iteration-by-iteration narrative of the active phase; a close-out distils that into the durable cross-phase record a future session needs to pick up cold — what shipped (as an index, with links back to the narrative), the process learnings worth carrying forward, the operational posture (what is genuinely done vs. deferred), the tech-debt carried out of the phase, and — most importantly — the explicit **gate** that must be met before the next phase opens.

The convention exists because the roadmap (`docs/product/roadmap.md`) commits to "we do not start a new phase until the previous one is in daily use." A close-out is where that gate is made concrete and checkable, so neither a human nor an AI agent barrels into the next phase before the current one is genuinely finished.

A close-out is written when a phase is **content-complete** (all its planned slices shipped). It is distinct from a postmortem (`docs/postmortems/`, which is incident-driven) and from the operational measurements in `docs/operations/`. Write it once, then leave it as the point-in-time record; ongoing status lives in `CURRENT_PHASE.md`.
