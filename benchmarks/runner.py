"""Ordered benchmark driver. Python 3.11+, standard library only."""
from __future__ import annotations

import argparse
import importlib
import json
import re
import statistics
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Event:
    id: str
    role: str
    text: str
    timestamp: str = ""


@dataclass(frozen=True)
class Request:
    id: str
    text: str


@dataclass(frozen=True)
class Reply:
    answer: str
    sources: tuple[str, ...] = ()
    usage: dict | None = None
    retrieved: tuple[str, ...] | None = None


def load_hook(spec):
    module, name = spec.split(":", 1)
    return getattr(importlib.import_module(module), name)


def run_case(case, make_agent, grade, *, forced_after=(), max_actions=8, diagnostics=None):
    """An episode may be fixed replay, or a trusted adapter may supply a fresh world."""
    agent = make_agent()
    seen = set()
    turns = []
    cuts = []
    count = 0
    world = None
    def compact(trigger):
        start = time.perf_counter()
        receipt = agent.compact(trigger)
        cuts.append({"after": count, "trigger": trigger,
                     "ms": round(1000 * (time.perf_counter() - start), 2),
                     "receipt": receipt})

    def observe(event):
        nonlocal count
        if event.id in seen:
            raise ValueError(f"Duplicate event ID: {event.id}")
        seen.add(event.id)
        agent.observe(event)
        count += 1
        if count in forced_after:
            compact("forced")
        elif getattr(agent, "should_compact", lambda: False)():
            compact("policy")

    def activate(request):
        start = time.perf_counter()
        reply = agent.activate(request)
        if not isinstance(reply, Reply):
            raise TypeError("activate must return a Reply")
        unknown = (set(reply.sources) | set(reply.retrieved or ())) - seen
        if unknown:
            raise ValueError(f"Reply cites unseen events: {sorted(unknown)}")
        turns.append({"request_id": request.id, "answer": reply.answer,
                      "sources": list(reply.sources), "usage": reply.usage,
                      "retrieved": None if reply.retrieved is None else list(reply.retrieved),
                      "ms": round(1000 * (time.perf_counter() - start), 2)})
        return reply

    try:
        for item in case["history"]:
            observe(Event(**item))
        if "world" not in case:
            if "schedule" in case:
                for item in case["schedule"]:
                    if set(item) == {"observe"}:
                        observe(Event(**item["observe"]))
                    elif set(item) == {"activate"}:
                        activate(Request(**item["activate"]))
                    else:
                        raise ValueError("schedule expects observe or activate")
            else:
                for item in case["prompts"]:
                    activate(Request(**item))
        else:
            world = case["world"]()
            request = world.start()
            for _ in range(max_actions):
                if request is None:
                    break
                reply = activate(request)
                observations, request = world.step(reply.answer)
                for event in observations:
                    observe(event)
            if request is not None:
                raise RuntimeError("world exceeded action budget")
        evidence = set(case.get("evidence", []))
        groups = case.get("source_groups", {})
        def recall(ids):
            return len({groups.get(i, i) for i in ids} & evidence) / len(evidence) if evidence else None
        retrieval = [i for turn in turns for i in (turn["retrieved"] or [])]
        return {"id": case["id"], "category": case.get("category", "other"),
                "score": grade(case, turns, world), "activations": turns, "cuts": cuts,
                "diagnostics": diagnostics(case, turns) if diagnostics else {},
                "citation_recall": recall(i for turn in turns for i in turn["sources"]),
                "retrieval_recall": recall(retrieval) if any(t["retrieved"] is not None for t in turns) else None}
    finally:
        try:
            if world is not None and hasattr(world, "close"):
                world.close()
        finally:
            if hasattr(agent, "close"):
                agent.close()


def summarize(rows):
    def mean(values):
        values = [v for v in values if v is not None]
        return statistics.mean(values) if values else None
    def p95(values):
        values = sorted(values)
        return values[(95 * len(values) - 1) // 100] if values else None
    kinds = sorted({r["category"] for r in rows})
    return {
        "episodes": len(rows), "mean_score": mean(r["score"] for r in rows),
        "by_category": {k: mean(r["score"] for r in rows if r["category"] == k) for k in kinds},
        "mean_citation_recall": mean(r["citation_recall"] for r in rows),
        "mean_retrieval_recall": mean(r["retrieval_recall"] for r in rows),
        "stale_actions": sum(r["diagnostics"].get("stale_action", False) for r in rows),
        "activation_p95_ms": p95(t["ms"] for r in rows for t in r["activations"]),
        "compaction_p95_ms": p95(t["ms"] for r in rows for t in r["cuts"]),
        "cut_requests": sum(len(r["cuts"]) for r in rows),
        "applied_compactions": sum(c["receipt"].get("applied") is True for r in rows for c in r["cuts"]),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("benchmark", help="built-in name, or importable module exposing cases() and grade()")
    p.add_argument("--data", type=Path, help="local dataset export; never downloaded implicitly")
    p.add_argument("--agent", action="append", help="repeat for paired arms; module:factory, factory(config)")
    p.add_argument("--config", type=json.loads, default={}, help="shared JSON object; no secrets")
    p.add_argument("--arm", action="append", default=[], metavar="NAME=MODULE:FACTORY=JSON",
                   help="named agent arm with per-arm JSON overrides; repeatable")
    p.add_argument("--matrix", type=Path, help="JSON file with named arms: {name: {factory, config}}")
    p.add_argument("--limit", type=int, default=0, help="0 = all; adapter may stratify")
    p.add_argument("--seed", type=int, default=17)
    p.add_argument("--cut-after", type=int, action="append", default=[], help="force after N observations")
    p.add_argument("--max-actions", type=int, default=8)
    p.add_argument("--out", type=Path, help="new JSON file with per-case receipts; no raw history")
    args = p.parse_args()
    if args.limit < 0 or args.max_actions < 1 or any(n < 1 for n in args.cut_after):
        p.error("limit must be nonnegative; max-actions and cut positions must be positive")
    if not isinstance(args.config, dict):
        p.error("--config must be a JSON object")
    if args.benchmark not in {"session", "replay"} and not (args.agent or args.arm or args.matrix):
        p.error("choose an agent explicitly for this benchmark")
    aliases = {"session", "longmemeval", "beam", "replay"}
    benchmark = (getattr(importlib.import_module("datasets_builtin"), args.benchmark)
                 if args.benchmark in aliases else importlib.import_module(args.benchmark))
    arms = []
    for spec in args.agent or ([] if args.arm or args.matrix else ["agents:full", "agents:tail", "agents:recall"]):
        arms.append((spec, spec, args.config))
    for raw in args.arm:
        try:
            name, spec, value = raw.split("=", 2)
            cfg = json.loads(value)
            if not name or not isinstance(cfg, dict):
                raise ValueError
        except ValueError:
            p.error("--arm expects NAME=MODULE:FACTORY=JSON_OBJECT")
        arms.append((name, spec, args.config | cfg))
    if args.matrix:
        matrix = json.loads(args.matrix.read_text(encoding="utf-8"))
        for name, entry in matrix.items():
            arms.append((name, entry["factory"], args.config | entry.get("config", {})))
    if not arms:
        p.error("provide at least one arm")
    names = [a[0] for a in arms]
    if len(set(names)) != len(names):
        p.error("arm names must be unique")
    runs = {name: [] for name in names}
    factories = [(name, load_hook(spec), cfg) for name, spec, cfg in arms]
    case_ids = set()
    for case in benchmark.cases(args.data, args.limit, args.seed):
        if not isinstance(case["id"], str) or case["id"] in case_ids:
            raise ValueError("case IDs must be unique strings")
        case_ids.add(case["id"])
        for name, factory, cfg in factories:
            runs[name].append(run_case(case, lambda: factory(dict(cfg)), benchmark.grade,
                                       forced_after=args.cut_after, max_actions=args.max_actions,
                                       diagnostics=getattr(benchmark, "diagnostics", None)))
    if not case_ids:
        p.error("no episodes selected")
    summaries = {name: summarize(rows) for name, rows in runs.items()}
    print(json.dumps(summaries, indent=2, allow_nan=False))
    if args.out:
        report = {"schema": 1, "benchmark": args.benchmark,
                  "score_kind": getattr(benchmark, "score_kind", "adapter-defined"), "seed": args.seed,
                  "data": str(args.data) if args.data else None,
                  "cut_after": args.cut_after, "max_actions": args.max_actions,
                  "arms": {name: {"factory": spec, "config": cfg} for name, spec, cfg in arms},
                  "summary": summaries, "runs": runs}
        with args.out.open("x", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False, allow_nan=False)
            f.write("\n")


if __name__ == "__main__":
    # Plugins import the same dataclasses when run as a script.
    import sys
    sys.modules.setdefault("runner", sys.modules[__name__])
    main()
