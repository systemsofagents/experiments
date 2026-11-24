# Benchmarks: the uncapped session

Run the **same agent implementation** against transcript recall, repeated compaction, or a live task. Swap the activation code and the compaction policy independently. The runner owns the clock, input stream, paired cases and scoring; your agent owns what enters working context, when to cut, and what to recover.

## Five-minute start

From this directory, with Python 3.11+. No install, model key, or download:

```sh
python -B -m unittest -v
python runner.py session --cut-after 3 --cut-after 6 --cut-after 9
```

Three toy workspaces each require the latest instruction, an exact flag from an older tool result, then a receipt from the resulting action. Full history and archive recall should finish all three. A two-entry tail should abstain. These are tests of the benchmark plumbing, **not model quality results**.

To exercise **actual Pi Durable 1.6.0 and SQLite** with the same runner, install the locked example dependencies using Node 24+:

```sh
npm --prefix ../explainers/examples/pi-durable-session ci --ignore-scripts
python runner.py session --matrix pi-matrix.json --cut-after 3 --cut-after 6 --cut-after 9
```

The three arms share the native Pi activation path. They differ in whether Pi runs its stock cut/placement or has a synthetic archive fallback after the cut. The model and its deliberately lossy summarizer are scripted. The archive fallback is a full in-process scan for this fixture, not production retrieval. Node's Pi sidecar creates fresh SQLite state per case and arm. For an automatic trigger test, omit the forced cuts and put `"cut_every": 3` in the desired arm's `sidecar` config. The pinned upstream Pi automatic token trigger is disabled here; the runner drives the **native cut**, not the stock scheduling policy.

## Public benchmark inputs

| Entry point | What runs | Grade |
| --- | --- | --- |
| `longmemeval` | [Cleaned LongMemEval-S or M](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned); chronological user/assistant turns, then a timestamped question | Exact match only as a smoke signal; `export_lme.py` feeds the [official judge](https://github.com/xiaowu0162/LongMemEval#-testing-your-system) |
| `beam` | [BEAM](https://github.com/leegisang/BEAM) upstream `chat.json` + rubric files; fresh history per probe so earlier probes cannot leak into later ones | `export_beam.py` feeds the upstream category rubric grader; no mock accuracy |
| `memoryarena_formal` | [MemoryArena](https://github.com/ZexueHe/MemoryArena) math or physics chains with the upstream judge server; different actions produce later memory | Final-subtask reward; a documented adaptation, not the paper's aggregate or web suites |
| `replay` or `your_module` | Your ordered transcript or independently reconstructed **live** environment at a fixed boundary | Your benchmark adapter, without changing the agent |

Use an explicit agent for public datasets. For example, create a local `reader.json` matrix:

```json
{
  "recent-only": {
    "factory": "agents:tail",
    "config": {
      "reader": "agents:api_reader", "provider": "openai", "model": "YOUR_MODEL",
      "allow_network": true, "cut_every": 32, "tail": 16
    }
  },
  "brief-and-recall": {
    "factory": "agents:recall",
    "config": {
      "reader": "agents:api_reader", "summarizer": "agents:api_brief",
      "provider": "openai", "model": "YOUR_MODEL", "allow_network": true,
      "cut_every": 32, "tail": 16, "top_k": 12
    }
  }
}
```

Use an approved provider project and set `OPENAI_API_KEY` in the environment; for Anthropic use `"provider": "anthropic"` and `ANTHROPIC_API_KEY`. These runs send selected records to the specified provider and may incur charges. Never put credentials in a matrix or a receipt. Pick a model with suitable context and output budgets. `cut_every` counts **observations, not tokens**.

```sh
mkdir results
python runner.py longmemeval --data data/longmemeval_s_cleaned.json --limit 12 --matrix reader.json --out results/lme.json
python export_lme.py results/lme.json brief-and-recall results/lme-answers.jsonl

python runner.py beam --data ../BEAM/chats/100K --limit 2 --matrix reader.json --out results/beam.json
python export_beam.py results/beam.json brief-and-recall ../BEAM/chats/100K results/beam-answers
```

For LongMemEval, pass the exported JSONL and the exact input dataset to upstream `evaluate_qa.py`. Limited LongMemEval runs select a seeded, stratified subset. For BEAM, pass the exported directory to upstream `src.evaluation.run_evaluation` with `--chat_size 100K` and `--allowed_result_files soa.json`; invoke it from the BEAM checkout and follow its setup and index selection instructions. BEAM's exporter preserves rubric indices. Start with 100K: re-ingesting a large history for every question is expensive with an online summarizer. Data and scorer stay upstream; no dataset copied here. See upstream terms, including BEAM's CC BY-SA data license.

### Server-side OpenAI compaction

Run two same-model arms with `responses:full` and `responses:compact` factories in your matrix, each with `{"model":"YOUR_SUPPORTED_MODEL","allow_network":true}`. Force comparable cuts, e.g.:

```sh
python runner.py session --matrix responses-matrix.json --cut-after 3 --cut-after 6 --cut-after 9
```

The second arm uses the real [standalone Responses compaction endpoint](https://developers.openai.com/api/docs/guides/compaction), then replays the entire returned window in order. It does not compare opaque state to an invented summary. Both arms render history identically; the only difference is whether they execute cuts. The transport is contract-tested with a mock, not live-tested here. Automatic Responses compaction uses a different trigger contract; see the [existing canary](../prototypes/pi-session-context/README.md#two-runnable-compatibility-checks). These example readers use an answer/action string interface, not provider tool-calling or Pi's live model provider.

### MemoryArena math and physics

Follow [upstream environment setup](https://github.com/ZexueHe/MemoryArena/blob/main/setup_formal_reasoning.md) for its judge server. Export the `test` split of `ZexueHe/memoryarena` (config `formal_reasoning_math` or `formal_reasoning_phys`) as JSONL with `id`, `questions`, `answers`, `backgrounds`; Hugging Face Datasets' `to_json()` works. Save a separate config (relative dataset path):

```json
{
  "tasks": "memoryarena-math.jsonl",
  "env_url": "http://127.0.0.1:8001",
  "env_name": "math",
  "env_config": {"model_name":"YOUR_JUDGE_MODEL","backend":"openai","max_steps":10},
  "allow_network": true
}
```

`python runner.py memoryarena_formal --data data/arena.json --matrix reader.json --limit 1 --max-actions 20`

Use the full upstream `env_config` for your judge setup. The server may independently make billable API calls. The runner never hands a reference answer or judge feedback to the agent. Each arm has its own environment ID. This adapter is tested against fake server responses; the live judge and other MemoryArena domains were not run here.

## Write your own agent or scenario

An arm is just `module:factory` (importable from this directory or `PYTHONPATH`). The factory receives a config dictionary and returns a new instance **per case**:

```python
from runner import Reply

class MyAgent:
    def observe(self, event):
        ...                          # Append or index this one observed record.

    def should_compact(self):
        return False                 # Optional. Use your own token/age/cost trigger.

    def compact(self, trigger):
        ...                          # Cut, summarize, evict, or call a provider.
        return {"applied": True}     # Add usage and diagnostics if available.

    def activate(self, request):
        ...                          # Assemble context, call your model, run your loop.
        return Reply("unknown")      # Optional sources, retrieved IDs and provider usage.

def make(config):
    return MyAgent()
```

`python runner.py session --agent my_agent:make --cut-after 3` runs your activation after ingesting the fixture and requests a cut at observation 3. Repeat `--agent` for different factories, or use a named matrix for multiple configs of the same factory. External runtimes can use `bridge:command` as in [pi-matrix.json](pi-matrix.json). It exchanges one JSON line per request and one `{"result": ...}` per response, in order: `init(config)`, `observe(event)`, `should_compact()`, `compact(trigger)`, `activate(request)`. Print logs to stderr. Only native essentials and explicitly listed `pass_env` names pass to the subprocess; use trusted code and treat config/plugins as executable inputs.

For a new benchmark, expose `cases(path, limit, seed)` and `grade(case, turns, world)`. Each case provides stable `id`, `category`, and an ordered `history` of `{id,role,text,timestamp?}` events. Then provide one of:

- `prompts`: a list of `{id,text}` requests after the history.
- `schedule`: ordered `{"observe":event}` and `{"activate":request}` entries for interleaved replay.
- `world`: a factory returning a fresh environment with `start() -> Request`, `step(answer) -> (list[Event], Request | None)`, and optional `close()`. Put task-specific tools and the grader in that environment, not the runner. Keep checkpoint reconstruction identical across arms.

The built-in JSONL `replay` adapter accepts the first two formats and `gold` answers in activation order. Keep gold and evidence labels outside event text. See [datasets_builtin.py](datasets_builtin.py) for a runnable closed-loop example.

## What to compare

1. Force **one identical cut** at first. Then run whole trajectories with 3-5 cuts using each system's real trigger. The report separates cut requests from applied cuts. Hold executor, environment state, and action budget fixed when attributing a result to compaction.
2. Compare full history where it fits, a recent tail, summary-only, and both summary and retrieval with matched models. Watch task completion and stale decisions first, then retrieval and citation recall separately. A citation returned by a model is not independent proof that the evidence was used.
3. Report p95 activation latency and compaction latency separately. Where available, the per-call receipt stores raw provider usage for cached and uncached tokens. Don't infer cache hits from local byte or item counts. Sum cost with the actual model's prices; these scripts don't estimate bills. Keep results local; receipts include generated answers.
4. Next adapters: [CompAct-Bench](https://compaction-eval.github.io/CompAct-Bench/) and [Compact-Bench](https://arxiv.org/html/2610.31710v2) for paired task continuations; [Microsoft CompactionBench](https://www.preprints.org/manuscript/202611.0780) for repeated environment changes; [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) for trajectory evidence and [NoLiMa](https://github.com/adobe-research/NoLiMa) for raw-context diagnostics. Those suites are **not wired in**; use their upstream tooling or adapt cases to the interfaces above. Some published runs rely on internal environments or unreleased snapshots, and an adapted run is not automatically comparable to a paper's leaderboard.
