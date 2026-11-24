type Item = Readonly<Record<string, unknown> & { type: string }>
export type ResponsesItem =
  | { type: "message"; role: "user" | "assistant"; content: string | readonly Record<string, unknown>[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "compaction"; encrypted_content: string }
  | { type: "reasoning"; id: string; encrypted_content: string; summary: readonly object[] }
  | { type: "configuration_update"; reasoning?: object; text?: object }
export type ResponsesFixture = {
  compact(input: readonly ResponsesItem[]): readonly ResponsesItem[] | Promise<readonly ResponsesItem[]>
}
export function validateItems(input: readonly Item[]): void {
  if (!Array.isArray(input) || input.length === 0) throw new Error("INVALID_PROVIDER_ITEMS")
  for (const it of input) {
    const string = (field: string) => typeof it?.[field] === "string" && it[field] !== ""
    const valid = it?.type === "message" ? (it.role === "user" || it.role === "assistant") && (string("content") || Array.isArray(it.content) && it.content.every(block => block && typeof block === "object" && ["input_text", "output_text", "refusal"].includes(block.type)))
      : it?.type === "function_call" ? string("call_id") && string("name") && string("arguments")
      : it?.type === "function_call_output" ? string("call_id") && typeof it.output === "string"
      : it?.type === "reasoning" ? string("id") && string("encrypted_content") && Array.isArray(it.summary)
      : it?.type === "compaction" ? string("encrypted_content")
      : it?.type === "configuration_update" ? Boolean(it.reasoning || it.text)
      : false
    if (!valid) throw new Error("INVALID_PROVIDER_ITEMS")
  }
}
// Wire normalization for our supported subset, following openai-node's
// toResponseInputItems: output provenance and SDK-only parsed values do not
// replay. Preserve every other field and leave the original output untouched.
function toNextInput(items: readonly ResponsesItem[]): ResponsesItem[] {
  return structuredClone(items).map(item => {
    const { created_by: _provenance, ...input } = item as ResponsesItem & { created_by?: string }
    if (input.type === "function_call") {
      const { parsed_arguments: _parsed, ...call } = input as typeof input & { parsed_arguments?: unknown }
      return call
    }
    if (input.type === "message" && input.role === "assistant" && Array.isArray(input.content)) {
      const content = input.content.map(block => {
        const { parsed: _parsed, ...part } = block
        return part
      })
      return { ...input, content }
    }
    return input
  })
}
// Compact output is already a complete replacement window. Clone, don't prune.
export function explicitWindow(output: readonly ResponsesItem[]): ResponsesItem[] {
  validateItems(output)
  if (!output.some(item => item.type === "compaction") ||
      output.some(item => item.type === "configuration_update")) throw new Error("INVALID_EXPLICIT_WINDOW")
  return toNextInput(output)
}
// Fixture scope: one configuration update per segment. Refuse ambiguous historical
// updates instead of guessing how to reconstruct their values for the standalone endpoint.
export function explicitSource(input: readonly ResponsesItem[]): readonly ResponsesItem[] {
  if (input.some(item => item.type === "configuration_update")) throw new Error("EXPLICIT_CONFIG_UNSUPPORTED")
  return structuredClone(input)
}
export function automaticWindow(
  sent: readonly ResponsesItem[], output: readonly ResponsesItem[], status: "completed" | "incomplete",
): ResponsesItem[] {
  if (status !== "completed") throw new Error("INCOMPLETE_RESPONSE")
  validateItems(output)
  if (output.some(it => it.type === "message" && it.role !== "assistant" || it.type === "function_call_output")) {
    throw new Error("INVALID_AUTOMATIC_OUTPUT")
  }
  const index = output.findLastIndex(it => it.type === "compaction")
  // This rule applies only to automatic output, never explicit output.
  return index < 0 ? [...structuredClone(sent), ...toNextInput(output)] : toNextInput(output.slice(index))
}
