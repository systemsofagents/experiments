import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { automaticWindow } from "./openai.ts"

const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
const digest = value => createHash("sha256").update(canonical(value)).digest("hex")
function isCheckpoint(record) {
  return record !== null && typeof record === "object" &&
    Number.isSafeInteger(record.prefixLength) && record.prefixLength > 0 &&
    ["profile", "prefixDigest", "replyDigest", "responseId", "endItem"]
      .every(key => typeof record[key] === "string" && record[key].length > 0) &&
    Array.isArray(record.outputIds) && record.outputIds.includes(record.endItem) &&
    Array.isArray(record.window) && record.window[0]?.type === "compaction"
}

// One conversation per adapter instance. Pi owns all transcript entries;
// this SQLite table is a disposable, versioned projection, not Pi's schema.
export function openContinuationStore(path) {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS soa_openai_window_v1 (
      scope TEXT PRIMARY KEY, checkpoint TEXT NOT NULL
    )`)
  const read = db.prepare("SELECT checkpoint FROM soa_openai_window_v1 WHERE scope = ?")
  const put = db.prepare("INSERT OR REPLACE INTO soa_openai_window_v1 VALUES (?, ?)")
  const remove = db.prepare("DELETE FROM soa_openai_window_v1 WHERE scope = ?")
  return {
    get(scope) { return JSON.parse(read.get(scope)?.checkpoint ?? "null") },
    put(scope, checkpoint) { put.run(scope, JSON.stringify(checkpoint)) },
    clear(scope) { remove.run(scope) },
    close() { db.close() },
  }
}

// Wraps only public pi-ai APIs. In particular, do not replace the SDK, the
// stream normalizer, tool dispatch, cancellation, or the provider auth path.
export function durableResponsesProvider({
  createProvider, createStream, stock, model, auth, store, namespace,
  conversationId, compactThreshold, onDecision = () => {}, requestFetch,
}) {
  if (!namespace || !Number.isSafeInteger(compactThreshold) || compactThreshold < 1) {
    throw new Error("INVALID_CONTINUATION_CONFIG")
  }
  const wrap = call => (requestModel, transcript, options) => {
    if (options?.disableContinuation) return call(requestModel, transcript, options)
    const id = conversationId()
    if (!id) return call(requestModel, transcript, options)
    const scope = JSON.stringify([namespace, id, requestModel.baseUrl, requestModel.id])
    const stream = createStream()
    let rawInput, profile, terminal
    const underlying = call(requestModel, transcript, {
      ...options,
      ...(requestFetch ? { fetch: requestFetch } : {}),
      async onPayload(payload, resolvedModel) {
        const base = (await options?.onPayload?.(payload, resolvedModel)) ?? payload
        const { input, ...settings } = base
        if (!Array.isArray(input) || base.previous_response_id || base.conversation) {
          onDecision("unsupported_request")
          return base
        }
        rawInput = structuredClone(input)
        profile = digest(settings)
        let inputForNext = input
        let saved
        try { saved = store.get(scope) }
        catch { onDecision("unreadable_checkpoint") }
        if (isCheckpoint(saved)) {
          const committed = transcript.messages.findLast(msg =>
            msg.role === "assistant" && msg.responseId === saved.responseId)
          const through = input.findLastIndex(item => item.id === saved.endItem)
          const segment = input.slice(saved.prefixLength, through + 1)
          if (saved.profile === profile && through >= saved.prefixLength &&
              committed && digest(committed.content) === saved.replyDigest &&
              digest(input.slice(0, saved.prefixLength)) === saved.prefixDigest &&
              segment.every(item => saved.outputIds.includes(item.id))) {
            inputForNext = [...saved.window, ...input.slice(through + 1)]
            onDecision("replay")
          } else {
            // Keep the old row until a new valid checkpoint is written. A
            // stale/concurrent request must not erase another request's state.
            onDecision("rebuild")
          }
        } else {
          onDecision("transcript")
        }
        return {
          ...base, input: inputForNext, store: false,
          include: [...new Set([...(base.include ?? []), "reasoning.encrypted_content"])],
          context_management: [{ type: "compaction", compact_threshold: compactThreshold }],
        }
      },
      async onProviderStreamEvent(event, resolvedModel) {
        if (event.type === "response.completed" && event.response?.status === "completed") {
          terminal = structuredClone(event.response)
        }
        await options?.onProviderStreamEvent?.(event, resolvedModel)
      },
    })
    void (async () => {
      try {
        for await (const event of underlying) {
          if (event.type === "done" && event.reason === "stop" &&
              rawInput && terminal?.id && terminal.id === event.message.responseId &&
              terminal.output.some(item => item.type === "compaction")) {
            try {
              const window = automaticWindow(rawInput, terminal.output, "completed")
              const visible = terminal.output.filter(item => item.type === "message" && item.role === "assistant")
              // The text anchor may PRECEDE a final compaction item, so it
              // comes from terminal output, not from the replacement window.
              // Only install a checkpoint at a complete text reply. Earlier
              // tool exchanges remain supported by stock; tool-use terminals
              // and unknown wire items do not create checkpoints.
              const endItem = visible.at(-1)?.id
              if (endItem && Buffer.byteLength(JSON.stringify(window)) <= 8_000_000) {
                store.put(scope, {
                  profile, prefixLength: rawInput.length, prefixDigest: digest(rawInput),
                  replyDigest: digest(event.message.content), responseId: terminal.id,
                  endItem, outputIds: terminal.output.map(item => item.id).filter(Boolean), window,
                })
                onDecision("checkpoint")
              }
            } catch { onDecision("checkpoint_skipped") }
          }
          stream.push(event)
        }
      } finally { stream.end(await underlying.result()) }
    })()
    return stream
  }
  return createProvider({
    id: model.provider, models: [model], auth,
    api: { stream: wrap(stock.stream), streamSimple: wrap(stock.streamSimple) },
  })
}
