# Systems of Agents

How do we organize people and agents to do useful work and make steady progress toward long-term objectives?

A workspace can enforce which files an agent is allowed to open. Design alone cannot tell us whether the agent will notice that it needs an earlier correction, find it, and act on it. First principles tell us what we can guarantee and what is worth testing. For the rest, we need experiments.

This project has two outputs: **design principles grounded in controlled studies** and **runnable reference environments** where practitioners can plug in a new model and see what changes on realistic tasks.

## Guiding principles

- **Study the whole system.** Include the tools, durable state, constraints, and ways people can steer the work.
- **Separate explanation from deployment.** First swap models in the same harness at the same budget. Then tune the harness for each model and compare the systems you would actually deploy.
- **Make behavior inspectable.** Pair verified outcomes, cost, and repeatability with replayable traces. Did the agent recover on its own, or did the user have to repeat the correction?
- **Publish the limits of each finding.** State where a pattern helped, where it failed, and what to rerun when the model changes.

Start with [Concepts](CONCEPTS.md) for the vocabulary behind the experiments, or try the [uncapped-session runner](benchmarks/README.md) for an early example of the measurement toolkit.

## Research tracks

- [01 – The uncapped session](notes/01-uncapped-session.md): compaction, indexing, and corrections in long-lived sessions.
- [02 – The shared filesystem](notes/02-shared-filesystem.md): durable state, collaboration, and access controls.
- [03 – Search and hill climbing](notes/03-search-and-hill-climbing.md): verified progress under a budget, reliability, and configuration search.

## Explainers

- [Pi Durable sessions and context compaction](explainers/pi-durable-sessions.md): a progressive guide and runnable extension example.
- [All explainers](explainers/README.md).

## Specs

- [Session storage and context policies for Pi Durable](specs/pi-session-context.md): proposed architecture for bounded model context, native compaction and scoped evidence recall.

## Prototypes

- [Pi session context](prototypes/pi-session-context/README.md): runnable local context and recall examples, a native Pi Durable integration check, and a mocked Responses stream fixture. See the [provider caching notes](prototypes/pi-session-context/caching.md).

## Benchmarks

- [Uncapped-session benchmark runner](benchmarks/README.md): paired compaction and memory experiments with interchangeable agent hooks, native Pi fixtures, and public dataset adapters.

These notes describe proposed experiments, not findings. Website source lives in [systemsofagents/site](https://github.com/systemsofagents/site).
