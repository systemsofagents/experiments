"""Built-in task adapters. Gold labels are not sent to agent hooks."""
from __future__ import annotations

import json
import random
from collections import defaultdict
from types import SimpleNamespace

from runner import Event, Request


def select(rows, limit, seed, key):
    if not limit or limit >= len(rows):
        return rows
    groups = defaultdict(list)
    for row in rows:
        groups[key(row)].append(row)
    rng = random.Random(seed)
    for group in groups.values():
        rng.shuffle(group)
    out = []
    while len(out) < limit:
        for name in sorted(groups):
            if groups[name] and len(out) < limit:
                out.append(groups[name].pop())
    return out


def norm(value):
    return " ".join(str(value).casefold().split())


def qa_grade(case, turns, world):
    """Exact-match smoke metric. Use the original grader for publishable scores."""
    return sum(norm(t["answer"]) == norm(g) for t, g in zip(turns, case["gold"], strict=True)) / len(turns)


def lme_cases(path, limit, seed):
    if path is None:
        raise ValueError("longmemeval requires --data pointing to the official cleaned JSON")
    with path.open(encoding="utf-8") as file:
        rows = json.load(file)
    if not isinstance(rows, list):
        raise ValueError("expected LongMemEval JSON array")
    for row in select(rows, limit, seed, lambda r: (r["question_type"], r["question_id"].endswith("_abs"))):
        history = []
        for when, source, session in zip(row["haystack_dates"], row["haystack_session_ids"],
                                         row["haystack_sessions"], strict=True):
            # One observation per source turn; IDs support gold evidence at session granularity.
            for i, turn in enumerate(session):
                history.append({"id": f"{source}/{i}", "role": turn["role"],
                                "text": turn["content"], "timestamp": when})
        gold_sources = set(row["answer_session_ids"])
        yield {"id": row["question_id"], "category": row["question_type"] +
               ("/abstain" if row["question_id"].endswith("_abs") else ""),
               "history": history, "prompts": [{"id": row["question_id"], "text":
                     f"As of {row['question_date']}: {row['question']}"}],
               "evidence": sorted(gold_sources), "gold": [row["answer"]],
               "source_groups": {e["id"]: e["id"].rsplit("/", 1)[0] for e in history}}


def replay_cases(path, limit, seed):
    if path is None:
        raise ValueError("replay requires --data pointing to JSONL")
    with path.open(encoding="utf-8") as file:
        for i, line in enumerate(line for line in file if line.strip()):
            if limit and i >= limit:
                break
            row = json.loads(line)
            if not (row.get("prompts") or row.get("schedule")):
                raise ValueError("replay with no prompts")
            yield row


def beam_cases(path, limit, seed):
    """Read one upstream size directory, e.g. BEAM/chats/100K. One fresh episode per probe."""
    if path is None or not path.is_dir():
        raise ValueError("beam requires --data pointing to one upstream chat-size directory")
    emitted = 0
    for folder in sorted(path.iterdir(), key=lambda p: (len(p.name), p.name)):
        if not folder.name.isdecimal() or not folder.is_dir():
            continue
        with (folder / "chat.json").open(encoding="utf-8") as file:
            chat = json.load(file)
        with (folder / "probing_questions" / "probing_questions.json").open(encoding="utf-8") as file:
            probes = json.load(file)
        # The 10M export groups batches in ordered plan objects.
        batches = [b for plan in chat for group in plan.values() for b in group] \
            if chat and "turns" not in chat[0] else chat
        history = [{"id": str(m["id"]), "role": m["role"], "text": m["content"],
                    "timestamp": m.get("time_anchor") or batch.get("time_anchor") or ""}
                   for batch in batches for turn in batch["turns"] for m in turn]
        for kind, questions in probes.items():
            for index, probe in enumerate(questions):
                if limit and emitted >= limit:
                    return
                key = f"{folder.name}/{kind}/{index}"
                yield {"id": key, "category": kind, "history": history,
                       "prompts": [{"id": key, "text": probe["question"]}],
                       "evidence": [str(x) for x in (probe.get("source_chat_ids") or [])
                                    if isinstance(x, (str, int))]}
                emitted += 1


class World:
    """A deterministic toy workspace. No external tools or credentials."""
    def __init__(self, region, flag, receipt):
        self.expected = f"deploy {region} {flag}"
        self.receipt = receipt
        self.deployed = False
        self.confirmed = False

    def start(self):
        return Request("deploy", "Deploy using the current REGION and exact FLAG from prior evidence. "
                       "Return 'deploy <region> <flag>' or 'unknown'.")

    def step(self, answer):
        if not self.deployed:
            self.deployed = norm(answer) == self.expected
            if not self.deployed:
                return (), None
            evidence = Event("deploy-receipt", "tool", f"Deploy completed. RECEIPT={self.receipt}.")
            return (evidence,), Request("confirm", "Confirm the deployment with the exact RECEIPT. "
                                        "Return 'confirm <receipt>' or 'unknown'.")
        self.confirmed = norm(answer) == f"confirm {self.receipt}"
        return (), None


def _history(region, old, flag):
    fields = [
        ("user", f"Initial deploy setting: REGION={old}."),
        ("tool", f"Ticket contains exact FLAG={flag}."),
        ("assistant", "Deploy remains open."),
        ("tool", "Scanned archived tests; output only includes CI green."),
        ("user", f"Correction: current deploy setting is REGION={region}. Use it, not the initial setting."),
        ("assistant", "Noted the user's correction."),
        ("tool", "CI retry finished; no new settings."),
        ("user", "Keep deployment pending while I check readiness."),
        ("assistant", "Waiting."),
    ]
    return [{"id": f"e{i}", "role": role, "text": text} for i, (role, text) in enumerate(fields, 1)]


def session_cases(path, limit, seed):
    if path is not None:
        raise ValueError("session uses generated fixtures; use replay or a custom adapter for a file")
    rows = [("north", "south", "violet"), ("west", "east", "orange"), ("blue", "green", "silver")]
    for i, (region, old, flag) in enumerate(rows[:limit or None], 1):
        receipt = f"r-{i}"
        yield {"id": f"uncapped-{i}", "category": "correction+exact-evidence",
               "history": _history(region, old, flag), "evidence": ["e2", "e5"],
               "world": lambda r=region, f=flag, v=receipt: World(r, f, v),
               "stale_action": f"deploy {old} {flag}"}


def session_grade(case, turns, world):
    return int(world.deployed and world.confirmed)


session = SimpleNamespace(cases=session_cases, grade=session_grade, score_kind="fixture-task-success",
                          diagnostics=lambda case, turns: {
                              "stale_action": norm(turns[0]["answer"]) == case["stale_action"],
                              "abstained": norm(turns[0]["answer"]) == "unknown",
                          })
longmemeval = SimpleNamespace(cases=lme_cases, grade=qa_grade, score_kind="exact-match-smoke")
beam = SimpleNamespace(cases=beam_cases, grade=lambda *_: None, score_kind="ungraded-use-beam-rubric")
replay = SimpleNamespace(cases=replay_cases, grade=qa_grade, score_kind="exact-match")
