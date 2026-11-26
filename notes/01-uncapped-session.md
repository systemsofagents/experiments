# Track 01: The uncapped session

**Status:** Proposed experiments; no results yet.

The goal is a long-lived session that continues to make progress while active model context stays bounded. [Concepts](../CONCEPTS.md) separates the working context from durable history and archival retrieval. We want to measure two different properties in Pi Durable, not assume one mechanism solves both.

## Experiment 01A: How far does compaction extend effective context?

**Hypothesis:** On some workloads, a 250K working window with repeated compaction can support comparable task quality and instruction-following to a full-history run on the same ~1M-context model.

### Paired comparison

- **Full history:** disable compaction and retain the entire trajectory within the model's usable input budget. Size the workload to fit after reserving space for output/reasoning and tool-return growth.
- **Bounded working context:** use the same model, tools, task stream, environment snapshot, and action limits. Compact at 250K rendered input tokens. Fix the summarizer, cut policy, and budgets for summary and recent verbatim tail. Log actual prompt size and compaction overshoot, not just configured thresholds.
- **Both arms:** archive search and replay off. Use some tasks where progress is recoverable from the workspace and others where critical user corrections and constraints exist only in the transcript. Hold tool access and evaluation conditions fixed. Use matched checkpoints of the task stream for boundary-level comparisons and separate end-to-end rollouts to catch differences in behavior after the cut.

### What to measure

Predefine a quality margin for task success and for correct actions on user constraints. Compare paired tasks and repeat enough runs to report uncertainty. Do not treat non-significance as equivalence. Score both endpoints separately. Probe whether the agent follows the latest correction, carries unresolved decisions forward, preserves prohibited actions as constraints, and avoids repeating settled work. Measure at each pre/post-cut checkpoint and after several more turns. Report failures and invalid submissions, not only scores on completed runs.

Track peak actual context, cumulative unique history, cached and uncached input, compaction calls, token cost, and median and tail wall-clock latency. An operational definition of **effective context** is the longest equivalent amount of raw history that stays within the prespecified quality margin on both endpoints.

First run **1M full-history vs. 250K compacted**. Then sweep **125K / 250K / 500K** thresholds on the same workload. Separately predefine **0 / 1 / 2 / 4 / 8** cuts at matched milestones to distinguish cycle count from task length. Record summary and tail sizes, token counters, cut placement, and the actual cycle count. Hold the policy constant for the threshold sweep. Compare structured checkpoints and provider-native compaction only after establishing the rolling-summary baseline.

### Closest prior work

- [Benchmarks Are Surprisingly Compaction-Friendly](https://arxiv.org/html/2610.31778#S4): on two 1M-context models, benchmark task scores were broadly stable across 160K–380K triggers. At 160K, Opus 4.6 averaged 4.9 cuts and GPT-5.4 averaged 15.1. ProgramBench lost about one of three task rules in the first summary on average, with omissions increasing across cuts. Workspace-backed tasks can mask these losses. It lacks the 1M uncompacted control.
- [Microsoft CompactionBench](https://www.preprints.org/manuscript/202611.0780): compares repeated compaction at 50% and 90% of input headroom after reserving output. On GPT-5.6 Sol, early synchronous compaction averaged 3.35 passes; the later setting averaged 1.10. Progressive, asynchronous summaries preserve a cacheable prefix and improved quality and cost on that workload. Append-only summaries still consume window space.
- [Compact-Bench](https://arxiv.org/html/2610.31710): the paired same-environment task continuation is a useful control. It also analyzes up to four real compactions, but only six production sessions had scorable details at the third boundary and one at the fourth. That cannot establish a universal reliability limit.
- [CompAct-Bench](https://arxiv.org/html/2611.25673): tests one cut at a time from a fixed environment snapshot with a matched action limit. Useful failure categories include lost progress, repeated work and mistaking tentative information for settled evidence. It is not a repeated-cycle benchmark.
- [ACON](https://proceedings.mlr.press/v306/kang26b.html) provides an optimized compression baseline for past interactions and incoming tool observations; it is not a direct test of effective context across repeated Pi compactions.

The closest evidence suggests small working windows can preserve some outcomes even when instruction-following deteriorates. None of these studies is the exact same-model, same-workload 1M-versus-250K comparison with archive access disabled. A one-shot compression score or long-context retrieval score does not answer the repeated-cycle question.

## Experiment 01B: Can an archive recover what working context loses?

Once a compaction policy is fixed, vary the archive system separately. Run the same tasks with recall disabled, structured handoff without recall, and that same structured handoff with bounded history-search and exact-entry retrieval. Use the matched handoff pair to isolate the contribution of retrieval. Keep archive access and scope explicit.

Start with a fixture where an early fact matters later, a subsequent correction supersedes part of it, and the agent must act and cite evidence after the old turns are out of context. Vary age, number of updates, and distance from the correction. Score whether the agent recognizes the need to retrieve, finds the authoritative source, applies the current instruction, and avoids reviving stale data. Record retrieval cost and latency separately. Compare indexing and retrieval methods after the small fixture works.
