"""One isolated JSONL sidecar process per episode (Node/Pi or another runtime)."""
from dataclasses import asdict
import json
import os
import subprocess
import queue
from threading import Thread

from runner import Reply


class Bridge:
    def __init__(self, config):
        argv = config["argv"]
        if not isinstance(argv, list) or not argv or any(not isinstance(x, str) for x in argv):
            raise ValueError("argv must be a nonempty array of strings")
        env = {k: v for k, v in os.environ.items()
               if k in {"PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "HOME",
                        "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG"} or k in config.get("pass_env", [])}
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     text=True, encoding="utf-8", env=env)
        self.timeout = float(config.get("timeout", 120))
        self.lines = queue.Queue()
        def pump():
            try:
                for line in self.proc.stdout:
                    self.lines.put(line)
            finally:
                self.lines.put(None)
        Thread(target=pump, daemon=True).start()
        try:
            self.call("init", config=config.get("sidecar", {}))
        except BaseException:
            self.close()
            raise

    def call(self, method, **params):
        self.proc.stdin.write(json.dumps({"method": method, **params}) + "\n")
        self.proc.stdin.flush()
        try:
            line = self.lines.get(timeout=self.timeout)
        except queue.Empty:
            self.proc.kill()
            raise TimeoutError(f"sidecar timed out during {method}") from None
        if not line:
            raise RuntimeError(f"sidecar exited or closed stdout during {method}")
        reply = json.loads(line)
        if "error" in reply or "result" not in reply:
            raise RuntimeError(f"sidecar rejected {method}; see sidecar stderr")
        return reply["result"]

    def observe(self, event):
        self.call("observe", event=asdict(event))

    def should_compact(self):
        return self.call("should_compact") is True

    def compact(self, trigger):
        return self.call("compact", trigger=trigger)

    def activate(self, request):
        result = self.call("activate", request=asdict(request))
        return Reply(result["answer"], tuple(result.get("sources", ())), result.get("usage"),
                     tuple(result["retrieved"]) if result.get("retrieved") is not None else None)

    def close(self):
        try:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        finally:
            self.proc.stdout.close()


def command(config):
    return Bridge(config)
