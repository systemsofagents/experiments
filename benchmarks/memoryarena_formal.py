"""MemoryArena math/physics adapter; uses the upstream environment judge."""
import json
import uuid
from urllib.parse import urlparse

from agents import _post
from runner import Event, Request

score_kind = "memoryarena-formal-final-reward"


class World:
    def __init__(self, tasks, config):
        self.tasks = tasks
        self.config = config
        self.task_id = str(uuid.uuid4())
        self.index = 0
        self.rewards = []

    def send(self, endpoint, **params):
        return _post(self.config["env_url"].rstrip("/") + "/env/" + endpoint, {},
                     {"task_id": self.task_id, **params}, self.config)

    def prompt(self):
        question, _, background = self.tasks[self.index]
        return Request(str(self.index), f"Background:\n{background}\n\nProblem:\n{question}")

    def start(self):
        self.send("initialize", env_name=self.config["env_name"],
                  env_config=self.config.get("env_config", {}))
        self.send("reset")
        return self.prompt()

    def step(self, answer):
        question, gold, _ = self.tasks[self.index]
        result = self.send("step", action=answer, ground_truth=gold, need_judge=True)
        # No score, ground truth, or judge feedback may enter the agent's history.
        output = result["observation"]["final"]
        reward = result["reward"]
        if not isinstance(reward, (int, float)) or not 0 <= reward <= 1:
            raise ValueError("upstream judge did not return a normalized reward")
        self.rewards.append(reward)
        event = Event(f"subtask-{self.index}", "assistant",
                      json.dumps({"task": question, "prior_answer": output}, ensure_ascii=False))
        self.index += 1
        return (event,), self.prompt() if self.index < len(self.tasks) else None

    def close(self):
        self.send("close")


def cases(path, limit, seed):
    if path is None:
        raise ValueError("--data must point to the MemoryArena environment config")
    config = json.loads(path.read_text(encoding="utf-8"))
    target = urlparse(config["env_url"])
    if (config.get("allow_network") is not True or target.scheme != "http" or
            target.hostname not in {"localhost", "127.0.0.1", "::1"} or
            config["env_name"] not in {"math", "phys"}):
        raise ValueError("enable allow_network and use a loopback math or phys environment")
    with (path.parent / config["tasks"]).open(encoding="utf-8") as file:
        for i, line in enumerate(line for line in file if line.strip()):
            if limit and i >= limit:
                break
            raw = json.loads(line)
            tasks = list(zip(raw["questions"], raw["answers"], raw["backgrounds"], strict=True))
            if not tasks:
                raise ValueError("empty MemoryArena task")
            yield {"id": str(raw["id"]), "category": "formal-" + config["env_name"],
                   "history": [], "world": lambda tasks=tasks: World(tasks, config)}


def grade(case, turns, world):
    return world.rewards[-1]
