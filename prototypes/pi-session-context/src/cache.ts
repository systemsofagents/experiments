import { createHash } from "node:crypto"

type Section = Readonly<{ name: string; value: unknown }>
// Call from an adapter with its actual ordered, cache-relevant sections, not raw entries.
export function prefixFingerprint(sections: readonly Section[]) {
  return sections.map(({ name, value }) => ({
    name, digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  }))
}

export function comparePrefix(before: ReturnType<typeof prefixFingerprint>, after: ReturnType<typeof prefixFingerprint>) {
  let unchanged = 0
  while (unchanged < Math.min(before.length, after.length) &&
    before[unchanged]!.name === after[unchanged]!.name &&
    before[unchanged]!.digest === after[unchanged]!.digest) unchanged++
  return {
    unchangedSections: unchanged,
    firstChangedSection: before[unchanged]?.name ?? null,
    appendOnly: unchanged === before.length && after.length >= before.length,
    providerCacheHit: "unknown" as const,
  }
}
