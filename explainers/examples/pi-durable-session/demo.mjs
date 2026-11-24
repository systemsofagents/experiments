import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  CompactionEntry, CompactionTask, createRegistry, defineExtension,
  GenerationTask, Harness, hook,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-demo-"));
const db = join(scratch, "session.db");
const raw = "Build label OLD-LABEL; inspect the release plan.";
const edited = "Build label CURRENT-LABEL; inspect the release plan.";
let request = "";
let compactionInput = "";
const faux = fauxProvider({ models: [{ id: "test", contextWindow: 8000, maxTokens: 1000 }] });
faux.setResponses(Array.from({ length: 12 }, () => (transcript) => {
  request = JSON.stringify(transcript.messages);
  return fauxAssistantMessage("Fixture response.");
}));
const models = createModels();
models.setProvider(faux.provider);

const TutorialPolicies = defineExtension({
  name: "tutorial-policies",
  hooks: [
    hook(GenerationTask, {
      beforeRequest({ messages }) {
        // Example only: replace a literal in text-only user messages.
        return {
          messages: messages.map((m) =>
            m.role === "user" && typeof m.content === "string"
              ? { ...m, content: m.content.replaceAll("CURRENT-LABEL", "[project-label]") }
              : m,
          ),
        };
      },
    }),
    hook(CompactionTask, {
      beforeCompact({ reason, instructions, messages, firstKept }) {
        // Only the synthetic fixture deliberately opts into this lossy summary.
        if (reason !== "manual" || instructions !== "tutorial-fixture") return;
        compactionInput = JSON.stringify(messages);
        return {
          kind: "summary",
          summary: `Tutorial handoff (kept entry starts at ${firstKept}): the release plan is open; no release was verified.`,
        };
      },
    }),
  ],
});

async function open() {
  const registry = createRegistry();
  registry.install(TutorialPolicies);
  const storage = await openNodeSqliteStorage(db, { prefix: "tutorial_" });
  return Harness.open(storage, {
    models, registry,
    settings: { compaction: { enabled: false, keepRecentTokens: 5, reserveTokens: 1000 } },
  }, ctx);
}

let harness;
try {
  harness = await open();
  let root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "test" } } });
  async function ask(content, entry) {
    const submission = await root.submit({ type: "input", content, ...(entry ? { entry } : {}) }, ctx);
    assert.equal((await submission.wait(ctx)).status, "done");
  }
  const history = () => root.entries({}, 100, undefined, ctx);
  await ask(raw, { kind: "tutorial.input", data: { source: "fixture", schema: 1 } });
  const original = (await history()).items.find((row) => row.kind === "tutorial.input");
  assert.ok(original);
  assert.equal(original.model[0].content, raw);
  assert.deepEqual(original.data, { source: "fixture", schema: 1 });
  assert.doesNotMatch(request, /"source":"fixture"/);

  // Persist a context override, not a rewrite of the original row.
  await root.commit((tx) => tx.appendEntry(root.id, {
    kind: "tutorial.correction",
    data: { reason: "replace stale label" },
    edits: [{ target: original.id, action: "replace", messages: [{ ...original.model[0], content: edited }] }],
  }), ctx);
  const serialize = (x) => JSON.stringify(x);
  assert.match(serialize((await root.context(ctx)).messages), /CURRENT-LABEL/);

  await harness.close(ctx);
  harness = await open();
  root = await harness.root(ctx);
  assert.match(serialize((await root.context(ctx)).messages), /CURRENT-LABEL/);
  assert.match(serialize((await history()).items.find((e) => e.id === original.id)), /OLD-LABEL/);

  await ask("Record pending work, without claiming it shipped.");
  assert.match(request, /\[project-label\]/);
  assert.doesNotMatch(request, /CURRENT-LABEL|OLD-LABEL/);
  await ask("What should we verify next?");
  const task = await root.compact("tutorial-fixture", ctx);
  const { state } = await harness.waitForTask(task, ctx);
  assert.equal(state.outcome.status, "completed");
  const { submissionId } = state.outcome.result;
  if (submissionId !== undefined) {
    const placement = await harness.submission(submissionId, ctx);
    assert.ok(placement);
    assert.equal((await placement.wait(ctx)).status, "done");
  }
  const projected = await root.context(ctx);
  assert.ok(CompactionEntry.is(projected.head));
  assert.match(serialize(projected.messages), /no release was verified/);
  assert.match(compactionInput, /CURRENT-LABEL/);
  assert.doesNotMatch(compactionInput, /\[project-label\]/);
  assert.match(serialize((await history()).items.find((e) => e.id === original.id)), /OLD-LABEL/);
  console.log("PASS: SQLite reopen, stored metadata, persistent edit, request-only projection, and compaction with intact raw history");
} finally {
  try { await harness?.close(ctx); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
