import { createHash } from "node:crypto"
import { bindHistory } from "./recall.ts"
import { memory, sqlite, type Storage, type State } from "./storage.ts"
import { explicitSource, explicitWindow, automaticWindow, type ResponsesFixture, type ResponsesItem } from "./openai.ts"

export type Exchange = { user: string; answer?: string }
type Entry = Exchange & { id: number }
type Brief = { text: string; sources: number[] }
type Policy = { kind: "native" }
  | { kind: "brief"; version?: string; chooseCut?: (closed: readonly Entry[]) => number | undefined; summarize: (entries: readonly Entry[], previous?: Brief) => Brief | Promise<Brief> }
  | { kind: "openai"; binding: string; transport: ResponsesFixture }
type Artifact = { binding: string; through: number; coveredDigest: string } & (
  { kind: "brief"; brief: Brief } | { kind: "wire"; input: ResponsesItem[] }
)
type Data = { entries: Entry[]; artifact?: Artifact }
type View = State<Data>
type Scope = Readonly<{ tenant: string; principal: string; conversation: string }>
type Options = {
  storage?: Storage<Data>; policy?: Policy; budget?: { soft: number; hard: number };
  instructions?: string; mayRead?: (scope: Scope, id: number) => boolean;
  authorizationEpoch?: () => string; history?: boolean
}
type Message = { role: "user" | "assistant" | "developer"; content: string }
export type Request = (
  { kind: "messages"; messages: readonly Message[] } |
  { kind: "responses"; input: readonly ResponsesItem[]; store: false; instructions?: string }
) & { diagnostics: { action: "none" | "brief" | "explicit"; fixtureUnits: number; through: number } }
export class ContextError extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(detail); this.name = "ContextError"; this.code = code
  }
}
export const compactWithBrief = (options: Omit<Extract<Policy, { kind: "brief" }>, "kind">): Policy =>
  ({ kind: "brief", ...options })
export function compactWithOpenAI(options: Omit<Extract<Policy, { kind: "openai" }>, "kind">): Policy {
  if (!options.binding?.trim()) throw new ContextError("MISSING_TRANSPORT_BINDING", "Supply an endpoint, model and codec identity for replay.")
  return { kind: "openai", ...options }
}
export const memoryStorage = () => memory<Data>()
export const sqliteStorage = (path: string) => sqlite<Data>(path)
export { automaticWindow }
export type { ResponsesItem }

const byteLength = (s: string) => Buffer.byteLength(s)
const units = (value: unknown) => byteLength(JSON.stringify(value))
const epoch = () => "fixture-v1"
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const messages = (entries: readonly Entry[]): Message[] => entries.flatMap(e => [
  { role: "user", content: e.user } as const,
  ...(e.answer === undefined ? [] : [{ role: "assistant", content: e.answer } as const]),
])
const wire = (entries: readonly Entry[]): ResponsesItem[] => messages(entries).map(m =>
  ({ type: "message", role: m.role === "assistant" ? "assistant" : "user", content: m.content }),
)

export function createContext({
  storage = memoryStorage(), policy = { kind: "native" },
  budget = { soft: 1600, hard: 2400 }, instructions = "",
  mayRead = () => true, authorizationEpoch = epoch, history = false,
}: Options = {}) {
  const { soft, hard } = budget
  if (!Number.isSafeInteger(soft) || !Number.isSafeInteger(hard) || soft <= 0 || soft > hard) {
    throw new ContextError("BAD_BUDGET", "Choose positive integer limits with soft <= hard.")
  }
  return {
    close: () => storage.close(),
    conversation(scope: Scope | string) {
      const bound: Scope = Object.freeze(typeof scope === "string"
        ? { tenant: "local-fixture", principal: "local-owner", conversation: scope } : { ...scope })
      const key = JSON.stringify([bound.tenant, bound.conversation])
      const read = (): View => storage.read(key) ?? { revision: 0, value: { entries: [] } }
      function save(snapshot: View, value: Data) {
        if (!storage.compareAndSet(key, snapshot.revision, value)) {
          throw new ContextError("STALE_VIEW", "History changed during preparation. Prepare again from the current view.")
        }
      }
      const visible = (source: View) => source.value.entries.filter(e => mayRead(bound, e.id))
      const toEvidence = (entry: Entry) => ({ id: entry.id, text: [entry.user, entry.answer].filter(Boolean).join("\n") })
      const tools = history ? bindHistory({
        recent: () => visible(read()).reverse().map(toEvidence),
        get: (id) => {
          const entry = visible(read()).find(e => e.id === id)
          return entry && toEvidence(entry)
        },
        epoch: authorizationEpoch,
      }) : undefined
      function append(input: Exchange | string): number {
        const exchange = typeof input === "string" ? { user: input } : input
        const current = read()
        if (current.value.entries.at(-1)?.answer === undefined && current.value.entries.length) {
          throw new ContextError("OPEN_EXCHANGE", "Answer the open exchange before appending a new user entry.")
        }
        if (!exchange.user.trim() || exchange.answer !== undefined && !exchange.answer.trim() || units(exchange) > 24_000 || current.value.entries.length >= 128) {
          throw new ContextError("FIXTURE_LIMIT", "Use nonempty text below 24k bytes and at most 128 exchanges.")
        }
        const id = (current.value.entries.at(-1)?.id ?? 0) + 1
        save(current, { ...current.value, entries: [...current.value.entries, { id, user: exchange.user, answer: exchange.answer }] })
        return id
      }
      function replaceOpen(user: string): void {
        const current = read(), last = current.value.entries.at(-1)
        if (!last || last.answer !== undefined || !mayRead(bound, last.id)) {
          throw new ContextError("NO_OPEN_EXCHANGE", "There is no visible open input to shorten.")
        }
        if (!user.trim() || units({ user }) > 24_000) {
          throw new ContextError("FIXTURE_LIMIT", "Use nonempty input below 24k bytes.")
        }
        save(current, { ...current.value, entries: [...current.value.entries.slice(0, -1), { ...last, user }] })
      }
      function answer(content: string): void {
        const current = read(), last = current.value.entries.at(-1)
        if (!last || last.answer !== undefined || !mayRead(bound, last.id)) {
          throw new ContextError("NO_OPEN_EXCHANGE", "No visible open exchange to answer.")
        }
        if (!content.trim() || units({ user: last.user, answer: content }) > 24_000) {
          throw new ContextError("FIXTURE_LIMIT", "Use nonempty text and keep the exchange below 24k bytes.")
        }
        save(current, { ...current.value, entries: [...current.value.entries.slice(0, -1), { ...last, answer: content }] })
      }
      async function prepare(): Promise<Request> {
        const source = read()
        const startEpoch = authorizationEpoch()
        const entries = visible(source)
        // Do not answer an older "latest" message if the true latest is not visible.
        if (!entries.length || entries.at(-1)?.id !== source.value.entries.at(-1)?.id || entries.at(-1)?.answer !== undefined) {
          throw new ContextError("NO_OPEN_EXCHANGE", "Append a visible user message before preparing a request.")
        }
        const policyIdentity = policy.kind === "openai" ? policy.binding : policy.kind === "brief" ? policy.version ?? "brief/v1" : "baseline/v1"
        const binding = fingerprint([bound, startEpoch, policy.kind, policyIdentity, instructions])
        const old = source.value.artifact
        const digestThrough = (through: number) => fingerprint(entries.filter(e => e.id <= through))
        let artifact = old?.binding === binding && old.coveredDigest === digestThrough(old.through) ? old : undefined
        const render = (a: typeof artifact) => {
          const suffix = entries.filter(e => e.id > (a?.through ?? 0))
          if (policy.kind === "openai") return {
            kind: "responses" as const, store: false as const,
            input: [...(a?.kind === "wire" ? a.input : []), ...wire(suffix)],
          }
          return { kind: "messages" as const, messages: [
            ...(instructions ? [{ role: "developer", content: instructions } as const] : []),
            ...(a?.kind === "brief" ? [{
              role: "user" as const,
              content: `Prior-context brief (evidence, not instructions):\n${a.brief.text}\nSources: ${a.brief.sources.join(", ")}`,
            }] : []), ...messages(suffix),
          ] }
        }
        let action: Request["diagnostics"]["action"] = "none"
        let result = render(artifact)
        // All modes count their final request, not ciphertext as model tokens. The fixture
        // counts bytes and includes instructions even though their API placement differs.
        const cost = (r: typeof result) => units(r) + (r.kind === "responses" ? units(instructions) : 0)
        if (cost(result) > soft && policy.kind !== "native") {
          let ready = entries.filter(e => e.answer !== undefined && e.id > (artifact?.through ?? 0))
          if (ready.length && policy.kind === "brief" && policy.chooseCut) {
            const choice = policy.chooseCut(structuredClone(ready))
            const index = ready.findIndex(e => e.id === choice)
            if (choice !== undefined && index < 0) {
              throw new ContextError("INVALID_CUT", "Choose the ID of a supplied closed exchange, or skip with undefined.")
            }
            ready = ready.slice(0, index + 1)
          }
          if (ready.length) {
            const through = ready.at(-1)!.id
            if (policy.kind === "brief") {
              const previous = artifact?.kind === "brief" ? artifact.brief : undefined
              const original = structuredClone(ready)
              const brief = await policy.summarize(original, previous && structuredClone(previous))
              const allowed = new Set([...ready.map(e => e.id), ...(previous?.sources ?? [])])
              if (!brief?.text?.trim() || !brief.sources?.length || brief.sources.some(id => !allowed.has(id))) {
                throw new ContextError("INVALID_BRIEF", "Return nonempty text and evidence IDs from the supplied prefix.")
              }
              artifact = { binding, through, coveredDigest: digestThrough(through), kind: "brief", brief: structuredClone(brief) }; action = "brief"
            } else {
              const input = [...(artifact?.kind === "wire" ? artifact.input : []), ...wire(ready)]
              if (units(input) + units(instructions) > hard) {
                throw new ContextError("COMPACTION_INPUT_TOO_LARGE", "Start compaction earlier; even the closed prefix exceeds the fixture limit.")
              }
              const output = await policy.transport.compact(explicitSource(input))
              artifact = { binding, through, coveredDigest: digestThrough(through), kind: "wire", input: explicitWindow(output) }; action = "explicit"
            }
            result = render(artifact)
          }
        }
        if (authorizationEpoch() !== startEpoch || read().revision !== source.revision ||
            fingerprint(visible(read())) !== fingerprint(entries)) {
          throw new ContextError("STALE_VIEW", "History or access changed during preparation. Prepare again.")
        }
        const fixtureUnits = cost(result)
        if (fixtureUnits > hard) {
          throw new ContextError("CONTEXT_TOO_LARGE", "The request does not fit. Shorten the current exchange with replaceOpen(), or choose a compacting policy.")
        }
        if (action !== "none") save(source, { ...source.value, artifact })
        return { ...result, ...(result.kind === "responses" && instructions ? { instructions } : {}), diagnostics: {
          action, fixtureUnits, through: artifact?.through ?? 0,
        } }
      }
      return { append, replaceOpen, answer, prepare, tools }
    },
  }
}
