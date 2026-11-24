# Track 02: The shared filesystem

**Status:** Proposed experiments; no results yet.

What belongs in the context window, and what should live in files that survive session boundaries? Start with one agent and a fresh session, then add multiple users and agents.

## First experiment

Reuse Track 01’s fixture with an older fact and a later correction. Compare a fresh session that has only its compacted handoff with one that can also read selected state from a filesystem. Keep the task and model fixed. Check whether the fresh session recovers the correct decision, what remains open, and provenance for verified facts.

Then test concurrent edits and handoffs with three initial access modes: owner-only, shared project, and read-only. Include conflicts where two people edit the same state, and a revocation case where a previously allowed file also appeared in an index. After revocation, test that newly served retrieval results, cached snippets and summaries respect the current permission boundary. An already disclosed copy cannot be recalled.

Measure continuity, stale-state errors, conflict detection, and unauthorized reads or writes. Do not share a mutable workspace in the initial Track 01 comparison; add it explicitly in this track.
