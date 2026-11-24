"""Write BEAM's per-conversation answer JSON for its upstream rubric scorer."""
import argparse
import json
from pathlib import Path

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("report", type=Path)
    p.add_argument("arm")
    p.add_argument("data", type=Path, help="the same BEAM chat-size directory used for the run")
    p.add_argument("destination", type=Path, help="new results directory")
    args = p.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    if report["benchmark"] != "beam":
        p.error("expected a BEAM report")
    groups = {}
    probes = {}
    for row in report["runs"][args.arm]:
        conversation, category, index = row["id"].split("/")
        if conversation not in probes:
            source = args.data / conversation / "probing_questions" / "probing_questions.json"
            probes[conversation] = json.loads(source.read_text(encoding="utf-8"))
        responses = groups.setdefault(conversation, {}).setdefault(category, [])
        if int(index) != len(responses):
            p.error("grader uses positional indices: cannot export skipped or reordered probes")
        responses.append({"question": probes[conversation][category][int(index)]["question"],
                          "llm_response": row["activations"][0]["answer"]})
    args.destination.mkdir()
    for conversation, answers in groups.items():
        folder = args.destination / conversation
        folder.mkdir()
        (folder / "soa.json").write_text(json.dumps(answers, ensure_ascii=False, indent=2),
                                        encoding="utf-8")
