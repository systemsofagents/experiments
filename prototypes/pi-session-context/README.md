# Pi session context: runnable API sketch

**Try the experience first.** Node 24+, no install, keys, or network:

```sh
npm run demo
npm test
```

The demo sends a large fixture through a baseline and a compacted plan, shows what left context and why, then retrieves the exact omitted flag from the original evidence. It shows the cache prefix changing on compaction and remaining stable on the next append. The byte counts are fixture limits, **not model tokens**; actual provider cache hits are unknown.

## The API you would write

From the prototype directory, save this as `quickstart.ts` and run `node quickstart.ts`:

```ts
import { compactWithBrief, createContext } from "./src/index.ts"

const app = createContext({
  history: true, // opt in to bounded history_search / history_get
  policy: compactWithBrief({
    summarize: prefix => ({
      text: "Release not verified. The exact qualifier is in ticket R-17.",
      sources: prefix.map(entry => entry.id),
    }),
  }),
})
try {
  const chat = app.conversation("release")
  chat.append({
    user: "Ticket R-17 requires --cohort=violet. " + "Release notes. ".repeat(130),
    answer: "No release verified.",
  })
  chat.append("Which flag do we need?")
  const request = await chat.prepare()
  console.log(request.diagnostics) // { action: 'brief', fixtureUnits: …, through: 1 }
  const [match] = await chat.tools!.search("R-17")
  if (match) console.log(await chat.tools!.get(match.ref))
} finally {
  app.close()
}
```

- **Start with defaults.** `createContext()` is the offline, unmodified-history baseline. It does not simulate Pi's default summary. Keep actual Pi's compactor for the native path below.
- **Choose what changes.** Add `chooseCut: closed => closed.at(-2)?.id` to retain the latest completed exchange verbatim; return `undefined` to skip. You can only select a supplied closed exchange. The latest unanswered input is never part of the prefix. Set a new `version` when changing persisted brief semantics. `prepare()` may install a checkpoint; it is not a read-only inspector.
- **Change storage independently.** Set `storage: sqliteStorage("/your/fixture.db")` (import it from the same module) and reopen with the same options and conversation. This backend stores bounded fixture snapshots, not Pi sessions. In real Pi, pass a conforming backend to `Harness.open`.
- **Recover without faking progress.** `CONTEXT_TOO_LARGE` means nothing was sent. Use `chat.replaceOpen(shorterText)` to shorten the pending input in this fixture. `STALE_VIEW` means history or permissions changed during preparation; prepare again. Never use the fixture's `answer(text)` to settle a real asynchronous attempt; production needs commit-time turn and revision binding.
- **Treat recall as evidence.** The host supplies scope and access rules, not the model. Handles are temporary, instance-bound, and recheck the authorized source on every read. Search and get are bounded by the fixture's history and excerpt limits. This is not a general ACL, edits, fork, or erasure implementation.

## Runnable compatibility checks

| Arm | What it actually runs |
| --- | --- |
| **Native Pi Durable** | Real pinned Pi Durable 1.6.0, SQLite, the stock compaction task and a scripted faux summarizer. Asserts the original flag enters the native summary pass, leaves active context, and is recovered from the same persisted Pi conversation. The recall source only exposes a dedicated synthetic entry kind; this is host-side recall, not a production ACL or a model-attached tool. |
| **Real Pi + OpenAI restart** | Runs the existing Pi OpenAI adapter through a thin provider wrapper. Two separate processes open the same SQLite database. Asserts exact replay of the saved provider window followed by only the new user input, exact recall from Pi history, and reset fallback. Offline SSE fixtures and opt-in live mode use the same entry point. |
| **OpenAI automatic server-side compaction** | `automaticResponses().advance(input)` sends the Responses request contract with `context_management`, `stream:true` and `store:false`. SSE tests simulate a provider over the HTTP boundary, keep terminal encrypted/config/tool items in order, and verify the next request carries those same items and the matching tool result. Incomplete responses or unknown terminal item types fail closed. No provider requests in `npm test`. |

To run the native integration from this directory, first install the dependencies from the existing locked explainer once:

```sh
npm --prefix ../../explainers/examples/pi-durable-session ci --ignore-scripts
npm run test:pi
```

`PI_EXAMPLE_DIR` can point to another copy of the installed example. To run the optional **live** automatic Responses check in your own approved OpenAI project, use `RUN_LIVE_OPENAI_COMPACTION=1 npm run canary:openai` with `OPENAI_API_KEY` already set. It sends only synthetic text, can incur charges, and fails unless it sees a compaction item, successfully replays it, and recovers the synthetic flag. The live canary is not part of the offline verification.

### Restart real Pi with OpenAI-managed context

```sh
npm run test:pi:restart
FIXTURE_TRAILING_COMPACTION=1 npm run test:pi:restart
# Optional: only synthetic data, can incur charges.
RUN_LIVE_OPENAI_COMPACTION=1 npm run test:pi:restart
```

Use the same locked dependency install as `test:pi`. Live mode expects `OPENAI_API_KEY` in the process environment and defaults to `gpt-6.2-astra` (override with `OPENAI_MODEL`). The canary closes the harness and both database handles before the second PID starts. The test receipt holds a hash, not a copy of the continuation: the second process must get the original ordered window from SQLite. The online test asserts the secret fixture is absent from the visible request yet is recalled by the API; the exact source is also fetched from Pi's original local entry.

The wrapper uses public `createProvider`, `onPayload` and `onProviderStreamEvent` from the pinned Pi release. The stock adapter retains auth, tool normalization, streaming, and cancellation. The normalized assistant response does not contain the compaction item, but the stream observer receives it before normalization. No fork or private import is needed. Only completed replies with a normalized text anchor install a checkpoint. The final compaction item may follow the text, in which case the text anchors the transcript but is not repeated on the wire.

Each candidate is scoped to a single host-bound conversation and a provider/model/project namespace. On replay we verify the wire prefix digest, request profile, and matching committed Pi assistant reply before appending new input. Writes use a separate table in the same database, **not** Pi's assistant transaction. Even if a crash leaves an unused candidate before the assistant commit, it cannot match the committed reply on reopen. A reset, a changed covered prefix or an incompatible request falls back to the active transcript. Forks need their own provider binding. The host should use a private database directory, rotate the namespace if provider/project identity changes, and clear the checkpoint before a retry if the server rejects the opaque state. Do not treat that state as an archive, as independently recoverable across projects, or as safer than the transcript. This is not crash/power-loss certification, multi-writer support, deletion support, or a guarantee that every possible Responses item is resumable. Tool-call-only terminals and unrecognized item shapes do not install a checkpoint.

For retention and trimming, see [Pi session lifecycle](../../specs/pi-session-lifecycle.md).

The selection is intentionally visible: **native** keeps the installed Pi harness's configured compaction policy; **automatic Responses** uses a dedicated transport at the generation boundary:

```ts
import { automaticResponses, userItem } from "./src/responses-stream.ts"

const transport = automaticResponses({ model: "gpt-6.2-astra", compactThreshold: 32_000, request })
const turn = await transport.advance([userItem("First question")])
const next = await transport.advance([...turn.inputForNext, userItem("Follow-up")])
```

Here `request` is a host-supplied Responses POST transport. The tests inject a replayable SSE transport; the canary shows the opt-in live setup. The standalone transport is useful for testing wire semantics; the real Pi example instead wraps stock and validates a sidecar candidate against the committed reply. The adapter normalizes a narrow item subset (text, reasoning, function calls, configuration, compaction), following the [SDK replay helper](https://github.com/openai/openai-node/blob/main/src/lib/responses/ResponseInputItems.ts) for output-only metadata; it is not a full Responses client.

For **standalone** `/responses/compact`, the separate `compactWithOpenAI({ binding, transport })` fixture demonstrates complete ordered replacement, including verbatim items around the opaque item. Bind transport/model/project/codec when persisting a native view. Unlike automatic compaction, never drop the returned prefix before the opaque item. The offline standalone request shape is **not sendable to a live provider**; advanced configuration items, tool schemas, authorizations, and model capabilities need real adapter support.

## What is and isn't ready

- **Real today:** pinned Pi storage/hooks/compaction; host-side reads from Pi itself; standalone fixture runner and its memory/SQLite conformance checks.
- **Proposed, exercised offline:** final budget check, selectable cut, isolation and revalidation around recall, replayable provider sidecar, stable-prefix diagnostics. The real restart test proves recovery for supported completed replies, not atomic coupling of all Pi commits with provider items. No Pi fork, no rewrite of Pi history, no claim of production wire/UX completeness.
- **Caching:** keep compatible static instructions/tool definitions in the early stable prefix, append tool output in order, and compact when the budget/quality justifies rotating the history portion. Never treat local prefix comparison as provider billing. See [provider caching notes](caching.md), the [OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-caching) and the [Anthropic guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
