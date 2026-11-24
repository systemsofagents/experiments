// Native Pi Durable SQLite + stock cut/placement with a deterministic faux model.
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

const demo = new URL("../explainers/examples/pi-durable-session/demo.mjs", import.meta.url).href
const pkg = name => import(import.meta.resolve(name, demo))
const { BACKGROUND_CONTEXT: ctx } = await pkg("@earendil-works/chord/context")
const { createModels } = await pkg("@earendil-works/pi-ai/models")
const { fauxAssistantMessage, fauxProvider } = await pkg("@earendil-works/pi-ai/providers/faux")
const { createRegistry, Harness } = await pkg("@earendil-works/pi-durable")
const { openNodeSqliteStorage } = await pkg("@earendil-works/pi-durable/storage/sqlite/node")

const dir = await mkdtemp(join(tmpdir(), "bench-pi-"))
let harness, root, config, since = 0
const archive = []
const faux = fauxProvider({ models: [{ id: "fixture", contextWindow: 8000, maxTokens: 1000 }] })
const models = createModels()
models.setProvider(faux.provider)

function readFields(messages) {
  const fields = new Map()
  // Only parse JSON records we wrote to native Pi, not generic instruction text.
  for (const message of messages) {
    if (typeof message.content !== "string") continue
    try {
      const record = JSON.parse(message.content)
      if (!record.event) continue
      for (const [, key, value] of record.event.text.matchAll(/([A-Z][A-Z_]+)=([a-z0-9_-]+)/g))
        fields.set(key, [value, record.event.id])
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return fields
}

async function submit(content) {
  const handle = await root.submit({ type: "input", content }, ctx)
  assert.equal((await handle.wait(ctx)).status, "done")
}

const handlers = {
  async init({ config: options }) {
    config = options
    const storage = await openNodeSqliteStorage(join(dir, "history.db"), { prefix: "bench_" })
    harness = await Harness.open(storage, {
      models, registry: createRegistry(),
      settings: { compaction: { enabled: false, keepRecentTokens: config.keep_recent_tokens ?? 5,
                               reserveTokens: 1000 } },
    }, ctx)
    root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "fixture" } } })
    return null
  },
  async observe({ event }) {
    archive.push({ content: JSON.stringify({ event }) })
    faux.setResponses([fauxAssistantMessage("Recorded.")])
    await submit(JSON.stringify({ event }))
    since++
    return null
  },
  should_compact() {
    return config.compact !== false && config.cut_every > 0 && since >= config.cut_every
  },
  async compact() {
    if (config.compact === false) return { applied: false }
    let summaryCalls = 0
    faux.setResponses([() => {
      summaryCalls++
      return fauxAssistantMessage("The release is still pending. Check the original records for exact settings.")
    }])
    const id = await root.compact(undefined, ctx)
    const { state } = await harness.waitForTask(id, ctx)
    assert.equal(state.outcome.status, "completed")
    if (state.outcome.result?.submissionId !== undefined) {
      const placement = await harness.submission(state.outcome.result.submissionId, ctx)
      assert.equal((await placement.wait(ctx)).status, "done")
    }
    since = 0
    return { applied: summaryCalls > 0, runtime: "Pi Durable 1.6.0 + SQLite", model: "faux" }
  },
  async activate({ request }) {
    let reply
    faux.setResponses([input => {
      const useArchive = config.recall === true
      const fields = readFields(useArchive ? archive : input.messages)
      const confirm = /confirm/i.test(request.text)
      const wanted = confirm ? ["RECEIPT"] : ["REGION", "FLAG"]
      const chosen = wanted.map(key => fields.get(key))
      reply = chosen.every(Boolean)
        ? { answer: [confirm ? "confirm" : "deploy", ...chosen.map(x => x[0])].join(" "),
            sources: [...new Set(chosen.map(x => x[1]))] }
        : { answer: "unknown", sources: [] }
      return fauxAssistantMessage(reply.answer)
    }])
    await submit(JSON.stringify({ request }))
    assert.ok(reply)
    return reply
  },
}

try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const msg = JSON.parse(line)
      if (!Object.hasOwn(handlers, msg.method)) throw new Error("unknown method")
      const result = await handlers[msg.method](msg)
      console.log(JSON.stringify({ result }))
    } catch (error) {
      console.error(error.message)
      console.log(JSON.stringify({ error: "Pi fixture operation failed" }))
    }
  }
} finally {
  try { await harness?.close(ctx) }
  finally { await rm(dir, { recursive: true, force: true }) }
}
