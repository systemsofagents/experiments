# experiments
Code and notes from various experiments

Start with [Concepts](CONCEPTS.md) for the vocabulary and design decisions behind the experiments.

## Research tracks

- [01 � The uncapped session](notes/01-uncapped-session.md): compaction, indexing, and corrections in long-lived sessions.
- [02 � The shared filesystem](notes/02-shared-filesystem.md): durable state, collaboration, and access controls.

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
