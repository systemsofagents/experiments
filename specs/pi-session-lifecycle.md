# Pi Durable session lifecycle

**Recommendation: use the existing fork API for a logical trim today. Pursue deletion first as a storage lifecycle API, not a context operation.** This note is based on Pi Durable 1.6.0 and the upstream [storage and transcript spec](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).

| Intent | API today | Storage effect |
| --- | --- | --- |
| Continue from entry E, excluding everything strictly after E | `conversation.fork(E, { ownership: { kind: "ownerless" } }, ctx)`, then make the new conversation active in the host | No reclamation. The parent still exists, and the fork references its inherited prefix. |
| Keep the same conversation and hide selected earlier contributions from the model | Submit a `write` containing `entry.edits` with `{ target, action: "omit" }` per visible entry | Appends an edit. Raw history, UI and recall still need their own policy. This does not rewind tool side effects or documents. |
| Drop old context and start from now | `conversation.reset(handoff, ctx)` | Appends a new head. It does not remove rows. |
| Delete a session from an open/shared store | No public delete operation in the 1.6.0 `Storage` mutation surface | Missing. Do not use raw table deletion on an open store. |

## First upstream proposal: closed-session destruction

Pi Durable's `Harness` owns one `Session` over a storage instance. For SQLite, use **one file per deletable session** to start (multiple conversations in the file can still share history). Own a small host catalog with TTL/quota, and dispose of a whole file only after owner confirmation when applicable, admission fencing, verified quiescence, and closure of all handles. An external lease or serialized host owner is needed; `close()` alone cannot prevent another process reopening the file. Any host-side indexes, backups and provider windows need the same lifecycle. Do not substitute deleting a root conversation for destroying its whole logical store.

Propose an optional backend-specific lifecycle capability with explicit session identity, idempotent destroy semantics, and a no-reopen fence. Start with closed per-file SQLite; require a backend to report unsupported rather than pretending that logical rows, shared stores and backups were reclaimed. Shared storage needs a separate reachability design to avoid deleting inherited records, referenced documents, live task state, or indexes. For a shared SQLite file, deletion usually frees pages for reuse before it reduces file size; checkpoint WAL and compact on an explicit maintenance schedule, not in the foreground delete. Retention is not secure erasure.

## Second proposal only if needed: same-ID logical rewind

Start with an extension that forks inclusively at a verified idle turn boundary and switches the host's active pointer. This is the smallest existing operation that also lets Pi apply its own fork semantics for rewindable documents. Test that an old suffix is absent from the new model context and UI branch but still visible from the old parent. Old provider state cannot transfer by default because it is bound to the old conversation identity; in-place model edits must invalidate it when they touch its covered prefix.

If host callers really need to preserve the same conversation ID, discuss a new explicit rewind operation with a revision precondition. Define what happens to pending submissions, background tasks, turn boundaries, rewindable and sticky documents, provider continuation, existing forks, and separately committed external side effects. Do not name this `trim` if readers are meant to infer disk reclamation. Physical suffix removal is a separate reachability/retention problem, and should not be the first PR.

The [restart fixture](../prototypes/pi-session-context/integration/pi-openai-restart.mjs) exercises fork isolation and provider-window invalidation after a context edit and a reset. Nothing here has been submitted upstream. The public [contribution guide](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) asks for maintainer approval before opening a PR.
