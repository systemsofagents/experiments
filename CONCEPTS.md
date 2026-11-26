# Concepts

A practitioner’s reference for designing systems where agents do useful work across many activations. These are distinctions we expect to stay useful as models, providers, and harnesses change.

## Activation

An **activation** is one occasion for the harness to give an agent work: a user message, a scheduled wake, an external event, or a handoff. An activation is not a model call. It may contain many inference calls interleaved with tool calls and may outlive a process. A session can contain many activations.

On each activation the harness determines what work is current, what authority applies, which state is available, and what tools the agent may use. After each tool result, it can assemble a different model input and run inference again. Before the activation ends, it records any durable decisions, artifacts, and unfinished work that a later activation will need.

## History, context, and retrieval

| Concept | What it owns |
| --- | --- |
| **Durable history** | The source record of what happened: user messages, tool results, decisions, and provenance. Subject to explicit retention and deletion policy. |
| **Active context** | The particular instructions, messages, summaries, tool schemas, and results visible to a model call. It is a bounded projection, not the session itself. |
| **Archival retrieval** | An explicit operation that finds and reintroduces material outside active context. A pointer in a summary is not the source, and material available to retrieve is not necessarily material the agent will think to retrieve. |

Keep the three separable. A compacted input does not imply that the source history was deleted. A stored transcript does not imply that the model can see it. Preserving a workspace is useful, but it is not a substitute for carrying forward a decision that exists only in the conversation.

## Inference and the context budget

The harness projects durable state into an ordered provider request. The model consumes that input, produces a response or tool request, and the harness decides what enters the next request. Record the actual rendered token count, not just the length of user messages: fixed instructions, tool definitions, retained summaries, recent history, and tool results all take space. Count cached input too; a cache hit changes cost and latency, not whether a token occupies context.

Decide how much room is needed for generation, reasoning (where the provider counts it), and the next large tool result. Distinguish the **model limit**, the **harness working budget**, and the **compaction trigger**. An absolute threshold such as 250K is ambiguous until we say which tokens count, when they are counted, and what reserve is left. An early background trigger and a hard foreground trigger can be useful distinct knobs.

## Compaction

**Compaction** replaces part of the working context with a smaller representation so inference can continue. It is not a long-term archive. Every compaction policy should make four choices explicit:

1. **When to compact:** a token threshold, a task milestone, a model decision, or a combination. State how output reserve and unexpectedly large tool results are handled.
2. **What to compact and what to keep:** choose the cut; set a budget for the summary and recent verbatim tail. Preserve tool call and result boundaries. Keep authoritative instructions and enforced permissions outside lossy summaries.
3. **How to represent state:** a rolling summary, structured checkpoint, append-only segment summaries, or a provider-native opaque item. Track open decisions, settled exclusions, and superseding user corrections, not just topics and facts.
4. **How to resume:** assemble the next window deterministically enough to explain what the model saw. Keep the raw source separately where policy permits. If a provider item is opaque, preserve the provider’s continuation contract rather than treating the item as editable text.

These knobs trade off quality, cost, and latency. Compacting earlier can shrink per-call input but increase summary calls and cache misses. Keeping a larger raw tail can preserve exact details but leave less room for new work. Append-only summaries can preserve cached prefixes but still accumulate.

## Effective context is measured

A model’s advertised window tells us what can fit, not how much history it can use reliably after repeated compaction. An experiment can compare one model running a task stream with full history in its usable ~1M window against the same model compacting at 250K, with archival recall disabled. Comparable task success **and** constraint-following would demonstrate that the smaller working window is enough for that workload, not that compaction universally gives 4× more usable context.

Measure whether the agent follows the latest instruction, remembers unresolved work, and avoids redoing settled work after each cut. Separate those outcomes from output quality, cache reuse, cost, and latency. Which threshold works, how much verbatim history to retain, and how many repeated cuts remain reliable are empirical questions, not constants.

See the [uncapped session research track](notes/01-uncapped-session.md), [Pi Durable explainer](explainers/pi-durable-sessions.md), and [session context design](specs/pi-session-context.md) for concrete examples.
