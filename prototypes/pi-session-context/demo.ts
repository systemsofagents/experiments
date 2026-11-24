import { compactWithBrief, createContext, type Request } from "./src/index.ts"
import { comparePrefix, prefixFingerprint } from "./src/cache.ts"

const exchanges = [
  { user: "Verify the release qualifier. Ticket R-17 says the exact flag is --cohort=violet.", answer: "Recorded the flag." },
  { user: "Read the release plan. " + "Background material. ".repeat(36), answer: "No release verified." },
]
const native = createContext({ budget: { soft: 700, hard: 2500 }, instructions: "Use evidence." })
const compacted = createContext({
  history: true,
  budget: { soft: 700, hard: 2500 },
  instructions: "Use evidence.",
  policy: compactWithBrief({
    summarize: (prefix) => ({
      text: "Release plan open. No release verified. Search history for the exact qualifier.",
      sources: prefix.map(entry => entry.id),
    }),
  }),
})
try {
  const plain = native.conversation("release")
  const chat = compacted.conversation("release")
  for (const room of [plain, chat]) {
    for (const exchange of exchanges) room.append(exchange)
    room.append("What flag is required?")
  }
  const before = await plain.prepare()
  const after = await chat.prepare()
  const hits = await chat.tools!.search("R-17")
  console.log(`Before: ${before.diagnostics.fixtureUnits} fixture bytes, raw prefix`)
  console.log(`After:  ${after.diagnostics.fixtureUnits} fixture bytes, compacted through exchange ${after.diagnostics.through}`)
  console.log("Exact flag in request:", JSON.stringify(after).includes("--cohort=violet"))
  console.log("Why: a closed prefix crossed the soft ceiling; the newest user message stayed in the request.")
  console.log("Recall:", hits[0] ? await chat.tools!.get(hits[0].ref) : "No match")
  const fingerprint = (r: Request) => prefixFingerprint(r.kind === "messages"
    ? r.messages.map((value, i) => ({ name: `message[${i}]:${value.role}`, value })) : [])
  const rotated = comparePrefix(fingerprint(before), fingerprint(after))
  chat.answer("The exact flag is --cohort=violet.")
  chat.append("Which ticket defines it?")
  const stable = comparePrefix(fingerprint(after), fingerprint(await chat.prepare()))
  console.log(`Cache comparison: compaction changes ${rotated.firstChangedSection}; next turn is ${stable.appendOnly ? "append-only" : "rewritten"}.`)
  console.log("Provider cache hit: unknown (offline)")
} finally {
  native.close()
  compacted.close()
}
