import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { automaticWindow, compactWithBrief, compactWithOpenAI, createContext, memoryStorage, sqliteStorage } from "../src/index.ts"

const budgets = { soft: 600, hard: 1800 }
const evidence = { user: "R-17: exact flag is --cohort=violet. " + "notes ".repeat(95), answer: "Not released." }
const brief = compactWithBrief({ summarize: prefix => ({ text: "Check the release evidence.", sources: prefix.map(p => p.id) }) })
const storageCases = ["memory", "sqlite"] as const
for (const name of storageCases) test(`${name}: compact, retain evidence, isolate handles and reopen`, async () => {
  const folder = mkdtempSync(join(tmpdir(), "context-test-"))
  const db = join(folder, "state.sqlite")
  const mem = memoryStorage()
  const open = () => createContext({ history: true, storage: name === "memory" ? mem : sqliteStorage(db), policy: brief, budget: budgets })
  let app = open()
  try {
    const chat = app.conversation("release"), unrelated = app.conversation("other")
    chat.append(evidence)
    chat.append("What flag is needed?")
    const request = await chat.prepare()
    const hit = (await chat.tools!.search("R-17"))[0]!
    assert.equal(request.diagnostics.action, "brief")
    assert.equal(request.diagnostics.through, 1)
    assert.match(JSON.stringify(request), /What flag is needed/)
    assert.doesNotMatch(JSON.stringify(request), /--cohort/)
    assert.match((await chat.tools!.get(hit.ref))!.excerpt, /--cohort=violet/)
    assert.equal((await unrelated.tools!.get(hit.ref)), undefined)
    assert.deepEqual((await unrelated.tools!.search("R-17")), [])
    app.close()
    app = open()
    const restored = app.conversation("release")
    assert.equal((await restored.prepare()).diagnostics.action, "none")
    assert.equal((await restored.tools!.get(hit.ref)), undefined)
    const fresh = (await restored.tools!.search("R-17"))[0]!
    assert.match((await restored.tools!.get(fresh.ref))!.excerpt, /--cohort=violet/)
  } finally {
    app.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("native is baseline; a monster newest turn fails before generation", async () => {
  const app = createContext({ budget: budgets })
  const chat = app.conversation("native")
  chat.append(evidence)
  chat.append("Latest turn?")
  assert.match(JSON.stringify(await chat.prepare()), /--cohort=violet/)
  chat.answer("Use the checked flag.")
  chat.append("new ".repeat(800))
  await assert.rejects(chat.prepare(), { code: "CONTEXT_TOO_LARGE" })
})

test("explicit fake retains full typed window and rejects old authority after a revoke", async () => {
  let visible = true
  let calls = 0
  const retained = { type: "message", role: "user", content: "retained by provider" } as const
  const sealed = { type: "compaction", encrypted_content: "fake:opaque", future_field: "must round trip" } as const
  const app = createContext({
    budget: budgets, history: true, mayRead: (_, id) => visible || id !== 1,
    policy: compactWithOpenAI({ binding: "fake/responses-input-v1/model-a", transport: { compact(input) {
      calls++
      assert.match(JSON.stringify(input), /--cohort=violet/)
      assert.doesNotMatch(JSON.stringify(input), /Latest turn/)
      return [retained, sealed]
    } } }),
  })
  const chat = app.conversation("release")
  chat.append(evidence)
  chat.append("Latest turn?")
  const hit = (await chat.tools!.search("R-17"))[0]!
  const first = await chat.prepare()
  assert.equal(first.kind, "responses")
  if (first.kind !== "responses") return
  assert.equal(first.store, false)
  assert.deepEqual(first.input, [retained, sealed, { type: "message", role: "user", content: "Latest turn?" }])
  const second = await chat.prepare()
  assert.equal(calls, 1)
  assert.equal(second.diagnostics.action, "none")
  visible = false
  const revoked = await chat.prepare()
  assert.doesNotMatch(JSON.stringify(revoked), /fake:opaque|retained by provider/)
  assert.equal((await chat.tools!.get(hit.ref)), undefined)
  assert.deepEqual((await chat.tools!.search("R-17")), [])
})

test("automatic replay keeps config and call order, unlike explicit replay", () => {
  const call = { type: "function_call", call_id: "c1", name: "history_search", arguments: '{"query":"R-17"}' } as const
  const config = { type: "configuration_update", reasoning: { effort: "high" }, text: { format: "fixture" } } as const
  const sealed = { type: "compaction", encrypted_content: "fake:auto" } as const
  const sent = [{ type: "message", role: "user", content: "old" }] as const
  assert.deepEqual(automaticWindow(sent, [sealed, config, call], "completed"), [sealed, config, call])
  assert.deepEqual(automaticWindow(sent, [call], "completed"), [...sent, call])
  assert.throws(() => automaticWindow(sent, [sealed], "incomplete"), /INCOMPLETE_RESPONSE/)
})

test("race: never publishes a brief if the open exchange changes during compaction", async () => {
  let finish!: () => void
  const pause = new Promise<void>(resolve => { finish = resolve })
  const app = createContext({ budget: budgets, policy: compactWithBrief({ async summarize(prefix) {
    await pause
    return { text: "Context for old exchange", sources: prefix.map(e => e.id) }
  } }) })
  const chat = app.conversation("release")
  chat.append(evidence); chat.append("Old question")
  const pending = chat.prepare()
  chat.answer("Answered separately")
  chat.append("New question")
  finish()
  await assert.rejects(pending, { code: "STALE_VIEW" })
  const newRequest = await chat.prepare()
  assert.equal(newRequest.diagnostics.action, "brief")
  assert.match(JSON.stringify(newRequest), /New question/)
  assert.doesNotMatch(JSON.stringify(newRequest), /Old question/)
})

test("custom cut retains the newer closed exchange, and rejects the open one", async () => {
  let cut = 1
  const app = createContext({
    budget: budgets,
    policy: compactWithBrief({ chooseCut: () => cut, summarize: p => ({ text: "Earlier evidence", sources: p.map(e => e.id) }) }),
  })
  const chat = app.conversation("release")
  chat.append(evidence); chat.append({ user: "Keep this exact note.", answer: "Done." }); chat.append("What now?")
  cut = 3
  await assert.rejects(chat.prepare(), { code: "INVALID_CUT" })
  cut = 1
  const result = await chat.prepare()
  assert.equal(result.diagnostics.through, 1)
  assert.doesNotMatch(JSON.stringify(result), /--cohort/)
  assert.match(JSON.stringify(result), /Keep this exact note/)
})

test("transport change discards persisted opaque state and recompacts original evidence", async () => {
  const storage = memoryStorage()
  const open = (binding: string) => createContext({
    storage, budget: budgets, policy: compactWithOpenAI({ binding, transport: { compact(input) {
      assert.doesNotMatch(JSON.stringify(input), /sealed:/)
      return [{ type: "compaction", encrypted_content: `sealed:${binding}` }]
    } } }),
  }).conversation("release")
  const room = open("fake/project-a/model-a/input-v1")
  room.append(evidence); room.append("What now?")
  assert.match(JSON.stringify(await room.prepare()), /sealed:fake\/project-a/)
  const changed = await open("fake/project-b/model-a/input-v1").prepare()
  assert.match(JSON.stringify(changed), /sealed:fake\/project-b/)
  assert.doesNotMatch(JSON.stringify(changed), /project-a/)
})

test("default doesn't expose recall; handle for a late match returns that match", async () => {
  assert.equal(createContext().conversation("fixture").tools, undefined)
  const chat = createContext({ history: true }).conversation("fixture")
  chat.append({ user: "long ".repeat(300) + "release=violet", answer: "done" })
  const hit = (await chat.tools!.search("release=violet"))[0]!
  const got = await chat.tools!.get(hit.ref)
  assert.match(got!.excerpt, /release=violet/)
  assert.ok(got!.span.start > 512)
})

test("oversize hint can be followed without inserting fake history", async () => {
  const chat = createContext({ budget: budgets }).conversation("fixture")
  chat.append("oversized ".repeat(300))
  await assert.rejects(chat.prepare(), { code: "CONTEXT_TOO_LARGE" })
  chat.replaceOpen("Shortened request")
  assert.match(JSON.stringify(await chat.prepare()), /Shortened request/)
  assert.doesNotMatch(JSON.stringify(await chat.prepare()), /oversized/)
})
