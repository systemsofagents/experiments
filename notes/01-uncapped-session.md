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

### Start with evidence navigation, not another memory summary

Treat the durable session as a streaming timeline, with a stable entry ID, session/branch scope, sequence number, authorship and recorded time for each event. A tool call and its result belong to the same exchange. Parent IDs and the branch head identify which path is visible. Maintain a chronological index and a rebuildable [SQLite FTS5](https://www.sqlite.org/fts5.html) index over original visible text. Derived search keys may improve discovery, but should never replace source entries. Apply branch and permission filters before scoring or returning results, and make access disappear on delete or trim. Distinguish when a statement was recorded from when it applied. Support explicit supersession links when available; don't infer that a later mention automatically overrides an earlier instruction.

Begin with the two read-only tools already sketched in the [session context spec](../specs/pi-session-context.md):

- **`history_search(query, after?, before?, limit?, cursor?)`** returns short excerpts, stable entry IDs, source/role and recorded time. The harness binds branch scope, pages results, and bounds result size. Use the optional date range only when it follows from the request; if a narrow search is empty, relax it or try alternate terms.
- **`history_get(entry_id, before?, after?, max_tokens?)`** opens the original entry plus bounded neighbors or the corresponding tool exchange. Return source IDs, provenance, and explicit truncation. A search hit is a lead, not authority to act. Find the correction or effective state before using an old decision; cite the original rather than the snippet.

### What to test

- **Need vs. discovery vs. use:** hold the compactor constant and compare no recall, autonomous search/open, and oracle-provided original evidence. Log whether the agent recognized the gap, located the right episode, opened the original, and used it correctly. A good search score cannot compensate for not searching or for applying obsolete information.
- **Historical vs. current truth:** use the same interleaved episode to ask what was agreed at the time, what changed, and what should be done now. Include unrelated episodes with near-identical wording, delayed corrections, and unanswerable controls. Score original evidence coverage, action correctness, stale-action and abstention errors, retrieved tokens, tool calls and latency.
- **Add structure only to solve a measured miss:** lexical/time-filtered search is the baseline. Compare semantic or hybrid search when paraphrases are missed; expand around turns when an isolated hit drops the governing constraint; try event-time or explicit supersession index when temporal reasoning fails. Keep the original timeline as the source for all variants.

### Closest prior work on recall

- [MemGPT](https://arxiv.org/html/2310.08560#S2) separates searchable original interaction history from a writable archive and lets the model choose when to retrieve. It is the closest precedent for the tool model, but its recall QA does not measure correction-sensitive actions in a branching, durable session.
- [LongMemEval](https://arxiv.org/html/2410.10813v2#S5) separates indexing, retrieval, and reading, and tests knowledge updates, temporal reasoning, and abstention. Adding inferred time ranges helped retrieval with a stronger query model but not consistently with a smaller one. Adapt the temporal and update subsets; its answer accuracy is not a measure of whether an agent elects to search during work.
- [SCALE-QA, EMNLP 2026](https://aclanthology.org/2026.emnlp-main.1550/) is the closest workload: relevant constraints are buried among unrelated topics in one flat thread. Episode reconstruction improved accuracy by 5.6–17.6 percentage points over the authors' strongest corresponding baselines across three backends. The benchmark uses multiple-choice decisions; test the same ideas with real search/open calls and executable actions.
- [Chronos](https://arxiv.org/html/2603.16862#S3) separates original turn time from extracted event time and gives the agent tools to search both views. [Zep/Graphiti](https://arxiv.org/html/2501.13956) goes further with fact-validity intervals alongside record time. These are later options if chronology and original-turn retrieval fail, not reasons to start with a knowledge graph.
