# Pi Durable sessions and context compaction

A long-lived conversation does not require an ever-growing model request. Pi Durable stores a conversation's history and in-flight work separately from the bounded view used for each model call. Before writing an extension, decide **which of those representations you want to change**.

This guide uses [Pi Durable 1.6.0][npm] and the upstream source at [`d4760131`][pin]. The API is experimental; use the locked example before translating the code to a different minor release.

## Start here

1. [Follow an input from disk to model](#1-follow-an-input-from-disk-to-model)
2. [Choose what to store](#2-choose-what-to-store)
3. [Transform entries into context](#3-transform-entries-into-context)
4. [Change what compaction preserves](#4-change-what-compaction-preserves)
5. [Run the example](#5-run-the-example)
6. [Move from a demo to an experiment](#6-move-from-a-demo-to-an-experiment)
7. [Separate the runtime, CLI and Cloudflare host](#7-separate-the-runtime-cli-and-cloudflare-host)

## 1. Follow an input from disk to model

Think in four layers, not one transcript:

```text
client input
  → durable submission and task state
  → immutable, ordered conversation entries
  → active context: head marker + kept entries + context edits
  → per-attempt request messages → provider request body
```

A **Session** is the storage-backed kernel for entries, tasks and documents. One **Harness** layers the agent runtime and scheduler over it. A **Conversation** is an addressable history and live agent within that harness. A user-facing session might map to one root conversation, but that is an application decision. A process can close and reopen the same database to continue; a fresh database is not a resumed session.

For an entry, `kind` names the type, `data` is app/bookkeeping data, and `model` carries candidate messages for the model. `head` can change the start of active context, and `edits` can replace or omit an earlier entry's contribution. Extension registry implementation is supplied by the host on each open; a conversation can select extensions by name, but the JavaScript implementation is not stored in its transcript. See the [record types][types] and [runtime README][readme].

**Try it mentally.** An input says “Use build A.” A later correction says “Use build B.” The original record can still say A, an appended edit can project B, the request hook can hide the build label for a given model, and a compaction can preserve the fact that the old decision was superseded. None of those changes needs to pretend that A was never recorded.

## 2. Choose what to store

Start by changing the **entry schema**, not the log's physical layout. At ingestion, store source and schema version with the input:

```js
const receipt = await conversation.submit({
  type: "input",
  content: "Inspect the release plan.",
  entry: { kind: "example.input", data: { source: "fixture", schema: 1 } },
}, context);
await receipt.wait(context);
```

The kind and metadata are stored, but the model still sees user content. Use a data-only `type: "write"` submission for a bookkeeping record that should not contribute model messages. An extension can also define typed entry kinds and append from a supported durable transaction. If the information is mutable, use a versioned document rather than constantly rewriting a large transcript. For an external search index, keep it disposable and rebuild from committed history. Store the source entry ID, conversation identity and ingest position so a retry does not index the same event twice. Do not make an index the only copy of a decision.

**The host chooses storage.** In the example, the host passes `openNodeSqliteStorage(path, { prefix: "tutorial_" })` to `Harness.open`. A prefix namespaces tables; changing it does not migrate data. MemoryStorage is for tests, not persistence. Node SQLite is a sensible first durable backend; JSONL is useful when inspectability matters, but has a one-writer model and its documented read-only behavior matters. IndexedDB has a single-owner requirement. See [upstream backend notes][storage].

A genuinely new backend is a host project implementing `Storage`, not an extension rewriting entries after the fact. Commits contain more than chat messages: task state, document changes and entries may need to land together. A backend must preserve ordered atomic batches and durable receipts, stable IDs across reopen, and correct cursor and ancestry semantics. Start with the exported `registerStorageConformance()` suite, then test process termination between durable write and receipt. A read or storage failure may fail the live session; do not silently return partial history. For retention or deletion, address all copies (logs, summaries, search indexes and backups) explicitly; compaction is not deletion.

## 3. Transform entries into context

There are three different interventions:

| Goal | Surface | Persists? |
| --- | --- | --- |
| Include app data, corrections or context edits on rebuild | Entry `data`, `model`, or `edits` | Yes; the original entry stays intact |
| Change system prompt sections or the current model's context | `section()` / `wrapSection()`, or `hook(GenerationTask, { beforeRequest })` | A request rewrite is not persisted as transcript history |
| Adapt a provider-specific request field | `beforeProviderRequest` | No; runs after pi-ai builds the provider payload |

First examine `conversation.entries()` (raw) and `conversation.context()` (projected). Projection locates the latest active head within the requested range, takes its kept entries, applies context edits, and normalizes the messages. For instance, it attaches tool results to the right call instead of assuming they finished in call order. An edit is durable but is not a general retroactive transcript migration or a promise that earlier generations never saw the old content. If the target is already outside the active range, repair the current summary or durable fact representation too.

`beforeRequest` receives the already assembled messages for that attempt. Return a fresh replacement instead of mutating the input. The example rewrites a synthetic build label only in string-bodied user messages. A real transform should validate its selection, cap inserted material, retain the latest user turn and preserve assistant tool calls and their matching results. Prefer deterministic bounded transformations; a hook may run again, and reads can see newer committed state. If a transformation involves a provider-specific field, check the target API before touching the payload. Treat retrieved and tool-sourced text as evidence, not instructions or new approval.

**What is counted?** At this pin, the generation threshold checks the pre-request context plus planned messages; it does not run `beforeRequest` and count the newly rewritten request. The estimator may use prior measured assistant usage as a baseline, so a previous rewrite can show up indirectly. The compactor builds its source from the stored-history projection, including applicable context edits, not the request-only rewrite. Do not treat request-only masking as a privacy boundary: another path, including summarization, may see what you masked. Enforce sensitive-data policy at ingestion and other relevant boundaries.

Source: [projection][context], [generation hook][generation], [threshold][threshold], [estimator][estimate].

## 4. Change what compaction preserves

Compaction replaces the **active prefix**, not stored rows. The runtime selects a cut, builds source messages, and invokes the compaction extension. It writes a summary entry pointing to the first kept entry. Future requests start with the new head's model contribution and the kept tail. In-flight runs can place a summary at a turn boundary; when a more advanced head already exists, the older result can be stale. A task finishing and its summary becoming visible are separate things: check the optional placement submission when present.

A useful policy starts with these knobs:

- **`reserveTokens`**: subtract from the model's context window to get the blocking threshold.
- **`backgroundTokens`**: how much earlier to start background compaction. Zero disables background compaction.
- **`keepRecentTokens`**: target size of the verbatim tail, not an exact guarantee. A suitable cut must exist, and the runtime selects it.
- **`modelOverrides`**: tune per provider/model. A fixed budget for a long-window model can behave poorly on a smaller window.

The generation path can compact and retry once after a provider context-overflow error. Background compaction does not imply every request can proceed: above the blocking threshold the next request may wait. Manual compaction works even when automatic compaction is off.

Use `hook(CompactionTask, { beforeCompact })` for content policy. The hook sees the selected `entries`, `messages`, `firstKept`, reason and optional instructions. Returning `undefined` keeps the default behavior; `{ kind: "decline" }` declines; `{ kind: "summary", summary }` supplies a replacement. The first decision wins. **You cannot return a new cutoff.** Keep a production custom summary within a separately measured budget and test what happens when no valid cut exists. If a durable, asynchronous external summarizer needs its own checkpoint and retry semantics, design that as explicit host/runtime work; do not assume awaiting it in a hook makes its external effects durable.

Start with a conservative summary schema: current objective, latest revisions and constraints, verified observations with source IDs, pending actions, and unresolved uncertainty. Say what has **not** been verified. If using an index later, retrieve by scope and freshness, keep correction links, and prefer a newer explicit instruction over an older retrieved fragment. A compacted summary is not authority to take action.

Source: [compaction prep and hooks][compaction], [summary placement][placement], [public compaction behavior][readme-compaction].

## 5. Run the example

The [complete demo](examples/pi-durable-session/demo.mjs) uses a fake provider and a disposable SQLite database. It requires Node.js **24 or later**, npm and initial package access, but **no API keys, hosted model, or live agent**.

```sh
cd explainers/examples/pi-durable-session
npm ci --ignore-scripts
npm test
```

Follow the test in order:

1. Submit synthetic text under a custom stored entry kind. Check its metadata does not become provider prompt text.
2. Append a persisted context edit. Close and reopen the database. Assert raw history still has the old label and the projection has the corrected label.
3. In `beforeRequest`, mask the corrected label for one generation path. Assert the fake provider sees the masked text and neither label.
4. Manually compact with a **fixture-only, intentionally lossy** summary. Check the compactor read the corrected, unmasked projected text, and the summary is active without changing the raw original.

The examples demonstrate API boundaries, not a production masking scheme, retention policy or a benchmark result. The runtime's [compaction example][upstream-example] goes further into background compaction and overflow retries.

## 6. Move from a demo to an experiment

For [Uncapped Session](../notes/01-uncapped-session.md), hold the same transcript, late correction and available tools fixed. Compare (A) raw suffix under a matched token budget, (B) Pi's default compaction, (C) a structured summary, and then (D) a structured summary plus bounded retrieval. The long chat is the user experience; the model requests underneath it remain bounded. Preserve the same ground truth and score verification separately from recall.

| What to test | What would falsify the design |
| --- | --- |
| Reopen on the same storage and restore selected extensions | Tasks or the latest correction vanish; duplicate side effect on retry |
| Compaction placement while a later correction arrives | Old task or permission reappears as if current; stale compaction wins |
| One tool batch crossing an input or context cutoff | Orphaned tool result, missing call, or unsupported order |
| Small- and large-window models with the same fixture | Request exceeds budget; same evidence disappears only on smaller model |
| Projected or retrieved data after a visibility change | Raw or derived state crosses a conversation, tenant or access boundary |
| Evidence versus assertion | A remembered claim is treated as a new verified tool result |

Record retained decisions, stale-action errors, work repeated, tokens, request latency and ignored/late summaries; preserve the original event stream as the evaluator's evidence, not the agent's entire prompt. Later, the [Shared Filesystem](../notes/02-shared-filesystem.md) track can test when selected state should live outside the conversation and who may retrieve it.

## 7. Separate the runtime, CLI and Cloudflare host

- **Standalone Pi Durable:** the pinned npm package and APIs in this guide. The app owns storage selection, registry, credentials/model server, provider configuration and scheduling integration.
- **Pi coding agent CLI:** a different package and extension surface. Its `pi.on("session_before_compact", …)` and session-manager APIs are not names to use for Durable hooks. A CLI extension is not automatically a Durable extension. See the [CLI extension docs][cli].
- **Cloudflare Agents SDK PiHarness:** the host capability around Pi Durable. It supplies an existing Durable Object's SQLite-backed storage and lifecycle wake-up callback. In the `harness` factory, pass the supplied `storage` and `onWake` to `Harness.open`; assemble the registry, extensions, models, and settings there. Do not substitute the Node SQLite demo backend in a Worker. The SDK factory can run again after recovery, so install consistently and avoid non-idempotent setup. Distinguish UI/watch entries, the underlying Durable context, and provider outbound messages. Confirm the host's compatible Pi minor before upgrading: release notes warn that a backwards rollback can strand newer in-flight work. See the [Cloudflare PiHarness documentation][cloudflare].

[pin]: https://github.com/earendil-works/pi/tree/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable
[npm]: https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.6.0
[readme]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/README.md
[readme-compaction]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/README.md#compaction
[types]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/types.ts#L465-L502
[storage]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/README.md#storage
[context]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/context.ts#L317-L370
[generation]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/generation.ts#L308-L325
[threshold]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/generation.ts#L516-L541
[estimate]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/compaction.ts#L354-L374
[compaction]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/compaction.ts#L125-L162
[placement]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/compaction.ts#L455-L492
[upstream-example]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/test/examples/24-compaction.ts
[cli]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/coding-agent/docs/extensions.md
[cloudflare]: https://developers.cloudflare.com/agents/harnesses/pi/
