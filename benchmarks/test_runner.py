import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agents
import datasets_builtin as data
import memoryarena_formal as arena
import responses
from runner import Event, Reply, Request, run_case, summarize


class RunnerTests(unittest.TestCase):
    def test_repeated_cuts_and_paired_worlds(self):
        case, = data.session.cases(None, 1, 17)
        cuts = [3, 6, 9]
        rows = [run_case(case, lambda: arm({}), data.session.grade, forced_after=cuts)
                for arm in (agents.full, agents.tail, agents.recall)]
        self.assertEqual([row["score"] for row in rows], [1, 0, 1])
        self.assertEqual([r["after"] for r in rows[-1]["cuts"]], cuts)
        self.assertEqual(rows[-1]["retrieval_recall"], 1)
        self.assertEqual(summarize(rows)["cut_requests"], 9)

    def test_schedule_has_no_future_knowledge(self):
        case = {"id": "chronology", "history": [], "gold": ["unknown", "new"],
                "schedule": [{"activate": {"id": "before", "text": "Answer?"}},
                             {"observe": {"id": "e", "role": "user", "text": "ANSWER=new"}},
                             {"activate": {"id": "after", "text": "Answer?"}}]}
        row = run_case(case, lambda: agents.full({}), data.qa_grade)
        self.assertEqual(row["score"], 1)
        self.assertEqual(row["activations"][0]["sources"], [])

    def test_lme_groups(self):
        record = {"question_id": "q", "question_type": "knowledge-update", "question": "Answer?",
                  "question_date": "2025-01-01", "answer": "gold",
                  "haystack_sessions": [[{"role": "user", "content": "ANSWER=gold", "has_answer": True}]],
                  "haystack_dates": ["2024-01-01"], "haystack_session_ids": ["s"],
                  "answer_session_ids": ["s"]}
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "data.json"
            path.write_text(json.dumps([record]), encoding="utf-8")
            case, = data.longmemeval.cases(path, 1, 17)
        self.assertNotIn("has_answer", str(case["history"]))
        row = run_case(case, lambda: agents.full({}), data.qa_grade)
        self.assertEqual(row["score"], 1)
        self.assertEqual(row["citation_recall"], 1)

    def test_policy_and_cleanup(self):
        case, = data.session.cases(None, 1, 17)
        agent = agents.tail({"cut_every": 3})
        row = run_case(case, lambda: agent, data.session.grade)
        self.assertEqual([r["trigger"] for r in row["cuts"]], ["policy"] * 3)
        with self.assertRaisesRegex(RuntimeError, "action budget"):
            run_case(case, lambda: agents.full({}), data.session.grade, max_actions=1)

    def test_unseen_citation_rejected(self):
        case, = data.session.cases(None, 1, 17)
        agent = agents.full({})
        agent.activate = lambda request: Reply("unknown", ("future",))
        with self.assertRaisesRegex(ValueError, "unseen"):
            run_case(case, lambda: agent, data.session.grade)

    def test_real_responses_contract_offline(self):
        saved = {"type": "compaction", "encrypted_content": "opaque"}
        retained = {"role": "user", "content": "preserved"}
        answer = {"status": "completed", "output": [{"type": "message",
                  "content": [{"type": "output_text", "text": '{"answer":"ok","sources":[]}'}]}]}
        with patch.dict("os.environ", {"OPENAI_API_KEY": "synthetic"}), patch(
                "responses._post", side_effect=[{"output": [retained, saved]}, answer]) as post:
            r = responses.compact({"allow_network": True, "model": "synthetic"})
            r.observe(Event("old", "user", "old content"))
            self.assertTrue(r.compact("forced")["applied"])
            self.assertEqual(r.activate(Request("q", "question")).answer, "ok")
        self.assertTrue(post.call_args_list[0].args[0].endswith("/responses/compact"))
        self.assertEqual(post.call_args_list[1].args[2]["input"][:2], [retained, saved])
        self.assertIs(post.call_args_list[1].args[2]["store"], False)

    def test_arena_does_not_expose_reward_or_gold(self):
        tasks = [("first", "REF1", "background"), ("second", "REF2", "background")]
        case = {"id": "arena", "history": [],
                "world": lambda: arena.World(tasks, {"env_url":"http://localhost:8001", "env_name":"math"})}
        received = []
        agent = agents.full({})
        agent.observe = received.append
        agent.activate = lambda req: Reply("my work")
        fake = {"observation": {"final":"my work", "judge_result":"private"}, "reward":1}
        with patch("memoryarena_formal._post", side_effect=[{}, {}, fake, fake, {}]) as post:
            row = run_case(case, lambda: agent, arena.grade, max_actions=2)
        self.assertEqual(row["score"], 1)
        self.assertEqual(json.loads(received[0].text), {"task":"first", "prior_answer":"my work"})
        self.assertEqual(post.call_args_list[2].args[2]["ground_truth"], "REF1")
        self.assertTrue(post.call_args_list[-1].args[0].endswith("/close"))


if __name__ == "__main__":
    unittest.main()
