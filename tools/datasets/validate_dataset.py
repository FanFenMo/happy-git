#!/usr/bin/env python3
"""Validate a generated HappyGit server portrait dataset package and emit
validation-report.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, List

from build_evidence_views import compute_evidence_hash

ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
ALLOWED_RUNTIME_KINDS = {"repository", "subject", "collection", "event"}
MAX_SHARD_BYTES = 16 * 1024 * 1024
DAY_MS = 86_400_000


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            s = line.strip()
            if not s:
                continue
            try:
                rows.append(json.loads(s))
            except Exception as exc:
                raise ValueError(f"Invalid JSON at {path}:{line_no}: {exc}") from exc
    return rows


def validate_dataset(dataset_dir: Path, strict_real: bool = False) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []
    checks: Dict[str, bool] = {}

    manifest_path = dataset_dir / "dataset-manifest.json"
    if not manifest_path.exists():
        report = {
            "valid": False,
            "errors": ["Missing dataset-manifest.json"],
            "warnings": [],
            "checks": {},
        }
        return report

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    scale = manifest.get("scale", "pilot")
    catalog_mode = manifest.get("catalogMode", "real")
    status = manifest.get("status", "")
    reference_time = int(manifest.get("referenceTime", 1794096000000))
    window_days = int(manifest.get("windowDays", 90))
    window_start = reference_time - window_days * DAY_MS

    gap_report_path = dataset_dir / "real-catalog-gap-report.json"
    gap_report = (
        json.loads(gap_report_path.read_text(encoding="utf-8"))
        if gap_report_path.exists()
        else None
    )

    if status == "blocked_missing_real_catalog":
        errors.append(
            f"Real catalog insufficient for scale={scale}: "
            f"available={manifest.get('counts', {}).get('availableRealRepositories')}, "
            f"required={manifest.get('counts', {}).get('requiredRealRepositories')}."
        )
        report = {
            "schemaVersion": "1.0.0",
            "valid": False,
            "blockerCode": "REAL_CATALOG_INSUFFICIENT",
            "scale": scale,
            "catalogMode": catalog_mode,
            "status": status,
            "realCatalogGapSummary": gap_report,
            "errors": errors,
            "warnings": warnings,
            "checks": {"realCatalogReady": False},
        }
        (dataset_dir / "validation-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return report

    if strict_real and catalog_mode != "real":
        errors.append(f"Strict real check enabled, but dataset catalogMode is '{catalog_mode}'.")

    # 1. File digest check
    digest_ok = True
    for f_entry in manifest.get("files", []):
        rel = f_entry["path"]
        f_path = dataset_dir / rel
        if not f_path.exists():
            errors.append(f"Missing declared file: {rel}")
            digest_ok = False
            continue
        actual_sha = _sha256_file(f_path)
        if actual_sha != f_entry["sha256"]:
            errors.append(f"SHA-256 mismatch for {rel}: expected {f_entry['sha256']}, got {actual_sha}")
            digest_ok = False
    checks["fileDigestsMatch"] = digest_ok

    # 2. Load canonical files
    repos = _read_jsonl(dataset_dir / "canonical" / "repositories.jsonl")
    subjects = _read_jsonl(dataset_dir / "canonical" / "subjects.jsonl")
    collections = _read_jsonl(dataset_dir / "canonical" / "collections.jsonl")
    events = _read_jsonl(dataset_dir / "canonical" / "events.jsonl")
    splits = _read_jsonl(dataset_dir / "splits" / "subjects.jsonl")

    expected_repos = 240 if scale == "pilot" else 10000
    expected_subjects = 50 if scale == "pilot" else 1000
    expected_events = 5000 if scale == "pilot" else 200000
    expected_splits = (
        {"train": 40, "validation": 5, "test": 5}
        if scale == "pilot"
        else {"train": 800, "validation": 100, "test": 100}
    )

    counts_ok = True
    if len(repos) != expected_repos:
        errors.append(f"Expected {expected_repos} repositories, got {len(repos)}")
        counts_ok = False
    if len(subjects) != expected_subjects:
        errors.append(f"Expected {expected_subjects} subjects, got {len(subjects)}")
        counts_ok = False
    if len(events) != expected_events:
        errors.append(f"Expected {expected_events} events, got {len(events)}")
        counts_ok = False
    checks["scaleQuotasMatch"] = counts_ok

    # 3. Repository validity & reference integrity
    repo_ids: set[str] = set()
    repos_ok = True
    for r in repos:
        rid = str(r.get("repoId") or "")
        if not ID_PATTERN.match(rid):
            errors.append(f"Invalid repoId: {rid}")
            repos_ok = False
        if r.get("visibility") != "public":
            errors.append(f"Non-public repository in canonical set: {rid}")
            repos_ok = False
        if int(r.get("observedAt") or 0) > reference_time:
            errors.append(f"Repository observedAt > referenceTime: {rid}")
            repos_ok = False
        if catalog_mode == "real" and r.get("sourceKind") != "github_public":
            errors.append(f"Repository {rid} has sourceKind={r.get('sourceKind')} in real mode")
            repos_ok = False
        repo_ids.add(rid)
    checks["repositoriesValid"] = repos_ok

    # 4. Split isolation
    split_sets: Dict[str, set[str]] = {"train": set(), "validation": set(), "test": set()}
    for s_row in splits:
        sp = s_row.get("split")
        sid = str(s_row.get("subjectId") or "")
        if sp not in split_sets:
            errors.append(f"Invalid split name: {sp}")
        else:
            split_sets[sp].add(sid)

    splits_ok = True
    if (
        (split_sets["train"] & split_sets["validation"])
        or (split_sets["train"] & split_sets["test"])
        or (split_sets["validation"] & split_sets["test"])
    ):
        errors.append("Split subjectId sets are not pairwise disjoint")
        splits_ok = False
    for sp_name, exp_cnt in expected_splits.items():
        if len(split_sets[sp_name]) != exp_cnt:
            errors.append(f"Split {sp_name} expected {exp_cnt} subjects, got {len(split_sets[sp_name])}")
            splits_ok = False
    checks["splitIsolationAndCounts"] = splits_ok

    subject_ids = {str(s["subjectId"]) for s in subjects}

    # 5. Collections check
    coll_ok = True
    seen_coll_keys: set[tuple[str, str]] = set()
    for c in collections:
        sid = str(c.get("subjectId") or "")
        ck = str(c.get("collectionKind") or "")
        if sid not in subject_ids:
            errors.append(f"Collection references unknown subjectId {sid}")
            coll_ok = False
        key = (sid, ck)
        if key in seen_coll_keys:
            errors.append(f"Duplicate collection snapshot for {key}")
            coll_ok = False
        seen_coll_keys.add(key)
        rids = [str(x) for x in (c.get("repoIds") or [])]
        if rids != sorted(set(rids)):
            errors.append(f"Collection {key} repoIds not sorted/unique")
            coll_ok = False
        for rid in rids:
            if rid not in repo_ids:
                errors.append(f"Collection {key} references unknown repoId {rid}")
                coll_ok = False
        if ck == "owned" and c.get("sourceKind") == "unknown" and c.get("complete") is not False:
            errors.append(f"Synthetic owned collection for {sid} must have complete=false")
            coll_ok = False
    checks["collectionsValid"] = coll_ok

    # 6. Events time window & 31s spacing check
    events_ok = True
    by_subj_repo: Dict[tuple[str, str], List[int]] = {}
    seen_event_ids: set[tuple[str, str]] = set()
    for ev in events:
        sid = str(ev.get("subjectId") or "")
        eid = str(ev.get("eventId") or "")
        rid = str(ev.get("repoId") or "")
        if sid not in subject_ids:
            errors.append(f"Event {eid} references unknown subjectId {sid}")
            events_ok = False
        if rid not in repo_ids:
            errors.append(f"Event {eid} references unknown repoId {rid}")
            events_ok = False
        if (sid, eid) in seen_event_ids:
            errors.append(f"Duplicate eventId {(sid, eid)}")
            events_ok = False
        seen_event_ids.add((sid, eid))
        at = int(ev.get("effectiveAt") or ev.get("occurredAt") or 0)
        if not (window_start < at <= reference_time):
            errors.append(f"Event {eid} timestamp {at} outside 90-day window")
            events_ok = False
        if ev.get("recordKind", "open") == "open" and ev.get("source") == "browse":
            by_subj_repo.setdefault((sid, rid), []).append(at)

    for (sid, rid), ts_list in by_subj_repo.items():
        ordered = sorted(ts_list)
        for i in range(len(ordered) - 1):
            if ordered[i + 1] - ordered[i] < 31_000:
                errors.append(
                    f"Browse events for ({sid}, {rid}) violate 31s spacing: "
                    f"{ordered[i]} -> {ordered[i + 1]}"
                )
                events_ok = False
                break
    checks["eventsWindowAndSpacingValid"] = events_ok

    # 7. Runtime isolation & shard check
    runtime_ok = True
    for sp_name in ("train", "validation", "test"):
        sp_dir = dataset_dir / "runtime" / sp_name
        shards = sorted(sp_dir.glob("part-*.jsonl"))
        if not shards:
            errors.append(f"No runtime shards found in runtime/{sp_name}")
            runtime_ok = False
        for sh in shards:
            if sh.stat().st_size > MAX_SHARD_BYTES:
                errors.append(f"Runtime shard {sh} exceeds 16 MiB")
                runtime_ok = False
            rows = _read_jsonl(sh)
            for row in rows:
                k = row.get("kind")
                if k not in ALLOWED_RUNTIME_KINDS:
                    errors.append(f"Forbidden record kind '{k}' in runtime shard {sh.name}")
                    runtime_ok = False
                if k in ("subject", "collection", "event"):
                    sid = str(row.get("subjectId") or "")
                    if sid not in split_sets[sp_name]:
                        errors.append(f"Cross-split leakage of {sid} in runtime/{sp_name}/{sh.name}")
                        runtime_ok = False
    checks["runtimeIsolationAndShardsValid"] = runtime_ok

    # 8. Evidence views & evidenceHash verification
    ev_ok = True
    for sp_name in ("train", "validation", "test"):
        ev_file = dataset_dir / "evidence-views" / f"{sp_name}.jsonl"
        ev_rows = _read_jsonl(ev_file)
        if len(ev_rows) != len(split_sets[sp_name]):
            errors.append(
                f"evidence-views/{sp_name}.jsonl count {len(ev_rows)} != expected {len(split_sets[sp_name])}"
            )
            ev_ok = False
        for row in ev_rows:
            ev_obj = row.get("evidence")
            if not isinstance(ev_obj, dict):
                errors.append(f"Missing evidence object for {row.get('subjectId')}")
                ev_ok = False
                continue
            recomputed = compute_evidence_hash(ev_obj)
            if recomputed != row.get("evidenceHash"):
                errors.append(
                    f"evidenceHash mismatch for {row.get('subjectId')}: "
                    f"stored={row.get('evidenceHash')}, recomputed={recomputed}"
                )
                ev_ok = False
            browse_items = ev_obj.get("browse") or []
            browse_rids = [str(b["repoId"]) for b in browse_items]
            if browse_rids != sorted(browse_rids):
                errors.append(f"browse list not sorted by repoId for {row.get('subjectId')}")
                ev_ok = False
            for b in browse_items:
                ts_arr = b.get("occurredAt") or []
                if b.get("count") != len(ts_arr):
                    errors.append(f"browse count != len(occurredAt) for {row.get('subjectId')}")
                    ev_ok = False
                if ts_arr != sorted(ts_arr):
                    errors.append(f"browse occurredAt not sorted for {row.get('subjectId')}")
                    ev_ok = False
    checks["evidenceViewsAndHashesValid"] = ev_ok

    valid = len(errors) == 0
    report = {
        "schemaVersion": "1.0.0",
        "valid": valid,
        "scale": scale,
        "catalogMode": catalog_mode,
        "datasetVersion": manifest.get("datasetVersion"),
        "status": status,
        "counts": manifest.get("counts"),
        "checks": checks,
        "errors": errors,
        "warnings": warnings,
    }
    (dataset_dir / "validation-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a HappyGit dataset package.")
    parser.add_argument("--dataset-dir", required=True)
    parser.add_argument("--strict-real", action="store_true")
    args = parser.parse_args()

    report = validate_dataset(Path(args.dataset_dir), strict_real=args.strict_real)
    print(json.dumps({"valid": report["valid"], "checks": report["checks"], "errorCount": len(report["errors"])}, ensure_ascii=False))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
