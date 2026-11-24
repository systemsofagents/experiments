"""Export predictions for the official LongMemEval judge."""
import argparse
import json
from pathlib import Path

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("report", type=Path)
    p.add_argument("arm")
    p.add_argument("destination", type=Path)
    args = p.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    if report["benchmark"] != "longmemeval":
        p.error("expected a LongMemEval report")
    with args.destination.open("x", encoding="utf-8") as dest:
        for row in report["runs"][args.arm]:
            (turn,) = row["activations"]
            dest.write(json.dumps({"question_id": row["id"], "hypothesis": turn["answer"]},
                                  ensure_ascii=False) + "\n")
