# Track 01: The uncapped session

**Status:** Proposed experiments; no results yet.

How do compaction and content indexing affect a long-lived Pi Durable session across model families? The goal is a session that can continue while its active context remains bounded. Removing content from active context is not the same as deleting history.

## First experiment

Replay the same tool-using tasks across models and compare three policies under matched active-context budgets:

1. A rolling summary.
2. A structured handoff that tracks decisions, evidence and open work.
3. A structured handoff plus an index for retrieving older content when needed.

Use one fixture in which an early fact matters again after compaction, but a later correction supersedes it. Check whether the agent finds the relevant older evidence without reviving stale instructions. Vary elapsed turns and the distance to the correction. Keep tool access and replay inputs fixed.

Measure task success, stale-fact and stale-instruction errors, token use and latency. Score whether evidence survived separately from whether the agent actually verified it before acting. Report results by model family rather than assuming one policy works for all models.
