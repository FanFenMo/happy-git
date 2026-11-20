"""Run a fixed manifest of collection plans sequentially against the local platform."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def now():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


class BatchRun:
    def __init__(self, arguments):
        self.arguments = arguments
        self.manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
        self.output = arguments.output_dir
        self.output.mkdir(parents=True, exist_ok=True)
        self.parts = self.output / "batches"
        self.parts.mkdir(exist_ok=True)
        arguments.state_dir.mkdir(parents=True, exist_ok=True)
        self.state_file = arguments.state_dir / "progress.json"
        self.lock = (arguments.state_dir / "run.lock").open("a")
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fingerprint = digest(arguments.manifest)
        if self.state_file.exists():
            self.state = json.loads(self.state_file.read_text(encoding="utf-8"))
            if self.state["manifestSha256"] != fingerprint:
                raise ValueError("The run manifest changed; use a separate run directory")
        else:
            self.state = {
                "runId": self.manifest["runId"], "manifestSha256": fingerprint,
                "startedAt": now(), "phase": "starting", "batchCount": len(self.manifest["plans"]),
                "firstBatch": self.manifest["firstBatch"], "lastBatch": self.manifest["lastBatch"],
                "batches": [],
            }

    def api(self, path, body=None):
        request = urllib.request.Request(
            self.arguments.base_url + "/api/platform/" + path,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers={"Authorization": "Bearer " + os.environ["HG_ADMIN_TOKEN"],
                     "Content-Type": "application/json"},
            method="GET" if body is None else "POST",
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)

    def publish(self, phase, current=None):
        self.state.update({"updatedAt": now(), "phase": phase,
                           "processedBatches": len(self.state["batches"]),
                           "completedBatches": sum(b["status"] in ("completed", "completed_with_failures")
                                                   for b in self.state["batches"])})
        if current is not None:
            self.state["currentBatch"] = current
        write_json(self.state_file, self.state)
        write_json(self.output / "progress.json", self.state)

    def export_batch(self, entry):
        prefix = "batch-" + str(entry["number"]).zfill(3) + "-"
        for manifest_file in sorted(self.parts.glob(prefix + "*.jsonl.manifest.json"), reverse=True):
            catalog = Path(str(manifest_file).removesuffix(".manifest.json"))
            metadata = json.loads(manifest_file.read_text(encoding="utf-8"))
            if catalog.exists() and metadata.get("planId") == entry["planId"] and digest(catalog) == metadata["sha256"]:
                return {"catalogFile": str(catalog), "manifestFile": str(manifest_file),
                        "repositoryCount": metadata["repositoryCount"], "sha256": metadata["sha256"]}
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        catalog = self.parts / (prefix + stamp + ".jsonl")
        log_file = self.parts / (prefix + stamp + ".export.log")
        environment = dict(os.environ)
        environment["HADOOP_CLIENT_OPTS"] = environment.get("HADOOP_CLIENT_OPTS", "") + " -Xmx1536m"
        with log_file.open("w", encoding="utf-8") as log:
            subprocess.run(
                ["/opt/happygit/bin/data-platform", "export-catalog", "--namespace", "public",
                 "--plan-id", entry["planId"], "--output", str(catalog)],
                env=environment, stdout=log, stderr=subprocess.STDOUT, check=True,
            )
        metadata = json.loads(Path(str(catalog) + ".manifest.json").read_text(encoding="utf-8"))
        if digest(catalog) != metadata["sha256"]:
            raise ValueError("Catalog digest does not match the exported manifest")
        return {"catalogFile": str(catalog), "manifestFile": str(catalog) + ".manifest.json",
                "repositoryCount": metadata["repositoryCount"], "sha256": metadata["sha256"]}

    def run(self):
        if self.state["phase"] in ("completed", "completed_with_gaps"):
            self.publish(self.state["phase"])
            return
        finished = {batch["planId"] for batch in self.state["batches"]}
        for entry in self.manifest["plans"]:
            if entry["planId"] in finished:
                continue
            current = {key: entry[key] for key in ("number", "name", "planId")}
            self.publish("submitting", current)
            self.api("plans", entry["configuration"])
            print(json.dumps({"at": now(), "event": "batch_started", **current}, ensure_ascii=False), flush=True)
            while True:
                progress = self.api("progress")
                plan = next(plan for plan in progress["plans"] if plan["planId"] == entry["planId"])
                counts = plan["taskCounts"]
                current.update({"taskCounts": counts, "typeCounts": plan["typeCounts"],
                                "requestsUsed": plan["requestsUsed"], "requestBudget": plan["requestBudget"],
                                "failureExamples": plan["failureExamples"], "workerIds":
                                [worker["workerId"] for worker in progress["workers"]]})
                if plan["authenticationFailures"]:
                    self.api("plans/" + entry["planId"] + "/pause", {})
                    self.publish("needs_github_token", current)
                    return
                pending = counts.get("queued", 0) + counts.get("running", 0)
                exhausted = plan["state"] == "budget_exhausted"
                if sum(counts.values()) and (pending == 0 or exhausted and counts.get("running", 0) == 0):
                    self.publish("exporting", current)
                    exported = self.export_batch(entry)
                    status = "budget_exhausted" if exhausted and pending else "completed_with_failures" \
                        if counts.get("failed", 0) or counts.get("cancelled", 0) else "completed"
                    result = {**current, **exported, "status": status, "finishedAt": now()}
                    self.state["batches"].append(result)
                    self.publish("between_batches", current)
                    print(json.dumps({"at": now(), "event": "batch_finished", "number": entry["number"],
                                      "status": status, "repositories": exported["repositoryCount"]}), flush=True)
                    break
                waiting = max((observation.get("retryAt", 0) for resources in progress["rateLimits"].values()
                               for observation in resources.values()), default=0)
                current["rateRetryAt"] = waiting
                phase = "paused" if plan["state"] == "paused" else "waiting_rate_limit" \
                    if waiting > time.time() * 1000 else "running"
                self.publish(phase, current)
                time.sleep(self.arguments.poll_seconds)
        self.state["finishedAt"] = now()
        phase = "completed" if all(batch["status"] == "completed" for batch in self.state["batches"]) \
            else "completed_with_gaps"
        write_json(self.output / "collection-manifest.json", {
            "sourceKind": "github_public", "runId": self.manifest["runId"],
            "collectionStatus": phase, "finishedAt": self.state["finishedAt"],
            "processedBatches": len(self.state["batches"]),
            "repositoryRowsBeforeCrossBatchDedup": sum(batch["repositoryCount"] for batch in self.state["batches"]),
            "batches": self.state["batches"],
        })
        self.publish(phase)
        print(json.dumps({"at": now(), "event": "run_finished", "phase": phase,
                          "processedBatches": len(self.state["batches"])}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8090")
    parser.add_argument("--poll-seconds", type=int, default=30)
    BatchRun(parser.parse_args()).run()


if __name__ == "__main__":
    main()
