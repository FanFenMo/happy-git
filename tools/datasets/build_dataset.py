#!/usr/bin/env python3
"""Deterministic dataset builder for HappyGit server-side interest portrait &
MapReduce J01-J12 / LLM comparison experiments.

Supports:
  --scale pilot|standard
  --catalog-mode real|synthetic_fixture
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from build_evidence_views import build_evidence_views_for_dataset, compute_evidence_hash

SEED_DEFAULT = 20261103
REFERENCE_TIME_DEFAULT = 1794096000000
WINDOW_DAYS_DEFAULT = 90
DAY_MS = 86_400_000
MIN_SAME_REPO_INTERVAL_MS = 31_000
MAX_RUNTIME_SHARD_BYTES = 15 * 1024 * 1024  # <= 16 MiB limit

PILOT_SCENARIO_PLAN: List[Tuple[str, int, int, int]] = [
    # (scenario, train_count, val_count, test_count) -> total 40 / 5 / 5 = 50
    ("stable_single", 7, 1, 1),
    ("stable_multi", 7, 1, 1),
    ("recent_shift", 5, 1, 0),
    ("temporary_task", 4, 0, 1),
    ("exploration_noise", 4, 1, 0),
    ("sparse", 3, 0, 0),
    ("no_evidence", 1, 0, 1),
    ("language_topic_conflict", 3, 0, 0),
    ("revisit_heavy", 2, 1, 0),
    ("ambiguous", 2, 0, 0),
    ("star_only", 2, 0, 1),
]

STANDARD_SCENARIO_PLAN: List[Tuple[str, int, int, int]] = [
    # (scenario, train_count, val_count, test_count) -> total 800 / 100 / 100 = 1000
    ("stable_single", 144, 18, 18),
    ("stable_multi", 144, 18, 18),
    ("recent_shift", 96, 12, 12),
    ("temporary_task", 80, 10, 10),
    ("exploration_noise", 80, 10, 10),
    ("sparse", 56, 7, 7),
    ("no_evidence", 24, 3, 3),
    ("language_topic_conflict", 48, 6, 6),
    ("revisit_heavy", 48, 6, 6),
    ("ambiguous", 32, 4, 4),
    ("star_only", 48, 6, 6),
]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            s = line.strip()
            if s:
                rows.append(json.loads(s))
    return rows


def _write_jsonl(path: Path, rows: List[Dict[str, Any]]) -> Tuple[int, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    return len(rows), _sha256_file(path)


def _write_sharded_runtime_jsonl(split_dir: Path, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    split_dir.mkdir(parents=True, exist_ok=True)
    for existing in split_dir.glob("part-*.jsonl"):
        existing.unlink()

    shard_index = 0
    current_lines: List[bytes] = []
    current_bytes = 0
    shards_meta: List[Dict[str, Any]] = []

    def flush_shard(idx: int, lines: List[bytes]) -> None:
        if not lines:
            return
        shard_path = split_dir / f"part-{idx:05d}.jsonl"
        payload = b"".join(lines)
        shard_path.write_bytes(payload)
        shards_meta.append(
            {
                "path": shard_path.as_posix(),
                "relativePath": f"runtime/{split_dir.name}/{shard_path.name}",
                "recordCount": len(lines),
                "byteSize": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )

    for row in rows:
        encoded = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if current_lines and (current_bytes + len(encoded) > MAX_RUNTIME_SHARD_BYTES):
            flush_shard(shard_index, current_lines)
            shard_index += 1
            current_lines = []
            current_bytes = 0
        current_lines.append(encoded)
        current_bytes += len(encoded)

    flush_shard(shard_index, current_lines)
    return shards_meta


def _inspect_real_catalog(
    real_repos: List[Dict[str, Any]],
    real_collections: List[Dict[str, Any]],
    taxonomy: Dict[str, Any],
    target_repo_count: int,
    reference_time: int,
) -> Dict[str, Any]:
    valid_repos: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    domain_topics_map: Dict[str, set[str]] = {
        d["domainId"]: set(d["topics"]) for d in taxonomy.get("domains", [])
    }
    domain_counts: Dict[str, int] = {d["domainId"]: 0 for d in taxonomy.get("domains", [])}
    language_counts: Dict[str, int] = {lang: 0 for lang in taxonomy.get("languages", [])}
    tier_counts: Dict[str, int] = {"high": 0, "medium": 0, "long_tail": 0}

    for repo in real_repos:
        if repo.get("kind") != "repository" or repo.get("visibility") != "public":
            continue
        if repo.get("sourceKind") != "github_public":
            continue
        if int(repo.get("observedAt") or 0) > reference_time:
            continue
        rid = str(repo.get("repoId") or "")
        if not rid or rid in seen_ids:
            continue
        if not str(repo.get("readmeText") or "").strip():
            continue
        seen_ids.add(rid)
        valid_repos.append(repo)

        lang = str(repo.get("primaryLanguage") or "")
        if lang in language_counts:
            language_counts[lang] += 1

        topics = {str(t).lower() for t in (repo.get("topics") or [])}
        for domain_id, d_topics in domain_topics_map.items():
            if topics & d_topics:
                domain_counts[domain_id] += 1

        stars = int(repo.get("starCount") or 0)
        if stars >= 10000:
            tier_counts["high"] += 1
        elif stars >= 500:
            tier_counts["medium"] += 1
        elif stars >= 50:
            tier_counts["long_tail"] += 1

    per_domain_target = max(1, target_repo_count // max(1, len(domain_counts)))
    domain_gaps = {
        domain_id: {
            "available": count,
            "recommendedMinimum": per_domain_target,
            "shortfall": max(0, per_domain_target - count),
        }
        for domain_id, count in domain_counts.items()
    }

    missing_count = max(0, target_repo_count - len(valid_repos))
    return {
        "ready": len(valid_repos) >= target_repo_count,
        "availableRealRepositoryCount": len(valid_repos),
        "requiredRealRepositoryCount": target_repo_count,
        "missingRealRepositoryCount": missing_count,
        "realUserCollectionCount": len(real_collections),
        "realUserCollectionsAvailable": len(real_collections) > 0,
        "domainCoverage": domain_gaps,
        "languageCounts": language_counts,
        "popularityTierCounts": tier_counts,
        "validRealRepositories": valid_repos,
    }


def _generate_fixture_repositories(
    existing_real: List[Dict[str, Any]],
    taxonomy: Dict[str, Any],
    target_count: int,
    reference_time: int,
    rng: random.Random,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Combine existing real repositories with deterministic synthetic_fixture
    repositories so that format/split/hash validation can run end-to-end without
    fabricating github_public provenance.
    """
    repos: List[Dict[str, Any]] = []
    annotations: List[Dict[str, Any]] = []
    domains = taxonomy["domains"]
    languages = taxonomy["languages"]

    for idx, real_repo in enumerate(existing_real):
        repo_copy = dict(real_repo)
        repos.append(repo_copy)
        topics = [str(t).lower() for t in (repo_copy.get("topics") or [])]
        matched_domain = domains[idx % len(domains)]["domainId"]
        for d in domains:
            if set(topics) & set(d["topics"]):
                matched_domain = d["domainId"]
                break
        annotations.append(
            {
                "kind": "catalog_annotation",
                "schemaVersion": "1.0.0",
                "repoId": str(repo_copy["repoId"]),
                "fullName": repo_copy["fullName"],
                "domainId": matched_domain,
                "primaryLanguage": repo_copy.get("primaryLanguage"),
                "canonicalTopics": sorted(set(topics)),
                "popularityTier": "high" if int(repo_copy.get("starCount", 0)) >= 10000 else "medium",
                "sourceKind": repo_copy.get("sourceKind", "github_public"),
            }
        )

    needed = max(0, target_count - len(repos))
    tiers = [
        ("high", 12000, 68000),
        ("medium", 600, 8500),
        ("long_tail", 55, 480),
    ]

    for i in range(needed):
        seq = i + 1
        domain = domains[i % len(domains)]
        domain_id = domain["domainId"]
        domain_topics = domain["topics"]
        lang = domain["primaryLanguages"][i % len(domain["primaryLanguages"])]
        if lang not in languages:
            lang = languages[i % len(languages)]

        tier_name, min_stars, max_stars = tiers[i % len(tiers)]
        stars = rng.randint(min_stars, max_stars)
        forks = max(5, int(stars * rng.uniform(0.08, 0.25)))

        t1 = domain_topics[i % len(domain_topics)]
        t2 = domain_topics[(i + 1) % len(domain_topics)]
        t3 = domain_topics[(i + 2) % len(domain_topics)]
        chosen_topics = sorted({t1, t2, t3})

        repo_id = str(90000000 + seq)
        owner = f"hg-{domain_id.replace('_', '-')}-org{(seq % 40) + 1:02d}"
        name = f"{t1}-{t2}-kit-{seq:04d}"
        full_name = f"{owner}/{name}"
        updated_at = reference_time - ((seq * 3600_000) % (60 * DAY_MS))

        description = (
            f"[{domain['label']}] Open-source {lang} library and toolkit for "
            f"{', '.join(chosen_topics)} workflows."
        )
        readme_text = (
            f"# {full_name}\n\n"
            f"Synthetic fixture repository for deterministic pipeline verification.\n"
            f"Domain: {domain_id} ({domain['label']}).\n"
            f"Primary Language: {lang}.\n"
            f"Topics: {', '.join(chosen_topics)}.\n\n"
            f"## Overview\n"
            f"{description}\n"
            f"Provides modular components for {t1}, {t2}, and {t3} in {lang} environments.\n"
        )

        repo_record = {
            "kind": "repository",
            "schemaVersion": "1.0.0",
            "repoId": repo_id,
            "owner": owner,
            "name": name,
            "fullName": full_name,
            "canonicalKey": full_name.lower(),
            "htmlUrl": f"https://github.com/{full_name}",
            "description": description,
            "primaryLanguage": lang,
            "topics": chosen_topics,
            "licenseSpdx": "Apache-2.0" if seq % 2 == 0 else "MIT",
            "starCount": stars,
            "forkCount": forks,
            "isArchived": False,
            "isFork": False,
            "visibility": "public",
            "updatedAt": updated_at,
            "pushedAt": updated_at,
            "readmeText": readme_text,
            "observedAt": reference_time - 60_000,
            "sourceKind": "synthetic_fixture",
        }
        repos.append(repo_record)
        annotations.append(
            {
                "kind": "catalog_annotation",
                "schemaVersion": "1.0.0",
                "repoId": repo_id,
                "fullName": full_name,
                "domainId": domain_id,
                "primaryLanguage": lang,
                "canonicalTopics": chosen_topics,
                "popularityTier": tier_name,
                "sourceKind": "synthetic_fixture",
            }
        )

    repos.sort(key=lambda r: str(r["repoId"]))
    annotations.sort(key=lambda a: str(a["repoId"]))
    return repos, annotations


def _allocate_event_quotas(
    subjects_plan: List[Dict[str, Any]],
    target_total_events: int,
) -> Dict[str, int]:
    """Allocate exact per-subject effective browse event counts summing to target_total_events."""
    quotas: Dict[str, int] = {}
    fixed_sum = 0
    flexible_subjects: List[Dict[str, Any]] = []

    base_weights = {
        "stable_single": 115,
        "stable_multi": 125,
        "recent_shift": 130,
        "temporary_task": 120,
        "exploration_noise": 110,
        "language_topic_conflict": 100,
        "revisit_heavy": 90,
        "ambiguous": 95,
    }

    for idx, subj in enumerate(subjects_plan):
        sid = subj["subjectId"]
        scenario = subj["scenario"]
        if scenario in ("no_evidence", "star_only"):
            quotas[sid] = 0
        elif scenario == "sparse":
            c = (idx % 3) + 1  # 1..3 events
            quotas[sid] = c
            fixed_sum += c
        else:
            flexible_subjects.append(subj)

    remaining = target_total_events - fixed_sum
    if remaining < len(flexible_subjects):
        raise ValueError("target_total_events is too small for subject plan")

    weight_total = sum(base_weights[s["scenario"]] for s in flexible_subjects)
    provisional: List[Tuple[str, int, float]] = []
    allocated = 0
    for s in flexible_subjects:
        sid = s["subjectId"]
        w = base_weights[s["scenario"]]
        exact = (remaining * w) / weight_total
        floor_val = max(6, int(exact))
        provisional.append((sid, floor_val, exact - floor_val))
        allocated += floor_val

    diff = remaining - allocated
    # Sort deterministically by fractional remainder descending, then subjectId ascending
    provisional.sort(key=lambda item: (-item[2], item[0]))
    for i in range(abs(diff)):
        sid, val, frac = provisional[i % len(provisional)]
        provisional[i % len(provisional)] = (sid, val + (1 if diff > 0 else -1), frac)

    for sid, val, _ in provisional:
        quotas[sid] = val

    assert sum(quotas.values()) == target_total_events, (
        f"Expected {target_total_events} browse events, got {sum(quotas.values())}"
    )
    return quotas


def _generate_subjects_and_behavior(
    repos: List[Dict[str, Any]],
    annotations: List[Dict[str, Any]],
    taxonomy: Dict[str, Any],
    scale: str,
    reference_time: int,
    seed: int,
) -> Dict[str, Any]:
    rng = random.Random(seed + (101 if scale == "pilot" else 202))
    plan_table = PILOT_SCENARIO_PLAN if scale == "pilot" else STANDARD_SCENARIO_PLAN
    target_events = 5000 if scale == "pilot" else 200000
    window_start = reference_time - WINDOW_DAYS_DEFAULT * DAY_MS

    domains = [d["domainId"] for d in taxonomy["domains"]]
    repos_by_domain: Dict[str, List[Dict[str, Any]]] = {d: [] for d in domains}
    ann_by_repo: Dict[str, Dict[str, Any]] = {a["repoId"]: a for a in annotations}
    repo_by_id: Dict[str, Dict[str, Any]] = {str(r["repoId"]): r for r in repos}

    for r in repos:
        rid = str(r["repoId"])
        dom = ann_by_repo.get(rid, {}).get("domainId", domains[0])
        repos_by_domain.setdefault(dom, []).append(r)

    for dom in repos_by_domain:
        repos_by_domain[dom].sort(key=lambda r: str(r["repoId"]))

    subjects_plan: List[Dict[str, Any]] = []
    seq = 1
    for scenario, n_train, n_val, n_test in plan_table:
        for split_name, count in (("train", n_train), ("validation", n_val), ("test", n_test)):
            for _ in range(count):
                sid = f"subj_{scale}_{seq:04d}"
                subjects_plan.append(
                    {
                        "subjectId": sid,
                        "split": split_name,
                        "scenario": scenario,
                        "seq": seq,
                    }
                )
                seq += 1

    quotas = _allocate_event_quotas(subjects_plan, target_events)

    subjects_rows: List[Dict[str, Any]] = []
    splits_rows: List[Dict[str, Any]] = []
    collections_rows: List[Dict[str, Any]] = []
    events_rows: List[Dict[str, Any]] = []
    truth_rows: List[Dict[str, Any]] = []
    control_cases: List[Dict[str, Any]] = []

    for item in subjects_plan:
        sid = item["subjectId"]
        split_name = item["split"]
        scenario = item["scenario"]
        idx = item["seq"]
        quota = quotas[sid]

        primary_dom = domains[idx % len(domains)]
        secondary_dom = domains[(idx + 3) % len(domains)]
        noise_dom = domains[(idx + 5) % len(domains)]

        primary_pool = repos_by_domain[primary_dom] or repos
        secondary_pool = repos_by_domain[secondary_dom] or repos
        noise_pool = repos_by_domain[noise_dom] or repos

        # Build Stars collection & scenario truth
        star_repo_ids: List[str] = []
        expected_confidence = "high"
        expected_top_domains = [primary_dom]
        historical_dom: Optional[str] = None
        recent_dom: Optional[str] = None
        temp_dom: Optional[str] = None

        if scenario == "no_evidence":
            expected_confidence = "none"
            expected_top_domains = []
        elif scenario == "sparse":
            expected_confidence = "low"
            star_repo_ids = [str(primary_pool[0]["repoId"])] if idx % 2 == 0 else []
        elif scenario == "star_only":
            expected_confidence = "medium"
            k = min(len(primary_pool), 8 + (idx % 5))
            star_repo_ids = sorted({str(primary_pool[j % len(primary_pool)]["repoId"]) for j in range(k)})
        elif scenario == "stable_single":
            k = min(len(primary_pool), 4 + (idx % 4))
            star_repo_ids = sorted({str(primary_pool[j % len(primary_pool)]["repoId"]) for j in range(k)})
        elif scenario == "stable_multi":
            expected_top_domains = [primary_dom, secondary_dom]
            star_repo_ids = sorted(
                {
                    str(primary_pool[0]["repoId"]),
                    str(primary_pool[1 % len(primary_pool)]["repoId"]),
                    str(secondary_pool[0]["repoId"]),
                    str(secondary_pool[1 % len(secondary_pool)]["repoId"]),
                }
            )
        elif scenario == "recent_shift":
            historical_dom = primary_dom
            recent_dom = secondary_dom
            expected_top_domains = [recent_dom, historical_dom]
            star_repo_ids = sorted(
                {
                    str(primary_pool[0]["repoId"]),
                    str(secondary_pool[0]["repoId"]),
                    str(secondary_pool[1 % len(secondary_pool)]["repoId"]),
                }
            )
        elif scenario == "temporary_task":
            temp_dom = secondary_dom
            expected_top_domains = [primary_dom]
            star_repo_ids = sorted(
                {
                    str(primary_pool[0]["repoId"]),
                    str(primary_pool[1 % len(primary_pool)]["repoId"]),
                    str(primary_pool[2 % len(primary_pool)]["repoId"]),
                }
            )
        elif scenario == "exploration_noise":
            star_repo_ids = sorted(
                {
                    str(primary_pool[0]["repoId"]),
                    str(primary_pool[1 % len(primary_pool)]["repoId"]),
                }
            )
        elif scenario == "language_topic_conflict":
            expected_top_domains = [primary_dom, secondary_dom]
            star_repo_ids = sorted(
                {
                    str(secondary_pool[j % len(secondary_pool)]["repoId"])
                    for j in range(min(5, len(secondary_pool)))
                }
            )
        elif scenario == "revisit_heavy":
            star_repo_ids = sorted({str(primary_pool[0]["repoId"]), str(primary_pool[1 % len(primary_pool)]["repoId"])})
        elif scenario == "ambiguous":
            expected_confidence = "low"
            expected_top_domains = [primary_dom, secondary_dom, noise_dom]
            star_repo_ids = sorted({str( repos[(idx + j * 7) % len(repos)]["repoId"] ) for j in range(3)})

        subjects_rows.append(
            {
                "kind": "subject",
                "schemaVersion": "1.0.0",
                "subjectId": sid,
                "split": split_name,
                "cohortHint": scenario,
                "manualTags": [],
                "hiddenRepoIds": [],
                "createdAt": window_start - DAY_MS,
                "referenceTime": reference_time,
                "sourceKind": "synthetic",
            }
        )
        splits_rows.append(
            {
                "subjectId": sid,
                "split": split_name,
                "scenario": scenario,
                "seed": seed,
            }
        )

        collections_rows.append(
            {
                "kind": "collection",
                "schemaVersion": "1.0.0",
                "subjectId": sid,
                "collectionKind": "stars",
                "complete": True,
                "observedAt": reference_time - 300_000,
                "repoIds": star_repo_ids,
                "sourceKind": "synthetic",
            }
        )
        collections_rows.append(
            {
                "kind": "collection",
                "schemaVersion": "1.0.0",
                "subjectId": sid,
                "collectionKind": "owned",
                "complete": False,
                "observedAt": reference_time - 300_000,
                "repoIds": [],
                "sourceKind": "unknown",
            }
        )

        # Generate effective browse events with >= 31,000ms same-repo spacing
        last_ts_by_repo: Dict[str, int] = {}
        subject_events: List[Dict[str, Any]] = []

        for e_idx in range(quota):
            if scenario == "stable_single":
                pool = primary_pool if (e_idx % 10 < 8) else secondary_pool
                chosen = pool[(idx + e_idx) % len(pool)]
                day_offset = 1 + int((e_idx / max(1, quota)) * 88)
            elif scenario == "stable_multi":
                pool = primary_pool if (e_idx % 2 == 0) else secondary_pool
                chosen = pool[(idx + e_idx) % len(pool)]
                day_offset = 1 + int((e_idx / max(1, quota)) * 88)
            elif scenario == "recent_shift":
                # First 30% of events in days 1..55 on historical_dom, last 70% in days 61..89 on recent_dom
                if e_idx < int(quota * 0.30):
                    pool = primary_pool
                    day_offset = 1 + int((e_idx / max(1, int(quota * 0.30))) * 54)
                else:
                    pool = secondary_pool
                    rel = e_idx - int(quota * 0.30)
                    rem = max(1, quota - int(quota * 0.30))
                    day_offset = 61 + int((rel / rem) * 28)
                chosen = pool[(idx + e_idx) % len(pool)]
            elif scenario == "temporary_task":
                # 75% long-term across days 1..88, 25% concentrated in a 48h window around day 75..76
                if e_idx < int(quota * 0.75):
                    pool = primary_pool
                    day_offset = 1 + int((e_idx / max(1, int(quota * 0.75))) * 87)
                else:
                    pool = secondary_pool
                    day_offset = 75 + (e_idx % 2)
                chosen = pool[(idx + e_idx) % len(pool)]
            elif scenario == "exploration_noise":
                # 65% primary, 35% scattered across all repos
                if e_idx % 20 < 13:
                    chosen = primary_pool[(idx + e_idx) % len(primary_pool)]
                else:
                    chosen = repos[(idx * 17 + e_idx * 31) % len(repos)]
                day_offset = 1 + int((e_idx / max(1, quota)) * 88)
            elif scenario == "sparse":
                chosen = primary_pool[(idx + e_idx) % len(primary_pool)]
                day_offset = 20 + e_idx * 15
            elif scenario == "language_topic_conflict":
                # Browse primary_pool heavily while stars are in secondary_pool
                chosen = primary_pool[(idx + e_idx) % len(primary_pool)]
                day_offset = 5 + int((e_idx / max(1, quota)) * 82)
            elif scenario == "revisit_heavy":
                # Repeat visits to only 2-3 core repositories
                core_count = min(3, len(primary_pool))
                chosen = primary_pool[e_idx % core_count]
                day_offset = 2 + int((e_idx / max(1, quota)) * 86)
            else:  # ambiguous
                chosen = repos[(idx * 13 + e_idx * 19) % len(repos)]
                day_offset = 1 + int((e_idx / max(1, quota)) * 88)

            rid = str(chosen["repoId"])
            candidate_ts = window_start + day_offset * DAY_MS + ((e_idx * 45_000) % (12 * 3600_000))
            prev_ts = last_ts_by_repo.get(rid)
            if prev_ts is not None and candidate_ts < prev_ts + MIN_SAME_REPO_INTERVAL_MS:
                candidate_ts = prev_ts + MIN_SAME_REPO_INTERVAL_MS + 1000
            if candidate_ts > reference_time - 1000:
                # Backfill safely while maintaining >= 31,000ms spacing
                candidate_ts = max(
                    window_start + 60_000,
                    (prev_ts + MIN_SAME_REPO_INTERVAL_MS) if prev_ts else (reference_time - 3600_000),
                )
                if candidate_ts > reference_time:
                    candidate_ts = reference_time - (quota - e_idx) * MIN_SAME_REPO_INTERVAL_MS

            last_ts_by_repo[rid] = candidate_ts
            event_id = f"evt_{sid}_{e_idx + 1:05d}"
            subject_events.append(
                {
                    "kind": "event",
                    "schemaVersion": "1.0.0",
                    "eventId": event_id,
                    "subjectId": sid,
                    "deviceId": f"dev_{sid}",
                    "streamEpoch": 1,
                    "deviceSeq": e_idx + 1,
                    "analysisEpoch": 1,
                    "recordKind": "open",
                    "source": "browse",
                    "entrySource": "feed" if e_idx % 3 == 0 else ("search" if e_idx % 3 == 1 else "direct"),
                    "repoId": rid,
                    "occurredAt": candidate_ts,
                    "effectiveAt": candidate_ts,
                    "receivedAt": candidate_ts + 2000,
                    "timeFlag": "normal",
                    "sourceKind": "synthetic",
                }
            )

        events_rows.extend(subject_events)

        # Build generator truth for evaluation-only
        top_langs: List[str] = []
        top_topics: List[str] = []
        for dom_id in expected_top_domains:
            dom_obj = next((d for d in taxonomy["domains"] if d["domainId"] == dom_id), None)
            if dom_obj:
                for l_name in dom_obj["primaryLanguages"]:
                    if l_name not in top_langs:
                        top_langs.append(l_name)
                for t_name in dom_obj["topics"][:3]:
                    if t_name not in top_topics:
                        top_topics.append(t_name)

        truth_rows.append(
            {
                "kind": "generator_truth",
                "schemaVersion": "1.0.0",
                "subjectId": sid,
                "split": split_name,
                "scenario": scenario,
                "expectedConfidence": expected_confidence,
                "expectedTopDomains": expected_top_domains,
                "expectedTopLanguages": top_langs[:3],
                "expectedTopTopics": top_topics[:6],
                "historicalDomain": historical_dom,
                "recentDomain": recent_dom,
                "temporaryTaskDomain": temp_dom,
                "effectiveBrowseEventCount": len(subject_events),
                "starRepoCount": len(star_repo_ids),
            }
        )

        if split_name in ("validation", "test") and len(control_cases) < 20:
            sample_evidence_repos = sorted(
                list({ev["repoId"] for ev in subject_events[:3]} | set(star_repo_ids[:2]))
            )
            positive_candidates = [
                str(r["repoId"])
                for r in primary_pool
                if str(r["repoId"]) not in sample_evidence_repos
            ][:3]
            negative_candidates = [
                str(r["repoId"])
                for r in noise_pool
                if str(r["repoId"]) not in sample_evidence_repos
            ][:3]
            control_cases.append(
                {
                    "kind": "control_case",
                    "schemaVersion": "1.0.0",
                    "caseId": f"ctrl_{sid}",
                    "subjectId": sid,
                    "split": split_name,
                    "scenario": scenario,
                    "expectedConfidence": expected_confidence,
                    "requiredEvidenceRepoIds": sample_evidence_repos,
                    "positiveCandidateRepoIds": positive_candidates,
                    "negativeCandidateRepoIds": negative_candidates,
                }
            )

    return {
        "subjects": subjects_rows,
        "splits": splits_rows,
        "collections": collections_rows,
        "events": events_rows,
        "truth": truth_rows,
        "controlCases": control_cases,
    }


def build_dataset(
    scale: str,
    catalog_mode: str,
    output_dir: Path,
    datasets_root: Path,
    seed: int = SEED_DEFAULT,
    reference_time: int = REFERENCE_TIME_DEFAULT,
    derived_profiles_input: Optional[Path] = None,
) -> Dict[str, Any]:
    taxonomy_path = datasets_root / "taxonomy.json"
    real_repos_path = datasets_root / "sources" / "repositories-real.jsonl"
    real_collections_path = datasets_root / "sources" / "user-collections-real.jsonl"

    taxonomy = json.loads(taxonomy_path.read_text(encoding="utf-8"))
    real_repos = _read_jsonl(real_repos_path)
    real_collections = _read_jsonl(real_collections_path)

    target_repo_count = 240 if scale == "pilot" else 10000
    target_subject_count = 50 if scale == "pilot" else 1000
    target_browse_events = 5000 if scale == "pilot" else 200000

    gap_inspection = _inspect_real_catalog(
        real_repos=real_repos,
        real_collections=real_collections,
        taxonomy=taxonomy,
        target_repo_count=target_repo_count,
        reference_time=reference_time,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    gap_report_path = output_dir / "real-catalog-gap-report.json"
    gap_report_payload = {
        "schemaVersion": "1.0.0",
        "scale": scale,
        "catalogMode": catalog_mode,
        "referenceTime": reference_time,
        "readyForFormalRealExperiment": gap_inspection["ready"],
        "availableRealRepositoryCount": gap_inspection["availableRealRepositoryCount"],
        "requiredRealRepositoryCount": gap_inspection["requiredRealRepositoryCount"],
        "missingRealRepositoryCount": gap_inspection["missingRealRepositoryCount"],
        "realUserCollectionCount": gap_inspection["realUserCollectionCount"],
        "realUserCollectionsAvailable": gap_inspection["realUserCollectionsAvailable"],
        "domainCoverage": gap_inspection["domainCoverage"],
        "languageCounts": gap_inspection["languageCounts"],
        "popularityTierCounts": gap_inspection["popularityTierCounts"],
        "handoffNote": (
            "Real GitHub public repository catalog currently contains "
            f"{gap_inspection['availableRealRepositoryCount']} verified repositories "
            f"(target: {target_repo_count}). Do not duplicate or fabricate github_public READMEs; "
            "Member A should export collected public repositories to tools/datasets/sources/repositories-real.jsonl."
        ),
    }
    gap_report_path.write_text(
        json.dumps(gap_report_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if catalog_mode == "real" and not gap_inspection["ready"]:
        manifest = {
            "schemaVersion": "1.0.0",
            "datasetVersion": f"hg-{scale}-real-20261103",
            "scale": scale,
            "catalogMode": "real",
            "status": "blocked_missing_real_catalog",
            "seed": seed,
            "referenceTime": reference_time,
            "windowDays": WINDOW_DAYS_DEFAULT,
            "taxonomyVersion": taxonomy["taxonomyVersion"],
            "realCatalogGapReport": "real-catalog-gap-report.json",
            "counts": {
                "availableRealRepositories": gap_inspection["availableRealRepositoryCount"],
                "requiredRealRepositories": target_repo_count,
                "missingRealRepositories": gap_inspection["missingRealRepositoryCount"],
                "realUserCollections": gap_inspection["realUserCollectionCount"],
            },
        }
        (output_dir / "dataset-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return manifest

    rng = random.Random(seed)
    if catalog_mode == "real":
        repositories = sorted(
            gap_inspection["validRealRepositories"][:target_repo_count],
            key=lambda r: str(r["repoId"]),
        )
        _, annotations = _generate_fixture_repositories(
            existing_real=repositories,
            taxonomy=taxonomy,
            target_count=len(repositories),
            reference_time=reference_time,
            rng=rng,
        )
    else:
        repositories, annotations = _generate_fixture_repositories(
            existing_real=gap_inspection["validRealRepositories"],
            taxonomy=taxonomy,
            target_count=target_repo_count,
            reference_time=reference_time,
            rng=rng,
        )

    generated = _generate_subjects_and_behavior(
        repos=repositories,
        annotations=annotations,
        taxonomy=taxonomy,
        scale=scale,
        reference_time=reference_time,
        seed=seed,
    )

    canonical_dir = output_dir / "canonical"
    splits_dir = output_dir / "splits"
    eval_dir = output_dir / "evaluation-only"
    runtime_dir = output_dir / "runtime"

    files_inventory: List[Dict[str, Any]] = []

    def record_file(rel_path: str, rows: List[Dict[str, Any]]) -> None:
        target = output_dir / rel_path
        count, digest = _write_jsonl(target, rows)
        files_inventory.append(
            {
                "path": rel_path,
                "recordCount": count,
                "byteSize": target.stat().st_size,
                "sha256": digest,
            }
        )

    record_file("canonical/repositories.jsonl", repositories)
    record_file("canonical/subjects.jsonl", generated["subjects"])
    record_file("canonical/collections.jsonl", generated["collections"])
    record_file("canonical/events.jsonl", generated["events"])
    record_file("splits/subjects.jsonl", generated["splits"])

    record_file("evaluation-only/generator-truth.jsonl", generated["truth"])
    record_file("evaluation-only/catalog-annotations.jsonl", annotations)
    record_file("evaluation-only/control-cases.jsonl", generated["controlCases"])
    record_file("evaluation-only/llm-reference-profiles.jsonl", [])
    record_file("evaluation-only/reference-runs.jsonl", [])

    if derived_profiles_input and derived_profiles_input.exists():
        raw_derived = _read_jsonl(derived_profiles_input)
        normalized_derived = []
        for row in raw_derived:
            item = dict(row)
            item["kind"] = "derived_profile"
            item.setdefault("schemaVersion", "1.0.0")
            normalized_derived.append(item)
        record_file("evaluation-only/derived-profiles-replay.jsonl", normalized_derived)

    # Write runtime/{train,validation,test}/part-*.jsonl containing ONLY the 4 runtime kinds
    subjects_by_split: Dict[str, set[str]] = {"train": set(), "validation": set(), "test": set()}
    for s in generated["splits"]:
        subjects_by_split[s["split"]].add(s["subjectId"])

    runtime_shards_by_split: Dict[str, List[Dict[str, Any]]] = {}
    for split_name in ("train", "validation", "test"):
        allowed_sids = subjects_by_split[split_name]
        split_rows: List[Dict[str, Any]] = []
        # 1. All public repositories
        split_rows.extend(repositories)
        # 2. Subjects in split
        split_rows.extend(s for s in generated["subjects"] if s["subjectId"] in allowed_sids)
        # 3. Collections for subjects in split
        split_rows.extend(c for c in generated["collections"] if c["subjectId"] in allowed_sids)
        # 4. Events for subjects in split
        split_rows.extend(e for e in generated["events"] if e["subjectId"] in allowed_sids)

        shards = _write_sharded_runtime_jsonl(runtime_dir / split_name, split_rows)
        runtime_shards_by_split[split_name] = shards
        for shard in shards:
            files_inventory.append(
                {
                    "path": shard["relativePath"],
                    "recordCount": shard["recordCount"],
                    "byteSize": shard["byteSize"],
                    "sha256": shard["sha256"],
                }
            )

    # Build shared evidence views
    evidence_summary = build_evidence_views_for_dataset(
        dataset_dir=output_dir,
        reference_time=reference_time,
        window_days=WINDOW_DAYS_DEFAULT,
    )
    for split_name in ("train", "validation", "test"):
        ev_rel = f"evidence-views/{split_name}.jsonl"
        ev_path = output_dir / ev_rel
        files_inventory.append(
            {
                "path": ev_rel,
                "recordCount": evidence_summary["countsBySplit"][split_name],
                "byteSize": ev_path.stat().st_size,
                "sha256": _sha256_file(ev_path),
            }
        )

    provenance_rows = [
        {
            "kind": "provenance",
            "schemaVersion": "1.0.0",
            "asset": "sources/repositories-real.jsonl",
            "sourceKind": "github_public",
            "recordCount": gap_inspection["availableRealRepositoryCount"],
            "observedAt": reference_time,
            "note": "Verified public repositories from repo validation history.",
        },
        {
            "kind": "provenance",
            "schemaVersion": "1.0.0",
            "asset": "sources/user-collections-real.jsonl",
            "sourceKind": "github_public",
            "recordCount": gap_inspection["realUserCollectionCount"],
            "available": gap_inspection["realUserCollectionsAvailable"],
            "observedAt": reference_time,
            "note": "Optional real public user Star/Owned collections (not provided in current offline seed).",
        },
        {
            "kind": "provenance",
            "schemaVersion": "1.0.0",
            "asset": "canonical/repositories.jsonl",
            "sourceKind": "github_public" if catalog_mode == "real" else "synthetic_fixture",
            "recordCount": len(repositories),
            "seed": seed,
            "observedAt": reference_time,
            "note": (
                "Full real GitHub catalog."
                if catalog_mode == "real"
                else "Format demonstration fixture combining 4 real repos with deterministic synthetic_fixture repos."
            ),
        },
    ]
    record_file("provenance.jsonl", provenance_rows)

    manifest = {
        "schemaVersion": "1.0.0",
        "datasetVersion": f"hg-{scale}-{catalog_mode}-20261103",
        "scale": scale,
        "catalogMode": catalog_mode,
        "datasetKind": "real_plus_synthetic" if catalog_mode == "real" else "synthetic_fixture_demo",
        "status": "ready_for_formal_experiment" if catalog_mode == "real" else "ready_for_format_and_pipeline_verification",
        "seed": seed,
        "referenceTime": reference_time,
        "windowDays": WINDOW_DAYS_DEFAULT,
        "minSameRepoIntervalMs": MIN_SAME_REPO_INTERVAL_MS,
        "taxonomyVersion": taxonomy["taxonomyVersion"],
        "realUserCollectionsAvailable": gap_inspection["realUserCollectionsAvailable"],
        "realCatalogGapReport": "real-catalog-gap-report.json",
        "counts": {
            "repositories": len(repositories),
            "realRepositoriesIncluded": gap_inspection["availableRealRepositoryCount"],
            "syntheticFixtureRepositoriesIncluded": max(0, len(repositories) - gap_inspection["availableRealRepositoryCount"]),
            "subjects": len(generated["subjects"]),
            "subjectsBySplit": {
                "train": len(subjects_by_split["train"]),
                "validation": len(subjects_by_split["validation"]),
                "test": len(subjects_by_split["test"]),
            },
            "collections": len(generated["collections"]),
            "events": len(generated["events"]),
            "targetSubjects": target_subject_count,
            "targetEvents": target_browse_events,
        },
        "runtimeShards": runtime_shards_by_split,
        "files": files_inventory,
    }
    (output_dir / "dataset-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Build HappyGit server portrait dataset.")
    parser.add_argument("--scale", choices=("pilot", "standard"), default="pilot")
    parser.add_argument(
        "--catalog-mode",
        choices=("real", "synthetic_fixture"),
        default="real",
        help="Use 'real' to require full real GitHub catalog or 'synthetic_fixture' for format demo.",
    )
    parser.add_argument("--output-dir", required=True, help="Output directory for dataset package.")
    parser.add_argument("--seed", type=int, default=SEED_DEFAULT)
    parser.add_argument("--reference-time", type=int, default=REFERENCE_TIME_DEFAULT)
    parser.add_argument("--derived-profiles-input", default=None)
    args = parser.parse_args()

    datasets_root = Path(__file__).resolve().parent
    derived_path = Path(args.derived_profiles_input) if args.derived_profiles_input else None
    manifest = build_dataset(
        scale=args.scale,
        catalog_mode=args.catalog_mode,
        output_dir=Path(args.output_dir),
        datasets_root=datasets_root,
        seed=args.seed,
        reference_time=args.reference_time,
        derived_profiles_input=derived_path,
    )
    print(json.dumps({"status": manifest["status"], "datasetVersion": manifest["datasetVersion"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
