# Session storage and context policies for Pi Durable

**Status:** Proposed experiment, not an implemented Pi API. **Baseline:** Pi Durable 1.6.0 at [`d4760131`][pin]; OpenAI Responses documentation checked 2026-11-24.

**Decision.** Keep Pi's `Storage` as the only write authority for a session. Add one policy at the point where a generation chooses its bounded model input. A policy may use Pi's projection, replace a closed prefix with a source-linked brief, or resume a provider-native window. Give the agent two read-only tools to recover omitted evidence. An OpenAI continuation is a transport artifact, not a summary string, a transcript or a new permission.

**Build in this order:** test native Pi plus bounded recall without a fork; add a selectable prefix and a final budget check; implement explicit OpenAI compaction on stateless input arrays; only then capture automatic in-stream compaction. A second storage backend, semantic search and cross-session memory are not prerequisites.

## 1. The seam Pi has, and the one it lacks

For one conversation, distinguish **what happened** (durable entries and task state), **what is visible now** (ancestry, edits, authority), **what to show** (bounded selection), and **how a particular API accepts it** (wire items). Changing one does not imply changing the others. In particular, compaction advances model context; it does not delete earlier entries or free disk space.

| At the pinned revision | Extension or host can do now | Limit that matters |
|---|---|---|
| Session → [`Storage`][storage-contract] | Pass a backend at `Harness.open`. A serialized commit can contain entries, task state/checkpoints and documents. Per-batch durable receipts differ from later publication. | A transcript writer is not a session backend. Preserve ID allocation, atomic batches in order, partial-prefix refusal, scoped reads, cursors, ancestry and reopen semantics. |
| Entries → [active view][projection] | Read raw history with `conversation.entries()` or projected history with `conversation.context()`. `model` contributes messages; `data` does not. Append edits rather than rewriting old entries. | The latest active marker contributes first, followed by non-marker entries from its `head` through the cutoff. Applicable edits replace/omit contributions. Tool results are associated with calls; missing results may be synthesized and unmatched ones dropped. A synthetic result is not evidence a tool ran. |
| [Generation preparation][prepare] → [request][request] | Prompt sections and planned tool definitions feed the view. `beforeRequest` can replace attempt-local messages. `beforeProviderRequest` can replace the serialized request payload. | Native thresholding uses the earlier projected view and planned entries; it does not measure this attempt's final rewrite. Compaction also reads the stored projection, not masked request-only text. Neither hook is a privacy enforcement point for the other path. |
| [Trigger and cut][cut] → [summary][compact] → [placement][place] | Tune `reserveTokens`, `backgroundTokens`, `keepRecentTokens` and model overrides. Manual, threshold, background and overflow paths exist. Selected entries/messages, `firstKept`, reason and instructions go to `beforeCompact`. Return no decision, decline or supply a text summary. | Pi **already chose the cut**. A hook cannot change it or return opaque typed items. No public post-compaction callback in the [hook contract][compact-hooks]. A blocking task can append directly; non-blocking work goes through admission and can become stale. Task completion alone does not prove a new head is active. |
| [pi-ai serialization][wire] → [stream normalization][stream] | A custom model transport can speak a different wire protocol. Stock Responses builds typed input and uses `store:false`. | The stock normalized [assistant message][message] carries text, thinking and tool calls. The parser handles those classes, not a replayable collection of compaction items. The HTTP response hook reports status and headers, not ordered response items. Adding a request flag alone loses continuation state. |

This design targets **standalone Pi Durable**, not the coding-agent CLI's [session hooks][cli]. The host binds storage, registry, tool executors and model transport when it opens the harness. See the [existing explainer][guide] for a runnable, no-key SQLite fixture. A custom host could replace the entire generation loop today; that is a separate harness, not evidence that stock hooks implement this design.

## 2. Proposed contract: one policy, two kinds of prefix

Use a checkpointed prefix plus an ordinary suffix rather than a generic prompt-editing DSL. Keep storage selection independent: the same policy must work over SQLite and a conforming remote store. Start with **one contiguous prefix, complete turn/tool groups, one active artifact per scope**. Noncontiguous selection and synthetic conversations make provenance and provider replay harder; test a need before adding them.

```text
Pi Storage → authorized view at fixed cutoff → ContextPolicy.plan(snapshot, budget)
             ↘ archive search/get               ↓ validate bounds + authority
                                         portable brief | provider window | none
                                                   + newer approved entries
                                             → render/count → provider
                                             ← normal output [+ native continuation]
                                             → one durable publication decision
```

Suggested host-facing types below are **pseudocode**, not additions already shipped by Pi. IDs stand for existing Pi branded types. The kernel, not a policy, owns access checks, provider calls, task retries and commits.

```ts
type Basis = {
  conversation: ConversationId; through: EntryId; head?: EntryId;
  lineage: string; viewDigest: string; policyEpoch: string;
}; // digest of effective inputs, not just raw entry IDs
type Budget = {
  window: number; outputReserve: number; margin: number; recallReserve: number;
};
type Snapshot = {
  basis: Basis; groups: readonly ClosedGroup[]; // IDs, sizes, source refs
  current: OpenTurn; prior?: ArtifactRef; capability: TransportCapability;
};
type Plan =
  | { kind: "native" }
  | { kind: "brief"; through: EntryId; schema: "decision-brief/v1" }
  | { kind: "responses"; mode: "explicit" | "automatic" };
interface ContextPolicy {
  readonly version: string;
  plan(s: Snapshot, b: Budget): Plan; // deterministic, no writes or network
}
type Prefix =
  | { kind: "brief"; text: string; evidence: readonly EvidenceRef[] }
  | { kind: "wire"; codec: "openai.responses/input-v1"; blob: BlobRef;
      binding: TransportBinding; method: "explicit" | "automatic" };
type Artifact = {
  version: 1; basis: Basis; policyVersion: string; coversThrough: EntryId;
  prefix: Prefix; inputDigest: string; createdByAttempt: AttemptId;
};
```

`through` in the snapshot is the read watermark. `coversThrough` in the artifact is the last Pi entry whose approved contribution is **already represented**. For an explicit window this can include verbatim items the endpoint retained; do not append them again. For automatic compaction, the response can compact **during** generation: the native window represents a concrete provider item boundary, not an inferred Pi cut. Store the exact ordered wire continuation and the attempt's mappings from Pi contributions/assistant entry to wire positions. Install only where this mapping is unambiguous. Treat the entire modeled assistant output as represented if the checkpoint already replays it; raw output remains a normal Pi assistant entry for UI and execution. Never count a partial output as a whole entry.

**Integration changes.** (1) At generation preparation, delegate to the selected policy **instead of** first running native automatic compaction. Pin cutoff and config, and route native plans through Pi unchanged. For portable plans, let the kernel validate a chosen cut against Pi's legal grouping and commit the resulting brief using native placement rules. For provider plans, keep a separate versioned conversation document/entry for the active continuation; do not insert opaque bytes into `Entry.model` or advance a Pi head pretending it contains text. (2) In the provider path, add an internal codec able to build, size and resume the actual wire input and return an optional ordered continuation with normal assistant output. Commit both through the existing generation task. Core need only know a codec ID, a validated artifact reference and a coverage boundary, not OpenAI item variants. Ensure `beforeRequest`/payload hooks cannot mutate a validated prefix or expand the request after its last budget/egress check; either incorporate the rewrite before validation or reject that combination. Avoid two compactors racing the same turn.

**Policy examples.** Native delegates everything. A brief policy chooses the earliest legal cut that meets the target, preserving the current user request and the open tool group. Its bounded brief contains objective, current constraints, verified decisions with entry references, superseded claims, open work and explicit unknowns. Use a deterministic extractor for a fixture; a model summarizer is a separately checkpointed task, not network I/O hidden in `plan()`. Never let a brief grant permissions. An OpenAI policy selects a codec and mode; it does not dictate what the server discards.

**Budget.** Let `hard = window - outputReserve - margin`; use `soft = hard - recallReserve` to leave room for a read result. Count the *rendered* input, including current system/developer settings, tool schemas, media, continuation and suffix; do not use ciphertext length as its model-token size. Prefer a provider input count when available and permitted; otherwise calibrate conservative estimates against observed usage and record estimate error. Example only: 128k window, 8k reserved output, 4k margin, 2k recall → 114k soft, 116k hard. Background work can start earlier than soft. If predicted over hard, compact synchronously or fail before generation. If the latest required turn or schemas alone exceed hard, request a smaller input or authorized externalization; never drop the latest request, split a tool call/result batch, or loop on an unchanged request. At most one recompute on a provider overflow, then a typed failure. Recheck budget after a recall result.

## 3. OpenAI Responses: two continuations, not two summaries

Scope v1 to an allowlisted OpenAI Responses endpoint/model/project combination validated by a capability probe. Do not assume OpenAI-compatible servers, Chat Completions, ChatGPT sign-in transport or another model can replay these items. Prefer stateless arrays to avoid a second authoritative store. The encrypted item is opaque to us, not interchangeable with a reasoning block. The [guide][oai] and [compact endpoint schema][endpoint] are the wire contract.

| Mode | Submit | Persist and continue |
|---|---|---|
| **Explicit, first implementation** | At a closed boundary while the current input still fits, call `POST /v1/responses/compact` with model and the authorized ordered input window. | Use its **entire** `output` in order as the replacement window, including retained items. Do not strip everything before the encrypted item; that optimization does **not** apply here. Append only later input; send the next normal generation with current instructions/tools and `store:false`. |
| **Automatic, second implementation** | On normal `POST /v1/responses`, set `context_management:[{type:"compaction", compact_threshold:N}]`. No standalone call. Set `N` below the model limit with headroom. | Collect complete output items in order. For stateless replay, append them to the sent input; the documented optional trim drops only items **before the latest automatic compaction item** in that chain, preserving that item and everything after it. If none was emitted, continue ordinarily. Never apply this trim to a standalone compact result. |

For stateless transport, persist the input-compatible typed JSON sequence; preserve item identity, `type:"compaction"`, `encrypted_content`, order, call IDs and any accompanying items. Do not log, parse, render to text, index or hand the encrypted value to tools. Lossless handling means preserving replay semantics, including unknown fields; if an item cannot be safely converted via the pinned SDK's output-to-input mapping, reject the checkpoint rather than dropping it. Store enough source/config identity to rebuild without the opaque item. A response ID alone is not a portable checkpoint. Stateful `previous_response_id` chaining is an alternative with different storage requirements and no manual history pruning; not v1.

**Configuration is part of correctness.** For explicit compact, if the history contains `configuration_update`, the current guide specifies saving the effective updated fields, omitting those update items when calling the endpoint, then adding one fresh update after the full returned window and before new input. Restore required tool declarations. Automatic output may contain a new configuration update after its compaction item; preserve it. Request-level tools must be supplied as needed, and restored declarations never authorize executing a tool. A third API form, an explicit `compaction_trigger` input item on normal Responses, has its own restoration rules; deliberately unsupported here. Recheck these protocol details against the deployed API before enabling each mode.

**Example.** Compact the complete eligible window through entry 42; the endpoint returns `[U₁, C₁, …]`. Save that exact sequence with coverage 42. When entry 43 arrives, send `[U₁, C₁, …, encode(43)]`, not `[C₁, encode(43)]` or the window plus entries 1–42. Conversely, an automatic response may return `[C₂, config₂, call₇]`. Replay those three in order and append the Pi tool result encoded with the original call ID. Do not synthesize a second assistant call from Pi's normalized transcript. Presentation, tool dispatch and wire replay use different representations of the *same* event.

**Privacy.** The standalone endpoint is documented stateless; `store:false` on generation is not enrollment in Zero Data Retention. Check project controls, feature compatibility, logs and downstream storage under the [data controls][data]. Local replication of an encrypted continuation is still data retention; use tenant-scoped encryption at rest, bounded TTL, redacted metrics and deletion of raw/derived/index/blob/backup copies according to policy. Never compact a raw item that is forbidden to send to the selected provider. Reconcile current capabilities before replay, not just before tool execution. On deletion, redaction or permission downgrade that might affect covered input, invalidate the whole opaque window and rebuild from currently authorized evidence. If forgotten data must be erased, immutable history alone is not an erasure implementation: require backend purge/crypto-erasure and a backup policy, not an appended tombstone alone.

## 4. Recovering evidence outside the window

Implement ordinary registered Pi tools. The execution context supplies principal, tenant, conversation, inherited fork cutoff, attempt watermark, egress policy and remaining budget. **None are selectable by the model.** Index only authorized searchable representations or prefilter by scope; never count an out-of-scope match in result totals.

| Tool | Inputs | Result and default limits (initial experiment) |
|---|---|---|
| `history_search` | Literal terms; optional eligible kind and scoped continuation cursor | ≤5 hits, ≤120 tokens/snippet, ≤1k tokens total. Each hit has a scoped reference, kind, occurrence position, excerpt and effective/superseded status; paginated in stable order. |
| `history_get` | One opaque result reference; optional span/cursor | Exact permitted excerpt, source role, entry+span, revision, truncation flag and continuation cursor; ≤1k tokens per call. No raw-blob, global-ID or neighboring-session lookup. |

Start with SQLite full-text search or a bounded scan for small sessions; the index proposes candidates, the authorized history reader decides what the model may see. Use Pi's **conversation-scoped** entry read, not the global overload. Verify lineage and branch cutoff, current ACL, effective edits, deletion/secret rules, revision and permitted output destination again at get time, even when a search just succeeded. Bind references and signed cursors to principal/scope/watermark/query and expiry; unauthorized and nonexistent look alike. A later redaction wins over any historical read watermark. Do not index system secrets, hidden reasoning, provider continuations or tool credentials. A user-authored correction should normally be returned as the effective answer, with a supersession link if visible, not the stale text repeated without qualification.

Reserve e.g. 2k retrieval tokens and two calls per generation cycle; charge repeated excerpts and refuse further pages when exhausted. Bound scan time, candidate count, bytes and tokens independently. Index lag may cause misses: return a watermark/partial indicator, or scan a small unindexed suffix under the same checks. Retrieved excerpts are **untrusted tool output**, never new user/developer directions. Keep their provenance on re-compaction; do not index retrieved copies recursively.

Example: entry 11 proposed build A; 19 revised it to B; a later brief omitted the exact flag. Search for the flag, then read its effective source. The tool returns “build B”, `source:19`, `supersedes:11` if visible. If 19 was revoked or is on a sibling branch, no stale cache hit can make it visible. The model can now cite the source rather than claim that its summary was authoritative.

## 5. Durable execution, recovery and storage alternatives

1. **Prepare.** Under the existing session owner, capture immutable cutoff, visible ancestry, active head, coverage, policy/codec version, tool/instruction fingerprint, transport binding and authorization epoch. Persist a pending task checkpoint keyed by that basis and source digest. Expensive work runs outside the transaction.
2. **Materialize.** Produce a bounded brief or exact native item sequence. Stage a large blob under a tenant-private immutable ID plus integrity tag; a staged blob is not a visible checkpoint. Never allow model-supplied pointers. For streaming, reconcile item indices with a terminal successful response. On cancellation, incomplete/unknown output or missing mapping, do not publish a partial continuation or dispatch a half-formed call.
3. **Publish.** Recheck lineage and current authorization. Compare-and-set active artifact against the expected predecessor in the owner's transaction. Install an immutable manifest and pointer; for automatic mode commit the assistant entry, tool-dispatch intent and matching continuation together. Use normal turn-boundary admission for background work, not an out-of-band entry append. Pure suffix appends are compatible **only** if the covered effective prefix is identical and no newer artifact/head supersedes it. Recompute or discard on conflicting edit, fork mismatch, reset, source revocation or change of instructions/tools incompatible with the saved wire prefix.
4. **Recover.** Before external call: retry from the pinned basis. After provider success but before local commit: duplicate remote computation/billing is possible; never claim exactly-once network calls. Reuse staged results when validated; otherwise retry within budget. After commit but before acknowledgment: detect the existing attempt key and resume without double-appending or redispatching the same tool call. External tool effects still require their own idempotency/approval handling. Collect unreferenced staged blobs after a grace period; if a referenced blob is missing or corrupt, invalidate and rebuild.
5. **Degrade.** On unsupported model, rejected/expired item, policy change, rollback or exhausted compaction retry: reconstruct a fresh portable view from currently eligible original evidence, not from ciphertext. If Pi's native head already hides the necessary prefix, use a scoped historical scan with effective edit/redaction processing; do not blindly reintroduce pre-reset material. Treat reset as a scope barrier unless host policy explicitly permits earlier history. Recheck fit and allowed destination. If evidence was lawfully purged and cannot be reconstructed, report a gap; if required instructions or the open tool group cannot fit, stop rather than silently invent context.

| Storage choice | When to use it | Required work |
|---|---|---|
| Existing Node SQLite | First experiment, single durable host; memory backend for deterministic tests only. | Store artifact metadata in a scoped versioned doc; small artifacts inline. Add disposable index keyed by conversation, source entry and revision. No new storage API. |
| Remote relational backend | Multiple hosts need recovery or centrally managed durability. | Implement Pi `Storage`, map each batch to an atomic transaction and preserve monotone global IDs, detached reads, ancestry, cursor behavior and ordered receipts. Fence writers per session; do not mistake Pi's in-process serialization for a distributed lock. Run upstream conformance and fault tests. |
| Blob store/search service | Large continuations, authorized attachments or derived search. | Add references plus immutable staging, retention, integrity, tenant isolation and rebuild. Neither service is the canonical task/session store. A JSONL export or vector DB alone cannot satisfy `Storage`. |

Migration: existing sessions default to `native` with no backfill and no rewritten transcript. Turn on new policies per conversation only after draining incompatible in-flight generations; persist policy/codec versions and keep old readers until pinned tasks finish. A fork should initially rebuild from its authorized fork view rather than inherit a live parent pointer. For an actual backend migration, quiesce the owner; export a consistent snapshot **including tasks/checkpoints/docs, ancestry, IDs and allocation state**, import and compare scoped projections and task outcomes on reopen, fence the old writer, then switch. No dual-write cutover. Roll back a policy by turning it off and rebuilding a portable projection; rolling back a backend requires a new consistent cutover, not resuming two writers.

## 6. Experiment and ship criteria

Use the same scripted transcript, corrections, final questions, model and token ceilings across arms. Include a source fact that was compacted, a later contradiction, overlapping tool results, a giant tool result and a fork with private evidence. Run A: matched-budget suffix; B: stock Pi; C: source-linked brief at the same legal cut; D: C with search/get; E: explicit OpenAI window with the same tools. Evaluate automatic mode separately because the provider chooses the boundary. Also run a storage cross-product on unchanged policies; swapping database must not change selected facts. Match budgets, not transcript lengths; report total billed tokens including extra summarization, retrieval round trips and failures.

| Gate | Test and acceptance |
|---|---|
| Projection and budget | Snapshot/property tests across rewrites, models, media and tool schemas. Latest input present exactly once; no orphan, double-dispatch or synthetic “success”; no request knowingly over hard budget. |
| Wire fidelity | Fake transport fixtures for retained items around a standalone encrypted item, automatic item + config + tool call, multiple compactions, partial streams, bad blobs and unknown variants. Compare ordered **next input** with the expected SDK-compatible array; no accidental textification. One opt-in live canary per declared mode/model verifies acceptance and recall, not just a 200 response. |
| Recovery and causality | Kill before call, after response, during staging, after commit and before receipt. Race two background policies, append a pure suffix, then edit/revoke a covered entry. No duplicate assistant/tool intent; stale artifacts never become usable. |
| Isolation and storage | Test parent/child/sibling, same IDs across tenants, guessed references, revoked access between search and get, purge and stale indexes. Zero forbidden fragments in prompts, recall or logs. Run [upstream storage conformance][storage-doc] plus reopen, partial refusal and lost-receipt tests before enabling any new backend. |
| Value | Blind-score final decisions, exact-source recall, stale-action rate and work repeated; track input/output/compaction tokens, cache hits, retrieved bytes and calls, p50/p95 latency, cost per successful task and fallback rate. Pass safety/integrity gates first. Prefer native Pi unless a more complex arm improves task success or cost at comparable recall across repeated runs. |

**First useful PR:** add the fake-provider retrieval fixture to the existing experiment; keep Pi's cut and SQLite fixed. **Next:** replay the identical transcript through a custom-cut brief and capture the final request shape. **Only then:** test a real explicit OpenAI window in an allowlisted project. The open empirical question is whether preserving opaque provider state adds enough value beyond a good brief plus evidence access to justify a provider-specific recovery path.

### Source map

Pinned code anchors below are implementation evidence; the types and integration changes proposed above are not upstream guarantees.

[pin]: https://github.com/earendil-works/pi/tree/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable
[storage-contract]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/types.ts#L1357-L1445
[storage-doc]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/README.md#storage
[projection]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/context.ts#L195-L210
[prepare]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/generation.ts#L227-L280
[request]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/generation.ts#L294-L326
[cut]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/compaction.ts#L299-L350
[compact]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/compaction.ts#L120-L166
[compact-hooks]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/types.ts#L1223-L1245
[place]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/durable/src/harness/compaction.ts#L455-L492
[wire]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/ai/src/api/openai-responses.ts#L203-L230
[stream]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/ai/src/api/openai-responses-shared.ts#L789-L843
[message]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/ai/src/types.ts#L596-L609
[cli]: https://github.com/earendil-works/pi/blob/d4760131efe0740b9b7f7ad1f126734b96a011c0/packages/coding-agent/docs/extensions.md
[guide]: ../explainers/pi-durable-sessions.md
[oai]: https://developers.openai.com/api/docs/guides/compaction
[endpoint]: https://developers.openai.com/api/reference/resources/responses/methods/compact
[data]: https://developers.openai.com/api/docs/guides/your-data
