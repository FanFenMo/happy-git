"""Collect exact HappyGit YARN jobs and task-attempt overlap; never start or stop a service."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")


def entries(body, outer, inner):
    value = (body.get(outer) or {}).get(inner) or []
    return value if isinstance(value, list) else [value]


def overlap(attempts):
    successful = sorted((row for row in attempts if row.get("state") == "SUCCEEDED" and row.get("nodeHttpAddress")
                         and row.get("startTime", 0) > 0 and row.get("finishTime", 0) > row["startTime"]), key=lambda row: row["startTime"])
    for index, left in enumerate(successful):
        for right in successful[index + 1:]:
            if right["startTime"] >= left["finishTime"]:
                break
            left_host = urllib.parse.urlsplit("//" + left["nodeHttpAddress"]).hostname
            right_host = urllib.parse.urlsplit("//" + right["nodeHttpAddress"]).hostname
            milliseconds = min(left["finishTime"], right["finishTime"]) - max(left["startTime"], right["startTime"])
            if left_host != right_host and milliseconds > 0:
                return {"leftAttempt": left["id"], "rightAttempt": right["id"], "leftNode": left_host, "rightNode": right_host, "overlapMs": milliseconds}
    return None


def collect(args):
    run_path = Path(args.run).resolve()
    run = json.loads(run_path.read_text(encoding="utf-8-sig"))
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    issues = []

    def fetch(base, suffix, target):
        url = base.rstrip("/") + suffix
        if args.hadoop_user:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode({"user.name": args.hadoop_user})
        try:
            request = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=args.timeout) as response:
                body = json.load(response)
            write_json(root / target, body)
            return body
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            issue = {"resource": suffix, "file": target, "error": str(error)}
            issues.append(issue)
            write_json(root / target, {"state": "unavailable", **issue})
            return {}

    observed = dt.datetime.now(dt.timezone.utc).isoformat()
    nodes = fetch(args.resource_manager, "/ws/v1/cluster/nodes", "raw/yarn-nodes.json")
    info = fetch(args.name_node, "/jmx?qry=Hadoop:service=NameNode,name=NameNodeInfo", "raw/namenode.json")
    bean = (info.get("beans") or [{}])[0]
    inventory = json.loads(Path(args.inventory).read_text(encoding="utf-8-sig")) if args.inventory else None
    report = {"schemaVersion": "1.0.0", "observedAt": observed, "runSha256": hashlib.sha256(run_path.read_bytes()).hexdigest(),
              "sourceRunState": run.get("state"), "datasetVersion": run.get("datasetVersion"), "modelVersion": run.get("modelVersion"),
              "protocolDigest": run.get("protocolDigest"), "framework": run.get("framework"), "haAcceptance": "not_run",
              "inventory": inventory, "clusterNow": {"nodes": entries(nodes, "nodes", "node"), "liveDataNodes": json.loads(bean.get("LiveNodes") or "{}"),
                                                       "deadDataNodes": json.loads(bean.get("DeadNodes") or "{}"), "missingBlocks": bean.get("NumberOfMissingBlocks"), "hadoopVersion": bean.get("SoftwareVersion")},
              "jobs": [], "issues": issues}
    jobs = {row["jobId"]: row for row in run.get("jobs", []) if row.get("jobId")}
    local_jobs = []
    for job_id, receipt in sorted(jobs.items()):
        application = receipt.get("applicationId")
        if receipt.get("framework") != "yarn" or not application:
            local_jobs.append(job_id)
            continue
        job_root = "jobs/" + job_id
        app = fetch(args.resource_manager, "/ws/v1/cluster/apps/" + application, job_root + "/application.json").get("app") or {}
        history = fetch(args.history_server, "/ws/v1/history/mapreduce/jobs/" + job_id, job_root + "/job.json").get("job") or {}
        counters = fetch(args.history_server, "/ws/v1/history/mapreduce/jobs/" + job_id + "/counters", job_root + "/counters.json")
        tasks = fetch(args.history_server, "/ws/v1/history/mapreduce/jobs/" + job_id + "/tasks", job_root + "/tasks.json")
        attempts = []
        for task in entries(tasks, "tasks", "task"):
            task_id = task["id"]
            response = fetch(args.history_server, "/ws/v1/history/mapreduce/jobs/" + job_id + "/tasks/" + task_id + "/attempts", job_root + "/" + task_id + "-attempts.json")
            for attempt in entries(response, "taskAttempts", "taskAttempt"):
                attempts.append({**attempt, "taskId": task_id})
        proof = overlap(attempts)
        report["jobs"].append({"jobId": job_id, "applicationId": application, "stage": receipt.get("stage"), "receiptState": receipt.get("state"),
                               "historyState": history.get("state"), "applicationState": app.get("state"), "finalStatus": app.get("finalStatus"),
                               "startTime": history.get("startTime"), "finishTime": history.get("finishTime"),
                               "elapsedTime": history.get("elapsedTime", max(0, (history.get("finishTime") or 0) - (history.get("startTime") or 0))),
                               "memorySeconds": app.get("memorySeconds"), "vcoreSeconds": app.get("vcoreSeconds"),
                               "attempts": attempts, "crossNodeOverlap": proof, "countersAvailable": bool(counters.get("jobCounters"))})
    report["localJobs"] = local_jobs
    report["parallelExecution"] = "proven" if any(job["crossNodeOverlap"] for job in report["jobs"]) else "not_observed"
    report["state"] = "complete" if jobs and not local_jobs and not issues and len(report["jobs"]) == len(jobs) else "incomplete"
    report["allJobsSucceeded"] = bool(report["jobs"]) and all(job["historyState"] == "SUCCEEDED" and job["finalStatus"] == "SUCCEEDED" for job in report["jobs"])
    report["resourceTotals"] = {"memorySeconds": sum(job["memorySeconds"] or 0 for job in report["jobs"]), "vcoreSeconds": sum(job["vcoreSeconds"] or 0 for job in report["jobs"])}
    write_json(root / "run-evidence.json", report)
    print(json.dumps({"state": report["state"], "jobs": len(report["jobs"]), "parallelExecution": report["parallelExecution"], "allJobsSucceeded": report["allJobsSucceeded"], "report": str(root / "run-evidence.json")}, ensure_ascii=False))
    return 0 if report["state"] == "complete" and report["allJobsSucceeded"] and (not args.require_parallel or report["parallelExecution"] == "proven") else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("run", "output", "resource-manager", "history-server", "name-node"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--inventory")
    parser.add_argument("--hadoop-user")
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--require-parallel", action="store_true")
    return collect(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
