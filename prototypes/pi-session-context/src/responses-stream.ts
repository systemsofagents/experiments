import { automaticWindow, validateItems, type ResponsesItem } from "./openai.ts"

export type ResponsesRequest = {
  model: string
  input: readonly ResponsesItem[]
  stream: true
  store: false
  include: readonly ["reasoning.encrypted_content"]
  context_management: readonly [{ type: "compaction"; compact_threshold: number }]
}
type Request = (body: ResponsesRequest) => Promise<Response>
type SSEEvent = { type: string; response?: { status?: string; output?: ResponsesItem[] } }
export const userItem = (content: string): ResponsesItem => ({ type: "message", role: "user", content })

// Small opt-in Responses transport for this experiment, not a pi-ai replacement.
// Use the typed, ordered terminal output as authoritative; never publish on partial events.
export function automaticResponses({ model, compactThreshold, request }: {
  model: string; compactThreshold: number; request: Request
}) {
  if (!model.trim() || !Number.isSafeInteger(compactThreshold) || compactThreshold <= 0) {
    throw new Error("BAD_COMPACTION_CONFIG")
  }
  return {
    async advance(input: readonly ResponsesItem[]) {
      validateItems(input)
      const sent = structuredClone(input)
      const response = await request({
        model, input: structuredClone(sent), stream: true, store: false,
        include: ["reasoning.encrypted_content"],
        context_management: [{ type: "compaction", compact_threshold: compactThreshold }],
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`RESPONSES_HTTP_${response.status}`)
      }
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel()
        throw new Error("RESPONSES_EXPECTED_STREAM")
      }
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true })
      let buffer = "", total = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if ((total += value.byteLength) > 8_000_000) throw new Error("RESPONSES_STREAM_TOO_LARGE")
          buffer += decoder.decode(value, { stream: true })
          let boundary: RegExpExecArray | null
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index)
            buffer = buffer.slice(boundary.index + boundary[0].length)
            const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
              .map(line => line.slice(5).replace(/^ /, "")).join("\n")
            if (!data || data === "[DONE]") continue
            let event: SSEEvent
            try { event = JSON.parse(data) as SSEEvent }
            catch { throw new Error("RESPONSES_MALFORMED_EVENT") }
            if (event.type === "response.incomplete" || event.type === "response.failed" || event.type === "error") {
              throw new Error("RESPONSES_NO_SUCCESSFUL_TERMINAL")
            }
            if (event.type !== "response.completed") continue
            if (event.response?.status !== "completed" || !event.response.output) throw new Error("RESPONSES_NO_SUCCESSFUL_TERMINAL")
            const output = event.response.output
            return {
              output: structuredClone(output),
              inputForNext: automaticWindow(sent, output, "completed"),
              compacted: output.some(it => it.type === "compaction"),
            }
          }
        }
        throw new Error("RESPONSES_NO_SUCCESSFUL_TERMINAL")
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    },
  }
}
