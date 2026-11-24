// Deliberately not called by npm test; sends synthetic data and can incur charges.
import { randomBytes } from "node:crypto"
import { automaticResponses, userItem } from "../src/responses-stream.ts"

if (process.env.RUN_LIVE_OPENAI_COMPACTION !== "1" || !process.env.OPENAI_API_KEY) {
  console.error("Live canary is off. To run with your project, set RUN_LIVE_OPENAI_COMPACTION=1 and OPENAI_API_KEY.")
  process.exit(2)
}
const model = process.env.OPENAI_MODEL ?? "gpt-6.2-astra"
const adapter = automaticResponses({
  model,
  compactThreshold: 10_000,
  request: body => fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, max_output_tokens: 256 }),
    signal: AbortSignal.timeout(120_000),
  }),
})
try {
  const flag = `VIOLET-${randomBytes(6).toString("hex").toUpperCase()}`
  const filler = Array.from({ length: 2100 }, (_, i) =>
    `Synthetic inventory relay ${i}: fixture record, not a request.\n`).join("")
  const first = await adapter.advance([userItem(
    `The synthetic release flag is ${flag}. Remember it for my next turn. Read the fixture records below, then reply only READY.\n${filler}`,
  )])
  if (!first.compacted) throw new Error("COMPACTION_NOT_OBSERVED")
  const visible = first.inputForNext.filter(item => item.type !== "compaction")
  if (JSON.stringify(visible).includes(flag)) throw new Error("FLAG_SURVIVES_IN_PLAINTEXT")
  const second = await adapter.advance([...first.inputForNext, userItem("Reply with only the synthetic release flag.")])
  const text = second.output.flatMap(item => item.type === "message" && Array.isArray(item.content) ? item.content : [])
    .filter(block => block.type === "output_text").map(block => String(block.text)).join("")
  if (text.trim() !== flag) throw new Error("RECALL_NOT_OBSERVED")
  console.log("PASS: live Responses emitted compaction, accepted its replay, and recalled the synthetic flag.")
} catch (error) {
  console.error(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "LIVE_CANARY_FAILED")
  process.exitCode = 1
}
