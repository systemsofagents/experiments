import { createHash, randomUUID } from "node:crypto"

export type Evidence = { id: number; text: string }
type MaybePromise<T> = T | Promise<T>
type Source = {
  // Supply only scoped, authorized rows, newest first; bound work before materializing.
  recent: () => MaybePromise<readonly Evidence[]>
  get: (id: number) => MaybePromise<Evidence | undefined>
  epoch: () => string
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
function excerpt(text: string, at: number, limit: number) {
  let kept = "", size = 0
  for (const char of text.slice(at)) {
    if ((size += Buffer.byteLength(char)) > limit) break
    kept += char
  }
  return { excerpt: kept, span: { start: at, end: at + kept.length } }
}
export function bindHistory(source: Source) {
  const refs = new Map<string, { id: number; epoch: string; expires: number; start: number; original: string }>()
  return {
    async search(query: string) {
      if (!query.trim() || Buffer.byteLength(query) > 128) return []
      const epoch = source.epoch()
      const needle = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu")
      const candidates = await source.recent()
      if (source.epoch() !== epoch) return []
      const matches = []
      for (const e of candidates.slice(0, 128)) {
        const at = needle.exec(e.text)?.index ?? -1
        if (at < 0) continue
        const ref = randomUUID(), start = Math.max(0, at - 40)
        if (refs.size >= 64) refs.delete(refs.keys().next().value!)
        refs.set(ref, { id: e.id, epoch, expires: Date.now() + 300_000, start, original: digest(e.text) })
        matches.push({ ref, source: e.id, ...excerpt(e.text, start, 160) })
        if (matches.length === 5) break
      }
      return matches
    },
    async get(ref: string) {
      const handle = refs.get(ref)
      if (!handle || handle.expires <= Date.now() || handle.epoch !== source.epoch()) return undefined
      const found = await source.get(handle.id)
      if (!found || handle.epoch !== source.epoch() || digest(found.text) !== handle.original) return undefined
      const part = excerpt(found.text, handle.start, 512)
      return { source: found.id, ...part, truncated: part.excerpt !== found.text }
    },
  }
}
