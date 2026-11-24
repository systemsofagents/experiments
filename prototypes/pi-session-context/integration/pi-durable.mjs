// Uses the repository's existing locked Pi 1.6.0 packages; no new installs in this prototype.
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { bindHistory } from "../src/recall.ts"

const demo = process.env.PI_EXAMPLE_DIR
  ? pathToFileURL(join(resolve(process.env.PI_EXAMPLE_DIR), "demo.mjs")).href
  : new URL("../../../explainers/examples/pi-durable-session/demo.mjs", import.meta.url).href
const fromExample = (name) => import(import.meta.resolve(name, demo))
const { BACKGROUND_CONTEXT: ctx } = await fromExample("@earendil-works/chord/context")
const { createModels } = await fromExample("@earendil-works/pi-ai/models")
const { fauxAssistantMessage, fauxProvider } = await fromExample("@earendil-works/pi-ai/providers/faux")
const { createRegistry, Harness } = await fromExample("@earendil-works/pi-durable")
const { openNodeSqliteStorage } = await fromExample("@earendil-works/pi-durable/storage/sqlite/node")

let summarySawFlag = false
const faux = fauxProvider({ models: [{ id: "fixture", contextWindow: 8000, maxTokens: 1000 }] })
faux.setResponses([
  ...Array.from({ length: 3 }, () => fauxAssistantMessage("No release verified.")),
  transcript => {
    summarySawFlag = /--cohort=violet/.test(JSON.stringify(transcript.messages))
    return fauxAssistantMessage("The release plan is open; the exact flag is recorded in prior release evidence.")
  },
])
const models = createModels()
models.setProvider(faux.provider)
const registry = createRegistry()

const folder = await mkdtemp(join(tmpdir(), "pi-recall-"))
let harness
try {
  const storage = await openNodeSqliteStorage(join(folder, "history.db"), { prefix: "recall_" })
  harness = await Harness.open(storage, {
    models, registry, settings: { compaction: { enabled: false, keepRecentTokens: 5, reserveTokens: 1000 } },
  }, ctx)
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "fixture" } } })
  const ask = async (content, entry) => {
    const result = await root.submit({ type: "input", content, ...(entry ? { entry } : {}) }, ctx)
    assert.equal((await result.wait(ctx)).status, "done")
  }
  await ask("Original ticket R-17: exact flag is --cohort=violet.", { kind: "recall.fixture" })
  await ask("Record that the plan is open.")
  await ask("Identify unresolved work.")
  assert.match(JSON.stringify((await root.context(ctx)).messages), /--cohort=violet/)
  const task = await root.compact(undefined, ctx)
  const { state } = await harness.waitForTask(task, ctx)
  assert.equal(state.outcome.status, "completed")
  if (state.outcome.result.submissionId !== undefined) {
    const placement = await harness.submission(state.outcome.result.submissionId, ctx)
    assert.equal((await placement.wait(ctx)).status, "done")
  }
  assert.ok(summarySawFlag)
  assert.doesNotMatch(JSON.stringify((await root.context(ctx)).messages), /--cohort=violet/)
  // This source authorizes only immutable synthetic entries with a dedicated kind.
  // Do not use this projection for general history that includes edits or secrets.
  const candidates = async () => (await root.entries({}, 32, undefined, ctx)).items
    .filter(entry => entry.kind === "recall.fixture" && typeof entry.model?.[0]?.content === "string")
    .map(entry => ({ id: entry.id, text: entry.model[0].content }))
  const history = bindHistory({
    recent: candidates,
    get: async id => (await candidates()).find(entry => entry.id === id),
    epoch: () => "immutable-demo",
  })
  const hit = (await history.search("R-17"))[0]
  assert.ok(hit)
  assert.match((await history.get(hit.ref)).excerpt, /--cohort=violet/)
  console.log("PASS: Pi 1.6.0 + SQLite + native compaction, omitted evidence recovered from the same durable session")
} finally {
  try { await harness?.close(ctx) }
  finally { await rm(folder, { recursive: true, force: true }) }
}
