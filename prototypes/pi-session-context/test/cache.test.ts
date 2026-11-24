import assert from "node:assert/strict"
import test from "node:test"
import { comparePrefix, prefixFingerprint } from "../src/cache.ts"

const tools = { name: "tools", value: [{ name: "history_search", schema: "v1" }] }
const system = { name: "system", value: "stable rules" }
const turn = { name: "message:1", value: "original text" }
const base = prefixFingerprint([tools, system, turn])
test("cache comparison distinguishes append-only, compaction and changed schemas; never invents a hit", () => {
  assert.deepEqual(comparePrefix(base, prefixFingerprint([tools, system, turn, {
    name: "recall", value: "append result after its tool call",
  }])), { appendOnly: true, unchangedSections: 3, firstChangedSection: null, providerCacheHit: "unknown" })
  assert.deepEqual(comparePrefix(base, prefixFingerprint([tools, system, { name: "brief", value: "compressed" }])), {
    appendOnly: false, unchangedSections: 2, firstChangedSection: "message:1", providerCacheHit: "unknown",
  })
  assert.equal(comparePrefix(base, prefixFingerprint([{ ...tools, value: [] }, system, turn])).firstChangedSection, "tools")
})
