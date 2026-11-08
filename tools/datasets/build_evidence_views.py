#!/usr/bin/env python3
"""Build shared evidence views (evidence-views/{train,validation,test}.jsonl)
with deterministic SHA-256 evidenceHash for MapReduce J01-J09 and LLM comparison.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

REFERENCE_TIME_DEFAULT = 1794096000000
WINDOW_DAYS_DEFAULT = 90
DAY_MS = 86_400_000


def compute_evidence_hash(evidence: Dict[str, Any]) -> str:
    """Compute canonical SHA-256 hex digest of an evidence dictionary."""
    canonical_bytes = json.dumps(
        evidence,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical_bytes).hexdigest()


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if stripped:
                rows.append(json.loads(stripped))
    return rows


def _make_readme_excerpt(readme_text: Any, max_chars: int = 2000) -> str:
    if not isinstance(readme_text, str):
        return ""
    text = readme_text.strip()
    if len(text) > max_chars:
        return text[:max_chars]
    return text


def build_evidence_views_for_dataset(
    dataset_dir: Path,
    reference_time: int = REFERENCE_TIME_DEFAULT,
    window_days: int = WINDOW_DAYS_DEFAULT,
) -> Dict[str, Any]:
    """Read canonical/*.jsonl and splits/subjects.jsonl under dataset_dir and write
    evidence-views/{train,validation,test}.jsonl.
    """
    canonical_dir = dataset_dir / "canonical"
    splits_path = dataset_dir / "splits" / "subjects.jsonl"
    evidence_dir = dataset_dir / "evidence-views"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    repositories_rows = _read_jsonl(canonical_dir / "repositories.jsonl")
    subjects_rows = _read_jsonl(canonical_dir / "subjects.jsonl")
    collections_rows = _read_jsonl(canonical_dir / "collections.jsonl")
    events_rows = _read_jsonl(canonical_dir / "events.jsonl")
    splits_rows = _read_jsonl(splits_path)

    repo_by_id: Dict[str, Dict[str, Any]] = {}
    for repo in repositories_rows:
        if repo.get("kind") == "repository" and repo.get("visibility") == "public":
            repo_id = str(repo["repoId"])
            repo_by_id[repo_id] = repo

    split_by_subject: Dict[str, str] = {}
    for row in splits_rows:
        split_by_subject[str(row["subjectId"])] = str(row["split"])

    subject_by_id: Dict[str, Dict[str, Any]] = {}
    for subj in subjects_rows:
        if subj.get("kind") == "subject":
            sid = str(subj["subjectId"])
            subject_by_id[sid] = subj
            if sid not in split_by_subject and "split" in subj:
                split_by_subject[sid] = str(subj["split"])

    collections_by_key: Dict[tuple[str, str], Dict[str, Any]] = {}
    for coll in collections_rows:
        if coll.get("kind") != "collection":
            continue
        key = (str(coll["subjectId"]), str(coll["collectionKind"]))
        prev = collections_by_key.get(key)
        if prev is None or int(coll.get("observedAt", 0)) >= int(prev.get("observedAt", 0)):
            collections_by_key[key] = coll

    window_start = reference_time - window_days * DAY_MS
    dedup_events: Dict[tuple[str, str], Dict[str, Any]] = {}
    for ev in events_rows:
        if ev.get("kind") != "event":
            continue
        if ev.get("recordKind", "open") == "discard":
            continue
        if ev.get("source", "browse") != "browse":
            continue
        at = int(ev.get("effectiveAt") or ev.get("occurredAt") or 0)
        if not (window_start < at <= reference_time):
            continue
        sid = str(ev["subjectId"])
        eid = str(ev["eventId"])
        repo_id = str(ev.get("repoId") or "")
        if not repo_id:
            continue
        key = (sid, eid)
        prev = dedup_events.get(key)
        if prev is None or at < int(prev["at"]):
            dedup_events[key] = {"subjectId": sid, "eventId": eid, "repoId": repo_id, "at": at}

    browse_by_subject_repo: Dict[str, Dict[str, List[int]]] = {}
    for item in dedup_events.values():
        sid = item["subjectId"]
        rid = item["repoId"]
        browse_by_subject_repo.setdefault(sid, {}).setdefault(rid, []).append(int(item["at"]))

    by_split: Dict[str, List[Dict[str, Any]]] = {"train": [], "validation": [], "test": []}
    all_subject_ids = sorted(subject_by_id.keys())

    for sid in all_subject_ids:
        subj = subject_by_id[sid]
        split_name = split_by_subject.get(sid, str(subj.get("split", "train")))
        if split_name not in by_split:
            continue

        subj_browse_map = browse_by_subject_repo.get(sid, {})
        browse_list: List[Dict[str, Any]] = []
        referenced_repo_ids: set[str] = set()

        for rid in sorted(subj_browse_map.keys()):
            if rid not in repo_by_id:
                continue
            timestamps = sorted(subj_browse_map[rid])
            if not timestamps:
                continue
            browse_list.append(
                {
                    "repoId": rid,
                    "count": len(timestamps),
                    "occurredAt": timestamps,
                }
            )
            referenced_repo_ids.add(rid)

        stars_coll = collections_by_key.get((sid, "stars"), {})
        stars_complete = bool(stars_coll.get("complete", False))
        stars_observed = int(stars_coll.get("observedAt", reference_time))
        raw_stars_ids = [
            str(r)
            for r in (stars_coll.get("repoIds") or [])
            if str(r) in repo_by_id
        ]
        stars_repo_ids = sorted(set(raw_stars_ids)) if stars_complete else []
        for rid in stars_repo_ids:
            referenced_repo_ids.add(rid)

        owned_coll = collections_by_key.get((sid, "owned"), {})
        owned_complete = bool(owned_coll.get("complete", False))
        owned_observed = int(owned_coll.get("observedAt", reference_time))
        raw_owned_ids = [
            str(r)
            for r in (owned_coll.get("repoIds") or [])
            if str(r) in repo_by_id
        ]
        owned_repo_ids = sorted(set(raw_owned_ids)) if owned_complete else []
        for rid in owned_repo_ids:
            referenced_repo_ids.add(rid)

        repositories_meta: List[Dict[str, Any]] = []
        for rid in sorted(referenced_repo_ids):
            repo = repo_by_id[rid]
            topics = sorted({str(t).strip().lower() for t in (repo.get("topics") or []) if str(t).strip()})
            repositories_meta.append(
                {
                    "repoId": rid,
                    "fullName": repo.get("fullName"),
                    "name": repo.get("name"),
                    "owner": repo.get("owner"),
                    "primaryLanguage": repo.get("primaryLanguage"),
                    "topics": topics,
                    "description": repo.get("description") or "",
                    "readmeExcerpt": _make_readme_excerpt(repo.get("readmeText")),
                    "starCount": int(repo.get("starCount") or 0),
                    "forkCount": int(repo.get("forkCount") or 0),
                    "updatedAt": int(repo.get("updatedAt") or 0),
                    "pushedAt": int(repo.get("pushedAt") or 0),
                    "isArchived": bool(repo.get("isArchived", False)),
                }
            )

        evidence_obj: Dict[str, Any] = {
            "subjectId": sid,
            "referenceTime": reference_time,
            "windowDays": window_days,
            "manualTags": list(subj.get("manualTags") or []),
            "hiddenRepoIds": list(subj.get("hiddenRepoIds") or []),
            "browse": browse_list,
            "stars": {
                "complete": stars_complete,
                "observedAt": stars_observed,
                "repoIds": stars_repo_ids,
            },
            "owned": {
                "complete": owned_complete,
                "observedAt": owned_observed,
                "repoIds": owned_repo_ids,
            },
            "repositories": repositories_meta,
        }
        evidence_hash = compute_evidence_hash(evidence_obj)
        by_split[split_name].append(
            {
                "kind": "evidence_view",
                "schemaVersion": "1.0.0",
                "subjectId": sid,
                "split": split_name,
                "referenceTime": reference_time,
                "evidenceHash": evidence_hash,
                "evidence": evidence_obj,
            }
        )

    summary: Dict[str, int] = {}
    for split_name, rows in by_split.items():
        rows.sort(key=lambda item: str(item["subjectId"]))
        out_path = evidence_dir / f"{split_name}.jsonl"
        with out_path.open("w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        summary[split_name] = len(rows)

    return {
        "countsBySplit": summary,
        "totalSubjects": sum(summary.values()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build shared evidence views for HappyGit dataset.")
    parser.add_argument("--dataset-dir", required=True, help="Target dataset root directory.")
    parser.add_argument("--reference-time", type=int, default=REFERENCE_TIME_DEFAULT)
    parser.add_argument("--window-days", type=int, default=WINDOW_DAYS_DEFAULT)
    args = parser.parse_args()

    result = build_evidence_views_for_dataset(
        Path(args.dataset_dir),
        reference_time=args.reference_time,
        window_days=args.window_days,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
