import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bindHistory } from "../src/recall.ts"
import { durableResponsesProvider, openContinuationStore } from "../src/pi-openai-durable.mjs"
import { automaticWindow } from "../src/openai.ts"

const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const live = process.env.RUN_LIVE_OPENAI_COMPACTION === "1"
const [phase, folder] = process.argv.slice(2)
if (!phase) {
  if (live && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for live mode")
  const directory = await mkdtemp(join(tmpdir(), "pi-openai-restart-"))
  try {
    for (const step of ["before", "after"]) {
      const result = spawnSync(process.execPath, [
        "--experimental-import-meta-resolve", fileURLToPath(import.meta.url), step, directory,
      ], { stdio: "inherit", timeout: 240_000 })
      if (result.error || result.status !== 0) throw new Error(`RESTART_PHASE_FAILED:${step}`)
    }
    console.log(`PASS: ${live ? "live" : "fixture"} OpenAI Responses through stock Pi adapter; separate process reopened SQLite, replayed the exact window + new suffix, and recalled original evidence.`)
  } finally { await rm(directory, { recursive: true, force: true }) }
} else {
  await runChild(phase, folder)
}

async function runChild(step, directory) {
  const demo = process.env.PI_EXAMPLE_DIR
    ? pathToFileURL(join(resolve(process.env.PI_EXAMPLE_DIR), "demo.mjs")).href
    : new URL("../../../explainers/examples/pi-durable-session/demo.mjs", import.meta.url).href
  const fromExample = name => import(import.meta.resolve(name, demo))
  const { BACKGROUND_CONTEXT: ctx } = await fromExample("@earendil-works/chord/context")
  const { createModels, createProvider } = await fromExample("@earendil-works/pi-ai/models")
  const { createAssistantMessageEventStream } = await fromExample("@earendil-works/pi-ai/utils/event-stream")
  const { openaiProvider } = await fromExample("@earendil-works/pi-ai/providers/openai")
  const stock = await fromExample("@earendil-works/pi-ai/api/openai-responses")
  const { createRegistry, Harness } = await fromExample("@earendil-works/pi-durable")
  const { openNodeSqliteStorage } = await fromExample("@earendil-works/pi-durable/storage/sqlite/node")

  const dbPath = join(directory, "session.sqlite")
  const store = openContinuationStore(dbPath)
  const receiptPath = join(directory, "receipt.json")
  const receipt = step === "after" ? JSON.parse(await readFile(receiptPath, "utf8")) : {
    pid: process.pid, flag: `VIOLET-${randomBytes(6).toString("hex").toUpperCase()}`,
  }
  const modelId = process.env.OPENAI_MODEL ?? "gpt-6.2-astra"
  const model = {
    id: modelId, name: modelId, api: "openai-responses", provider: "openai",
    baseUrl: "https://api.openai.com/v1", reasoning: true, thinkingLevelMap: { off: null }, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 256,
  }
  const key = live ? process.env.OPENAI_API_KEY : "fixture-key"
  const requests = [], decisions = [], statuses = []
  const requestFetch = async (url, init) => {
    const request = new Request(url, init)
    assert.equal(new URL(request.url).origin, "https://api.openai.com")
    const payload = await request.clone().json()
    requests.push(payload)
    if (live) {
      const response = await fetch(request)
      statuses.push(String(response.status))
      if (!response.ok) {
        const error = (await response.clone().json().catch(() => null))?.error
        const label = value => typeof value === "string" && /^[a-zA-Z0-9_.\[\]-]{1,80}$/.test(value) ? value : "-"
        console.error("Provider rejection:", label(error?.code), label(error?.param))
      }
      return response
    }
    const count = requests.length
    const isSeed = step === "before" && count === 1
    const isReplay = step === "after" && count === 1
    const text = isSeed ? "READY" : isReplay ? receipt.flag : "RESET"
    const item = {
      id: `msg_${step}_${count}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }
    const output = isSeed ? [
      // A terminal ordered window with more than the opaque item.
      { type: "compaction", id: "cmp_fixture", encrypted_content: "fixture-opaque" }, item,
    ] : [item]
    if (isSeed && process.env.FIXTURE_TRAILING_COMPACTION === "1") {
      output.push({ type: "compaction", id: "cmp_after_reply", encrypted_content: "fixture-opaque-final" })
    }
    const response = { id: `resp_${step}_${count}`, status: "completed", output }
    const index = output.indexOf(item)
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: index, item: { ...item, content: [] } },
      { type: "response.output_item.done", output_index: index, item },
      { type: "response.completed", response },
    ]
    if (isSeed) receipt.windowHash = sha(automaticWindow(payload.input, output, "completed"))
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } })
  }
  let root, harness
  try {
    const models = createModels()
    models.setProvider(durableResponsesProvider({
      createProvider, createStream: createAssistantMessageEventStream, stock, model,
      auth: live ? openaiProvider().auth : { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: key } }) } },
      store, namespace: live ? "live-synthetic-project" : "fixture",
      conversationId: () => root?.id, compactThreshold: 10_000,
      onDecision: decision => decisions.push(decision), requestFetch,
    }))
    // Set the key only in the test process, not in SQLite, request receipts or logs.
    process.env.OPENAI_API_KEY = key
    const storage = await openNodeSqliteStorage(dbPath, { prefix: "restart_" })
    harness = await Harness.open(storage, {
      models, registry: createRegistry(), settings: { compaction: { enabled: false } },
    }, ctx)
    root = await harness.root(ctx, { agent: { model: { provider: "openai", modelId } } })
    const ask = async (content, entry) => {
      const submission = await root.submit({ type: "input", content, ...(entry ? { entry } : {}) }, ctx)
      assert.equal((await submission.wait(ctx)).status, "done")
      const result = (await root.context(ctx)).messages.findLast(message => message.role === "assistant")
      if (live && result?.stopReason !== "stop") console.error("Pi stop reason:", result?.stopReason, result?.rawStopReason)
      assert.equal(result?.stopReason, "stop", "Pi did not commit a successful reply")
      return result.content.filter(block => block.type === "text").map(block => block.text).join("").trim()
    }
    const scope = JSON.stringify([live ? "live-synthetic-project" : "fixture", root.id, model.baseUrl, model.id])
    if (step === "before") {
      const filler = live ? Array.from({ length: 2100 }, (_, i) =>
        `Synthetic inventory relay ${i}: fixture record, not a request.\n`).join("") : ""
      assert.equal(await ask(`Ticket R-17: the exact synthetic release flag is ${receipt.flag}. Remember for next turn. Reply only READY.\n${filler}`, { kind: "recall.fixture" }), "READY")
      assert.deepEqual(decisions, ["transcript", "checkpoint"])
      const checkpoint = store.get(scope)
      assert.ok(checkpoint?.window.some(item => item.type === "compaction"))
      if (live) receipt.windowHash = sha(checkpoint.window)
      assert.equal(sha(checkpoint.window), receipt.windowHash)
      assert.equal(JSON.stringify(checkpoint.window.filter(item => item.type !== "compaction")).includes(receipt.flag), false)
      receipt.root = root.id
    } else {
      assert.notEqual(receipt.pid, process.pid)
      assert.equal(receipt.root, root.id)
      const { window } = store.get(scope)
      assert.equal(sha(window), receipt.windowHash)
      assert.equal(await ask("Reply with only the exact synthetic release flag."), receipt.flag)
      assert.equal(decisions[0], "replay")
      const input = requests[0].input
      assert.deepEqual(input.slice(0, window.length), window)
      assert.equal(input.length, window.length + 1)
      assert.equal(input.at(-1).role, "user")
      assert.equal(JSON.stringify(input.filter(item => item.type !== "compaction")).includes(receipt.flag), false)
      // Exact authorized recovery comes from Pi, not from guessing what the
      // encrypted window means or asking the model to reconstruct the source.
      const rows = async () => (await root.entries({}, 32, undefined, ctx)).items
        .filter(entry => entry.kind === "recall.fixture" && typeof entry.model?.[0]?.content === "string")
        .map(entry => ({ id: entry.id, text: entry.model[0].content }))
      const history = bindHistory({
        recent: rows, get: async id => (await rows()).find(entry => entry.id === id),
        epoch: () => "immutable-synthetic-fixture",
      })
      const hit = (await history.search("R-17"))[0]
      assert.ok(hit)
      assert.ok((await history.get(hit.ref)).excerpt.includes(receipt.flag), "Exact transcript recall failed")
      if (!live) {
        const original = (await rows())[0]
        const branch = await root.fork(original.id, { ownership: { kind: "ownerless" } }, ctx)
        const branchContext = JSON.stringify((await branch.context(ctx)).messages)
        assert.ok(branchContext.includes(receipt.flag))
        assert.ok(!branchContext.includes("Reply with only the exact synthetic release flag."))
        assert.ok(JSON.stringify((await root.context(ctx)).messages).includes("Reply with only the exact synthetic release flag."))
        const edit = await root.submit({ type: "write", entry: {
          kind: "recall.fixture-edit", edits: [{ target: original.id, action: "omit" }],
        } }, ctx)
        assert.equal((await edit.wait(ctx)).status, "done")
        await ask("Reply only RESET after edit.")
        assert.equal(decisions.at(-1), "rebuild")
        assert.ok(requests.at(-1).input.every(item => item.type !== "compaction"))
        assert.ok(!JSON.stringify(requests.at(-1).input).includes("Ticket R-17:"))
      }
      await root.reset(undefined, ctx)
      await ask("Reply only RESET.")
      assert.equal(decisions.at(-1), "rebuild")
      assert.ok(requests.at(-1).input.every(item => item.type !== "compaction"))
      assert.equal(JSON.stringify(requests.at(-1).input).includes(receipt.flag), false)
    }
  } catch (err) {
    if (live) {
      // Neither provider error bodies nor assertion diffs belong in logs.
      console.error(`Live phase ${step} failed: decisions=${decisions.join(",")} HTTP=${statuses.join(",")}; ${err.code ?? err.name} at line ${err.stack?.split("\n").find(line => line.includes("runChild"))?.match(/:(\d+):\d+\)?$/)?.[1] ?? "?"}`)
      process.exitCode = 1
      return
    }
    throw err
  } finally {
    try { await harness?.close(ctx) } finally { store.close() }
  }
  if (step === "before") await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  console.log(`PASS: ${step === "before" ? "compaction committed; Pi and SQLite closed" : "wire replay, exact recall, reset fallback"}`)
}
