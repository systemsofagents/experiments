import assert from "node:assert/strict"
import test from "node:test"
import { automaticResponses, userItem, type ResponsesRequest } from "../src/responses-stream.ts"

const sealed = { type: "compaction", id: "cmp1", encrypted_content: "fixture:opaque", unknown_field: "preserved" } as const
const config = { type: "configuration_update", reasoning: { effort: "high" } } as const
const call = { type: "function_call", call_id: "same-call", name: "history_search", arguments: '{"query":"R-17"}' } as const
const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Flag is violet", annotations: [] }] } as const
const old = userItem("old transcript chunk")
const end = (output: unknown[]) => ({ type: "response.completed", response: { status: "completed", output } })
function sse(...events: unknown[]) {
  const data = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""))
  const chunks = Array.from({ length: Math.ceil(data.length / 13) }, (_, i) => data.slice(i * 13, (i + 1) * 13))
  return new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  }), { headers: { "content-type": "text/event-stream" } })
}

test("automatic Responses transport posts real compaction request fields and replays terminal items into next request", async () => {
  const requests: ResponsesRequest[] = []
  const adapter = automaticResponses({ model: "gpt-6.2-astra", compactThreshold: 32000,
    async request(body) {
      requests.push(body)
      return requests.length === 1
        ? sse({ type: "response.output_item.done", output_index: 1, item: sealed },
          end([answer, { ...sealed, created_by: "output-only" }, config, { ...call, parsed_arguments: { query: "R-17" } }]))
        : sse(end([answer]))
    },
  })
  const active = await adapter.advance([old])
  assert.deepEqual(requests[0], {
    model: "gpt-6.2-astra", input: [old], stream: true, store: false,
    include: ["reasoning.encrypted_content"],
    context_management: [{ type: "compaction", compact_threshold: 32000 }],
  })
  assert.equal(active.compacted, true)
  assert.deepEqual(active.inputForNext, [sealed, config, call])
  const result = { type: "function_call_output", call_id: "same-call", output: "R-17: flag violet" } as const
  const next = await adapter.advance([...active.inputForNext, result])
  assert.deepEqual(requests[1]?.input, [sealed, config, call, result])
  assert.deepEqual(next.inputForNext, [sealed, config, call, result, answer])
})

test("automatic Responses refuses partial, failed and unknown terminal items, even after a well-formed compaction item", async () => {
  const options = { model: "gpt-6.2-astra", compactThreshold: 32_000 }
  for (const fixture of [
    [ { type: "response.output_item.done", item: sealed } ],
    [ { type: "response.failed" } ],
    [ end([sealed, { type: "new_unknown_variant", private_payload: "not logged" }]) ],
  ]) {
    const adapter = automaticResponses({ ...options, async request() { return sse(...fixture) } })
    await assert.rejects(adapter.advance([old]), /RESPONSES_NO_SUCCESSFUL_TERMINAL|INVALID_PROVIDER_ITEMS/)
  }
})
