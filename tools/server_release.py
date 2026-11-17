"""Package, verify and operate an explicit HappyGit server release without formatting data."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import uuid

from ubuntu_cluster import render, write_text


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def verify(root):
    root = root.resolve()
    manifest = json.loads((root / "release-manifest.json").read_text(encoding="utf-8"))
    for item in manifest["files"]:
        path = (root / item["path"]).resolve()
        if root not in path.parents or path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError("Release file does not match its manifest: " + item["path"])
    return manifest


def package(args):
    source = Path(__file__).resolve().parents[1]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}", args.release_id):
        raise ValueError("Use a release ID consisting of letters, digits, dot, underscore or dash")
    status = subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True)
    if status.strip():
        raise ValueError("Commit the source before packaging a versioned release")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    inventory_file = Path(args.inventory).resolve()
    inventory = json.loads(inventory_file.read_text(encoding="utf-8-sig"))
    root = Path(args.output).resolve() / args.release_id
    root.mkdir(parents=True, exist_ok=False)
    (root / "artifacts").mkdir()
    shutil.copyfile(args.platform_jar, root / "artifacts/happygit-data-platform.jar")
    if args.server_jar:
        shutil.copyfile(args.server_jar, root / "artifacts/happygit-server.jar")
    if inventory.get("api") and not args.server_jar:
        raise ValueError("An API role requires --server-jar")
    render(inventory, root / "nodes")
    include = ["data-platform/bin/data-platform", "data-platform/bin/data-platform-zookeeper",
               "deploy/ubuntu/install-release.sh", "deploy/ubuntu/activate-release.sh",
               "tools/server_release.py", "tools/ubuntu_cluster.py", "tools/collect_model_run.py",
               "docs/implementation/集群模型交付与验收.md", "deploy/ubuntu/model-export.example.json"]
    for relative in include:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
    files = [{"path": str(path.relative_to(root)).replace("\\", "/"), "bytes": path.stat().st_size, "sha256": digest(path)}
             for path in sorted(root.rglob("*")) if path.is_file()]
    manifest = {"schemaVersion": "1.0.0", "releaseId": args.release_id, "sourceCommit": commit,
                "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(), "inventorySha256": digest(inventory_file),
                "validation": "feature_compile_only_pending_develop_acceptance", "files": files}
    write_text(root / "release-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    archive = root.with_suffix(root.suffix + ".tar.gz")
    with tarfile.open(archive, "w:gz") as bundle:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            info = bundle.gettarinfo(str(path), str(Path(args.release_id) / path.relative_to(root)).replace("\\", "/"))
            info.mode = 0o755 if path.suffix == ".sh" or path.parent.name == "bin" else 0o644
            with path.open("rb") as stream:
                bundle.addfile(info, stream)
    write_text(archive.with_name(archive.name + ".sha256"), digest(archive) + "  " + archive.name + "\n")
    return {"releaseId": args.release_id, "sourceCommit": commit, "directory": str(root), "archive": str(archive), "sha256": digest(archive)}


def service(args):
    config = json.loads((Path(args.node_config) / "roles.json").read_text(encoding="utf-8"))
    allowed = set(config["units"] + config["timers"])
    if not args.unit or any(unit not in allowed for unit in args.unit):
        raise ValueError("Select exact units belonging to this node configuration")
    command = ["systemctl", "show", *args.unit, "--property=Id,ActiveState,SubState,MainPID,ExecMainStartTimestamp", "--no-pager"] if args.action == "status" else ["systemctl", args.action, *args.unit]
    result = subprocess.run(command, text=True, capture_output=True)
    record = {"action": args.action, "node": config["node"]["name"], "units": args.unit,
              "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "exitCode": result.returncode,
              "stdout": result.stdout, "stderr": result.stderr}
    if args.action != "status":
        directory = Path(config["dataRoot"]) / "operations"
        directory.mkdir(parents=True, exist_ok=True)
        write_text(directory / ("service-" + uuid.uuid4().hex + ".json"), json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("package")
    for name in ("inventory", "platform-jar", "output", "release-id"):
        build.add_argument("--" + name, required=True)
    build.add_argument("--server-jar")
    check = sub.add_parser("verify")
    check.add_argument("--release", required=True)
    operate = sub.add_parser("service")
    operate.add_argument("--node-config", required=True)
    operate.add_argument("--action", choices=("status", "start", "stop", "restart"), required=True)
    operate.add_argument("--unit", action="append", required=True)
    args = parser.parse_args()
    if args.command == "package":
        result = package(args)
    elif args.command == "verify":
        result = {"state": "verified", "releaseId": verify(Path(args.release))["releaseId"]}
    else:
        result = service(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result.get("exitCode", 0)


if __name__ == "__main__":
    raise SystemExit(main())
