#!/usr/bin/env python3
"""Prompt builder for independent LLM reference portrait evaluation.

STRICT ANTI-LEAKAGE RULES:
  - Uses ONLY public evidence from `evidence-views/{split}.jsonl` and public `taxonomy.json`.
  - MUST NOT include `generator-truth`, `control-cases`, scenario labels, expected confidence,
    model weights, learned directions, or baseline algorithm outputs.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List


FORBIDDEN_LEAK_KEYS = {
    "expectedTopDomains",
    "expectedTopLanguages",
    "expectedTopTopics",
    "expectedConfidence",
    "scenario",
    "historicalDomain",
    "recentDomain",
    "temporaryTaskDomain",
    "positiveCandidateRepoIds",
    "negativeCandidateRepoIds",
    "requiredEvidenceRepoIds",
    "representativeRepositories",
}


def compute_sha256_canonical(obj: Any) -> str:
    payload = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def verify_no_leakage(payload: Any, path_prefix: str = "") -> None:
    if isinstance(payload, dict):
        for k, v in payload.items():
            if k in FORBIDDEN_LEAK_KEYS:
                raise ValueError(f"Leakage detected: forbidden key '{path_prefix}{k}' found in LLM prompt input")
            verify_no_leakage(v, f"{path_prefix}{k}.")
    elif isinstance(payload, list):
        for idx, item in enumerate(payload):
            verify_no_leakage(item, f"{path_prefix}[{idx}].")


def build_llm_prompt_for_subject(
    evidence_view_row: Dict[str, Any],
    taxonomy: Dict[str, Any],
    prompt_version: str = "hg-llm-eval-v1",
) -> Dict[str, Any]:
    if evidence_view_row.get("kind") != "evidence_view":
        raise ValueError("Input row must be an evidence_view record")

    subject_id = str(evidence_view_row["subjectId"])
    ev = evidence_view_row.get("evidence") or {}

    # Verify raw evidence SHA-256 against stored evidenceHash when present
    expected_hash = evidence_view_row.get("evidenceHash")
    computed_evidence_hash = compute_sha256_canonical(ev)
    if expected_hash and expected_hash != computed_evidence_hash:
        raise ValueError(f"Evidence hash mismatch for {subject_id}: expected {expected_hash}, got {computed_evidence_hash}")

    repos_by_id = {}
    for r in ev.get("repositories") or []:
        rid = str(r.get("repoId") or "")
        if not rid:
            continue
        repos_by_id[rid] = {
            "repoId": rid,
            "fullName": r.get("fullName"),
            "primaryLanguage": r.get("primaryLanguage"),
            "topics": list(r.get("topics") or []),
            "description": r.get("description"),
            "readmeExcerpt": (r.get("readmeExcerpt") or "")[:800],
            "starCount": r.get("starCount"),
        }

    browse_summary = []
    for b in ev.get("browse") or []:
        rid = str(b.get("repoId") or "")
        repo_meta = repos_by_id.get(rid)
        if not repo_meta:
            continue
        browse_summary.append({
            "repoId": rid,
            "fullName": repo_meta["fullName"],
            "openCount": int(b.get("count") or 1),
            "occurredAt": list(b.get("occurredAt") or []),
            "primaryLanguage": repo_meta["primaryLanguage"],
            "topics": repo_meta["topics"],
            "description": repo_meta["description"],
        })

    stars_info = ev.get("stars") or {}
    owned_info = ev.get("owned") or {}
    sanitized_evidence = {
        "subjectId": subject_id,
        "referenceTime": int(ev.get("referenceTime") or evidence_view_row.get("referenceTime") or 0),
        "windowDays": int(ev.get("windowDays") or 90),
        "manualTags": list(ev.get("manualTags") or []),
        "stars": {
            "complete": bool(stars_info.get("complete", False)),
            "repos": [repos_by_id[str(rid)] for rid in (stars_info.get("repoIds") or []) if str(rid) in repos_by_id],
        },
        "owned": {
            "complete": bool(owned_info.get("complete", False)),
            "repos": [repos_by_id[str(rid)] for rid in (owned_info.get("repoIds") or []) if str(rid) in repos_by_id],
        },
        "browseEvents": browse_summary,
    }

    public_taxonomy = {
        "taxonomyVersion": taxonomy.get("taxonomyVersion"),
        "languages": list(taxonomy.get("languages") or []),
        "canonicalTopics": list(taxonomy.get("canonicalTopics") or []),
        "domains": [
            {
                "domainId": d.get("domainId"),
                "label": d.get("label"),
                "primaryLanguages": list(d.get("primaryLanguages") or []),
                "topics": list(d.get("topics") or []),
            }
            for d in (taxonomy.get("domains") or [])
        ],
    }

    verify_no_leakage(sanitized_evidence)
    verify_no_leakage(public_taxonomy)

    system_prompt = (
        "You are an independent technical interest evaluator. "
        "Infer the developer's open-source technical interests STRICTLY from the provided public evidence "
        "(starred repositories, owned public repositories, manual tags, and timestamped browse opens within the observation window) "
        "and map topics to the provided public taxonomy whenever applicable. "
        "If evidence is empty or insufficient, return status='empty' with empty distributions and an empty evidenceRepos list—NEVER fabricate evidence or force a category. "
        "Every repoId cited in evidenceRepos MUST appear in the provided stars, owned, or browseEvents inputs. "
        "Respond with a single JSON object matching: "
        '{"status":"ready|empty","languages":{"Lang":weight},"topics":{"topic":weight},'
        '"topInterests":[{"tag":"topic","score":0.0,"evidenceRepos":["repoId"]}],'
        '"evidenceRepos":["repoId"],"rationale":"brief explanation"}.'
    )

    user_payload = {
        "promptVersion": prompt_version,
        "publicTaxonomy": public_taxonomy,
        "userEvidence": sanitized_evidence,
    }
    user_prompt = json.dumps(user_payload, ensure_ascii=False, separators=(",", ":"))
    prompt_digest = compute_sha256_canonical({"systemPrompt": system_prompt, "userPayload": user_payload})

    return {
        "subjectId": subject_id,
        "split": evidence_view_row.get("split", "test"),
        "promptVersion": prompt_version,
        "evidenceHash": computed_evidence_hash,
        "promptDigest": prompt_digest,
        "systemPrompt": system_prompt,
        "userPrompt": user_prompt,
    }
