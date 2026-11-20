#!/usr/bin/env python3
"""File-based experiment runner for HappyGit interest portrait evaluation.

Compares:
  1. baseline_local_v1 (rule-weighted content baseline matching client & J07-J09)
  2. learned_model (loaded from A's file-based inference output or CLI adapter)
  3. llm_reference (independent LLM via sanitized common-evidence prompts; prepare in R2, API run in R3)

Produces reproducible manifests, input SHA-256 verification, per-scenario/source/sparsity
reports, pairwise agreement, hallucination audits, and optional subset stability checks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shlex
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

EXPERIMENTS_DIR = Path(__file__).resolve().parent
if str(EXPERIMENTS_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_DIR))

from metrics import (  # noqa: E402
    BLIND_AUDIT_CATEGORIES,
    aggregate_metrics,
    compute_method_comparison_deltas,
    compute_pairwise_agreement,
    evaluate_subject_prediction,
    load_aliases,
    make_failed_subject_evaluation,
    normalize_distribution,
    normalize_language,
    normalize_topic,
    summarize_blind_audit,
)
from prompt_builder import build_llm_prompt_for_subject, compute_sha256_canonical  # noqa: E402
from render_charts import render_experiment_charts  # noqa: E402


REPO_ROOT = EXPERIMENTS_DIR.parent.parent
DEFAULT_TAXONOMY_PATH = REPO_ROOT / "tools" / "datasets" / "taxonomy.json"
DAY_MS = 86_400_000


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            s = line.strip()
            if s:
                rows.append(json.loads(s))
    return rows


def write_jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def current_git_commit() -> Optional[str]:
    for cmd in (
        ["git", "rev-parse", "HEAD"],
        ["git", "-c", "safe.directory=*", "rev-parse", "HEAD"],
    ):
        try:
            out = subprocess.check_output(
                cmd,
                cwd=str(REPO_ROOT),
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
            if out:
                return out
        except Exception:
            continue
    return None


def run_rule_baseline_for_subject(
    evidence_view_row: Dict[str, Any],
    aliases: Dict[str, Any],
) -> Dict[str, Any]:
    """Deterministic file-based implementation of the rule-weighted content baseline."""
    subject_id = str(evidence_view_row["subjectId"])
    ev = evidence_view_row.get("evidence") or {}
    reference_time = int(ev.get("referenceTime") or evidence_view_row.get("referenceTime") or 0)
    repos_by_id = {str(r["repoId"]): r for r in (ev.get("repositories") or []) if r.get("repoId")}
    hidden = {str(x) for x in (ev.get("hiddenRepoIds") or [])}

    weights: Dict[str, Tuple[float, Set[str]]] = {}

    def _add_weight(rid: str, w: float, source_name: str) -> None:
        if not rid or rid in hidden or rid not in repos_by_id:
            return
        if rid in weights:
            old_w, srcs = weights[rid]
            srcs.add(source_name)
            weights[rid] = (old_w + w, srcs)
        else:
            weights[rid] = (w, {source_name})

    stars = ev.get("stars") or {}
    if stars.get("complete") is not False:
        for rid in stars.get("repoIds") or []:
            _add_weight(str(rid), 3.0, "star")

    owned = ev.get("owned") or {}
    if owned.get("complete") is not False:
        for rid in owned.get("repoIds") or []:
            _add_weight(str(rid), 1.5, "owned")

    for b in ev.get("browse") or []:
        rid = str(b.get("repoId") or "")
        opens = max(1, int(b.get("count") or 1))
        occurred = [int(t) for t in (b.get("occurredAt") or []) if int(t) <= reference_time]
        last_at = max(occurred) if occurred else reference_time
        days = max(0.0, (reference_time - last_at) / float(DAY_MS))
        w = min(1.0 + math.log(opens), 3.0) * math.pow(2.0, -days / 30.0)
        _add_weight(rid, w, "browse")

    lang_scores: Dict[str, float] = {}
    topic_scores: Dict[str, float] = {}
    topic_repos: Dict[str, List[Tuple[str, float]]] = {}
    evidence_repos: List[Dict[str, Any]] = []

    for rid, (w, srcs) in weights.items():
        repo = repos_by_id.get(rid)
        if not repo or w <= 0:
            continue
        pl = normalize_language(repo.get("primaryLanguage"), aliases)
        if pl:
            lang_scores[pl] = lang_scores.get(pl, 0.0) + w
        tps = [normalize_topic(t, aliases) for t in (repo.get("topics") or [])]
        tps = [t for t in dict.fromkeys(tps) if t]
        if tps:
            share = w / len(tps)
            for t in tps:
                topic_scores[t] = topic_scores.get(t, 0.0) + share
                topic_repos.setdefault(t, []).append((rid, share))
        evidence_repos.append({
            "repoId": rid,
            "fullName": repo.get("fullName"),
            "primaryLanguage": pl or repo.get("primaryLanguage"),
            "topics": tps,
            "weight": round(w, 4),
            "sources": sorted(srcs),
        })

    manual_tags = [normalize_topic(t, aliases) for t in (ev.get("manualTags") or [])]
    manual_tags = [t for t in dict.fromkeys(manual_tags) if t]
    if manual_tags:
        per_tag = 4.0 / len(manual_tags)
        for tag in manual_tags:
            topic_scores[tag] = topic_scores.get(tag, 0.0) + per_tag

    evidence_repos.sort(key=lambda r: (-r["weight"], r["repoId"]))
    languages_dist = normalize_distribution(lang_scores, lambda x: x)
    topics_dist = normalize_distribution(topic_scores, lambda x: x)

    sorted_topics = sorted(topic_scores.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    topic_total = sum(topic_scores.values()) or 1.0
    top_interests = []
    for tag, val in sorted_topics:
        cited = sorted(topic_repos.get(tag, []), key=lambda x: (-x[1], x[0]))[:5]
        top_interests.append({
            "tag": tag,
            "score": round(val / topic_total, 4),
            "evidenceRepos": [rid for rid, _ in cited],
        })

    status = "ready" if (top_interests or languages_dist or topics_dist) else "empty"
    return {
        "subjectId": subject_id,
        "method": "baseline_local_v1",
        "modelVersion": "baseline-local-v1",
        "status": status,
        "evidenceHash": evidence_view_row.get("evidenceHash"),
        "languages": languages_dist,
        "topics": topics_dist,
        "topInterests": top_interests,
        "evidenceRepos": [r["repoId"] for r in evidence_repos[:20]],
    }


def _extract_json_object(raw_text: str) -> Dict[str, Any]:
    text = raw_text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return json.loads(text)


def call_openai_compatible_llm(
    prompt_row: Dict[str, Any],
    api_url: str,
    api_key: str,
    model_name: str,
    timeout_sec: int = 60,
    temperature: float = 0.0,
    provider: Optional[str] = None,
) -> Dict[str, Any]:
    endpoint = api_url.rstrip("/")
    if not endpoint.endswith("/chat/completions"):
        endpoint = f"{endpoint}/chat/completions"
    resolved_provider = provider or (urllib.parse.urlparse(endpoint).hostname or "openai-compatible")
    called_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    request_params = {
        "temperature": temperature,
        "response_format": "json_object",
        "timeoutSec": timeout_sec,
    }

    body = json.dumps({
        "model": model_name,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": prompt_row["systemPrompt"]},
            {"role": "user", "content": prompt_row["userPrompt"]},
        ],
    }).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            resp_raw = resp.read().decode("utf-8")
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        resp_json = json.loads(resp_raw)
        content = resp_json["choices"][0]["message"]["content"]
        parsed = _extract_json_object(content)
        return {
            "ok": True,
            "subjectId": prompt_row["subjectId"],
            "provider": resolved_provider,
            "calledAt": called_at,
            "modelIdentifier": resp_json.get("model") or model_name,
            "promptVersion": prompt_row["promptVersion"],
            "promptDigest": prompt_row["promptDigest"],
            "requestParams": request_params,
            "evidenceHash": prompt_row["evidenceHash"],
            "elapsedMs": elapsed_ms,
            "prediction": {
                "subjectId": prompt_row["subjectId"],
                "method": "llm_reference",
                "modelVersion": resp_json.get("model") or model_name,
                "status": parsed.get("status", "ready"),
                "languages": parsed.get("languages") or {},
                "topics": parsed.get("topics") or {},
                "topInterests": parsed.get("topInterests") or [],
                "evidenceRepos": parsed.get("evidenceRepos") or [],
            },
            "rawResponse": content,
        }
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, KeyError, IndexError, TimeoutError, ValueError) as err:
        return {
            "ok": False,
            "subjectId": prompt_row["subjectId"],
            "provider": resolved_provider,
            "calledAt": called_at,
            "modelIdentifier": model_name,
            "promptVersion": prompt_row["promptVersion"],
            "promptDigest": prompt_row["promptDigest"],
            "requestParams": request_params,
            "evidenceHash": prompt_row["evidenceHash"],
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "error": str(err),
        }


def load_predictions_map(path: Path) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    for row in read_jsonl(path):
        sid = str(row.get("subjectId") or "")
        if sid:
            result[sid] = row
    return result


def run_prediction_command(
    cmd_template: str,
    dataset_dir: Path,
    split: str,
    output_path: Path,
    evidence_path: Path,
) -> Tuple[bool, int, Optional[str]]:
    formatted = cmd_template.format(
        dataset_dir=str(dataset_dir),
        split=split,
        output=str(output_path),
        evidence_file=str(evidence_path),
    )
    tokens = shlex.split(formatted, posix=(os.name != "nt"))
    cleaned_tokens = [
        tok[1:-1] if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in ('"', "'") else tok
        for tok in tokens
    ]
    started = time.perf_counter()
    proc = subprocess.run(
        cleaned_tokens,
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    duration_ms = int((time.perf_counter() - started) * 1000)
    if proc.returncode != 0:
        return False, duration_ms, f"command failed ({proc.returncode}): {proc.stderr.strip()}"
    return True, duration_ms, None


def select_stratified_repeat_subset(
    prompts: List[Dict[str, Any]],
    truth_by_id: Dict[str, Dict[str, Any]],
    control_by_id: Dict[str, Dict[str, Any]],
    subset_size: int = 20,
    seed: int = 20261103,
) -> List[Dict[str, Any]]:
    """Deterministically pick a stratified subset across scenarios for repeat variance checks."""
    if not prompts or subset_size <= 0:
        return []
    if len(prompts) <= subset_size:
        return list(prompts)

    rng = random.Random(seed)
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for p in prompts:
        sid = str(p["subjectId"])
        scen = (
            (control_by_id.get(sid) or {}).get("scenario")
            or (truth_by_id.get(sid) or {}).get("scenario")
            or "unknown"
        )
        buckets.setdefault(str(scen), []).append(p)

    for rows in buckets.values():
        rows.sort(key=lambda r: str(r["subjectId"]))
        rng.shuffle(rows)

    selected: List[Dict[str, Any]] = []
    keys = sorted(buckets.keys())
    cursors = {k: 0 for k in keys}
    while len(selected) < subset_size:
        progressed = False
        for k in keys:
            idx = cursors[k]
            if idx < len(buckets[k]):
                selected.append(buckets[k][idx])
                cursors[k] = idx + 1
                progressed = True
                if len(selected) >= subset_size:
                    break
        if not progressed:
            break
    selected.sort(key=lambda r: str(r["subjectId"]))
    return selected


def load_server_export_bundle(server_export_dir: Path) -> Dict[str, Any]:
    """Load & verify Member A's learning-export directory (run-manifest.json + baseline.jsonl + learned.jsonl)."""
    export_dir = server_export_dir.resolve()
    manifest_path = export_dir / "run-manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"run-manifest.json not found in server export dir: {export_dir}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("state") != "completed":
        raise ValueError(f"Server export manifest state is not completed: {manifest.get('state')}")

    files_meta = manifest.get("files") or {}
    loaded: Dict[str, Any] = {
        "exportDir": str(export_dir),
        "manifest": manifest,
        "baselinePath": None,
        "learnedPath": None,
    }
    for key_name, out_key in (("baseline", "baselinePath"), ("learned", "learnedPath")):
        entry = files_meta.get(key_name)
        if not isinstance(entry, dict):
            continue
        rel_path = entry.get("path") or f"{key_name}.jsonl"
        target_path = export_dir / rel_path
        if not target_path.exists():
            raise FileNotFoundError(f"Expected exported prediction file missing: {target_path}")
        expected_sha = str(entry.get("sha256") or "").strip().lower()
        if expected_sha:
            actual_sha = file_sha256(target_path).lower()
            if actual_sha != expected_sha:
                raise ValueError(
                    f"SHA-256 mismatch for {target_path.name}: expected {expected_sha}, got {actual_sha}"
                )
        loaded[out_key] = target_path
    return loaded


def summarize_repeat_stability(
    repeat_runs: List[Dict[str, Dict[str, Any]]],
    subset_ids: List[str],
    aliases: Dict[str, Any],
    failures_per_run: List[int],
) -> Dict[str, Any]:
    pair_scores = []
    for idx_a in range(len(repeat_runs)):
        for idx_b in range(idx_a + 1, len(repeat_runs)):
            agr = compute_pairwise_agreement(repeat_runs[idx_a], repeat_runs[idx_b], aliases=aliases)
            pair_scores.append({
                "runA": idx_a + 1,
                "runB": idx_b + 1,
                **agr,
            })

    def _stats(field: str) -> Dict[str, Optional[float]]:
        vals = [float(p[field]) for p in pair_scores if isinstance(p.get(field), (int, float))]
        if not vals:
            return {"mean": None, "std": None, "min": None, "max": None}
        return {
            "mean": round(sum(vals) / len(vals), 4),
            "std": round(statistics.pstdev(vals), 4) if len(vals) > 1 else 0.0,
            "min": round(min(vals), 4),
            "max": round(max(vals), 4),
        }

    status_consistent = 0
    evaluated_subset = 0
    for sid in subset_ids:
        statuses = [run[sid].get("status", "ready") for run in repeat_runs if sid in run]
        if len(statuses) >= 2:
            evaluated_subset += 1
            if len(set(statuses)) == 1:
                status_consistent += 1

    return {
        "subsetSize": len(subset_ids),
        "subsetSubjectIds": subset_ids,
        "totalCallsPerSubsetSubject": len(repeat_runs),
        "failuresPerRun": failures_per_run,
        "statusExactConsistencyRate": round(status_consistent / evaluated_subset, 4) if evaluated_subset else None,
        "summary": {
            "top8TagJaccard": _stats("top8TagJaccard"),
            "languageCosineAgreement": _stats("languageCosineAgreement"),
            "topicCosineAgreement": _stats("topicCosineAgreement"),
        },
        "pairwiseStability": pair_scores,
    }


def export_blind_review_sample(
    output_dir: Path,
    evidence_by_id: Dict[str, Dict[str, Any]],
    predictions_by_method: Dict[str, Dict[str, Dict[str, Any]]],
    sample_count: int = 15,
    seed: int = 42,
) -> Optional[Dict[str, Any]]:
    if sample_count <= 0 or len(predictions_by_method) < 2:
        return None
    method_names = sorted(predictions_by_method.keys())
    eligible_sids = [
        sid for sid in sorted(evidence_by_id)
        if sum(1 for m in method_names if sid in predictions_by_method[m]) >= 2
    ]
    if not eligible_sids:
        return None

    rng = random.Random(seed)
    chosen_sids = list(eligible_sids)
    if len(chosen_sids) > sample_count:
        rng.shuffle(chosen_sids)
        chosen_sids = sorted(chosen_sids[:sample_count])

    samples: List[Dict[str, Any]] = []
    unblind_key: Dict[str, Dict[str, str]] = {}
    audit_template_rows: List[Dict[str, Any]] = []
    worksheet_lines: List[str] = [
        "# 匿名盲评证据核查记录表 (Blind Evidence Audit Worksheet)",
        "",
        "评审类别（仅四选一填写至 `blind-review-audit-template.jsonl` 的 `category` 字段）：",
        "- `grounded`（有依据）：兴趣标签与分布可由该用户公开证据直接支撑，引用项目均真实存在。",
        "- `over_inferred`（推断过强）：超出给定仓库与浏览证据做过度外推。",
        "- `nonexistent_citation`（引用不存在）：引用了用户证据集合之外的仓库 ID。",
        "- `insufficient_evidence`（证据不足）：证据极少或为空却未诚实保守降级/留空。",
        "",
    ]

    for sid in chosen_sids:
        row = evidence_by_id[sid]
        ev = row.get("evidence") or {}
        avail_methods = [m for m in method_names if sid in predictions_by_method[m]]
        shuffled = list(avail_methods)
        rng.shuffle(shuffled)

        repo_summary = [
            {
                "repoId": str(r.get("repoId")),
                "fullName": r.get("fullName"),
                "primaryLanguage": r.get("primaryLanguage"),
                "topics": (r.get("topics") or [])[:8],
                "sources": r.get("sources") or [],
            }
            for r in (ev.get("repositories") or [])[:12]
            if isinstance(r, dict)
        ]

        anon_entries = []
        mapping: Dict[str, str] = {}
        worksheet_lines.append(f"## 样本 `{sid}` (证据仓库数: {len(ev.get('repositories') or [])})")
        worksheet_lines.append("")
        if repo_summary:
            for rs in repo_summary[:6]:
                worksheet_lines.append(
                    f"- 证据项目 `{rs['repoId']}` (`{rs.get('fullName')}` | {rs.get('primaryLanguage') or '-'} | topics={','.join(rs.get('topics') or [])})"
                )
        else:
            worksheet_lines.append("- （该用户无可用公开证据仓库）")
        worksheet_lines.append("")

        for idx, m_name in enumerate(shuffled):
            blind_id = f"method_{chr(ord('A') + idx)}"
            pred = predictions_by_method[m_name][sid]
            mapping[blind_id] = m_name
            ev_repos = pred.get("evidenceRepos") or pred.get("usedRepoIds") or []
            anon_entries.append({
                "blindLabel": blind_id,
                "status": pred.get("status", "ready"),
                "languages": pred.get("languages") or {},
                "topics": pred.get("topics") or {},
                "topInterests": pred.get("topInterests") or [],
                "evidenceRepos": ev_repos,
            })
            audit_template_rows.append({
                "subjectId": sid,
                "blindLabel": blind_id,
                "category": "",
                "note": "",
            })
            top_tags = [
                (it.get("tag") if isinstance(it, dict) else str(it))
                for it in (pred.get("topInterests") or [])[:8]
            ]
            worksheet_lines.append(
                f"- **{blind_id}**：`status={pred.get('status', 'ready')}` | "
                f"`topInterests={top_tags}` | `evidenceRepos={ev_repos[:6]}` | 判定：`[ ] grounded / [ ] over_inferred / [ ] nonexistent_citation / [ ] insufficient_evidence`"
            )
        worksheet_lines.append("")

        unblind_key[sid] = mapping
        samples.append({
            "subjectId": sid,
            "evidenceHash": row.get("evidenceHash"),
            "repositorySummary": repo_summary,
            "blindCandidates": anon_entries,
        })

    sample_path = output_dir / "blind-review-sample.jsonl"
    key_path = output_dir / "blind-review-key.json"
    worksheet_path = output_dir / "blind-review-worksheet.md"
    template_path = output_dir / "blind-review-audit-template.jsonl"

    write_jsonl(sample_path, samples)
    write_jsonl(template_path, audit_template_rows)
    worksheet_path.write_text("\n".join(worksheet_lines) + "\n", encoding="utf-8")
    key_path.write_text(json.dumps({
        "seed": seed,
        "sampleCount": len(samples),
        "methodsCompared": method_names,
        "categories": list(BLIND_AUDIT_CATEGORIES),
        "mappingBySubject": unblind_key,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "sampleCount": len(samples),
        "sampleFile": "blind-review-sample.jsonl",
        "keyFile": "blind-review-key.json",
        "worksheetFile": "blind-review-worksheet.md",
        "auditTemplateFile": "blind-review-audit-template.jsonl",
    }


def render_markdown_report(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# HappyGit 画像评测报告 (Experiment Report)")
    lines.append("")
    meta = report["metadata"]
    lines.append(f"- **运行时间**：`{meta['executedAt']}`")
    lines.append(f"- **代码提交**：`{meta.get('gitCommit') or 'unknown'}`")
    lines.append(
        f"- **数据集版本**：`{meta.get('datasetVersion')}` "
        f"(`catalogMode={meta.get('catalogMode') or '-'}`, `behaviorSource={meta.get('behaviorSourceMode') or '-'}`, "
        f"`split={meta.get('split')}`, 样本数 `{meta.get('subjectCount')}`)"
    )
    lines.append(f"- **输入证据 SHA-256**：`{meta.get('evidenceFileSha256')}`")
    lines.append(f"- **大模型提示包 SHA-256**：`{meta.get('promptsFileSha256')}`")
    lines.append(f"- **词表别名版本**：`{meta.get('aliasesTaxonomyVersion')}`")
    if meta.get("repeatSubset"):
        rs = meta["repeatSubset"]
        lines.append(f"- **固定重复抽样子集**：`{rs.get('subsetSize')}` 位用户（seed=`{rs.get('seed')}`，清单 `{rs.get('file')}`）")
    if meta.get("serverExport"):
        se = meta["serverExport"]
        lines.append(
            f"- **服务端固定导出包**：`modelVersion={se.get('modelVersion')}` / "
            f"`featureSpaceVersion={se.get('featureSpaceVersion')}` / `protocolDigest={se.get('protocolDigest')}`"
        )
    lines.append("")
    lines.append("> 注：通用大模型（`llm_reference`）属于独立对照方法，**不直接当作真值**；空分布样本与非空分布样本分开统计，不强行补齐为均匀向量。")
    lines.append("")
    lines.append("## 1. 各方法整体对比")
    lines.append("")
    lines.append("| 方法 | 模型标识 | 样本数 (成功/失败) | Top-8 P | Top-8 R | Top-8 F1 | Top-8 Jaccard | nDCG@8 | 语言余弦(非空) | 主题余弦(非空) | 证据有效率 | 幻觉引用 | 空画像准确率 | 耗时(ms) |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")

    def _fmt_opt(v: Any) -> str:
        return f"{v:.4f}" if isinstance(v, (int, float)) else "-"

    for name, block in report["methods"].items():
        if block.get("status") != "completed":
            lines.append(f"| {name} | {block.get('modelVersion') or '-'} | 0 (0/0) | - | - | - | - | - | - | - | - | - | - | ({block.get('status')}) |")
            continue
        ov = block["metrics"]["overall"]
        lines.append(
            f"| {name} | `{block.get('modelVersion')}` | {ov['count']} ({ov.get('succeededCount', ov['count'])}/{ov.get('failedCount', 0)}) | "
            f"{_fmt_opt(ov.get('precisionAt8'))} | {_fmt_opt(ov.get('recallAt8'))} | {_fmt_opt(ov.get('f1At8'))} | "
            f"{_fmt_opt(ov.get('jaccard'))} | {_fmt_opt(ov.get('ndcgAt8'))} | "
            f"{_fmt_opt(ov.get('langCosine'))} | {_fmt_opt(ov.get('topicCosine'))} | {_fmt_opt(ov.get('evidenceValidRate'))} | "
            f"{ov.get('hallucinatedEvidenceTotal', 0)} | {_fmt_opt(ov.get('emptyHandlingAccuracy'))} | {block.get('durationMs', 0)} |"
        )
    lines.append("")

    if report.get("charts"):
        lines.append("## 2. 可视化对比图表")
        lines.append("")
        for chart in report["charts"]:
            lines.append(f"### {chart['title']}")
            lines.append("")
            lines.append(f"![{chart['title']}]({chart['path']})")
            lines.append("")

    if report.get("pairwiseAgreement"):
        lines.append("## 3. 方法间一致性对比 (两两对照)")
        lines.append("")
        lines.append("| 对照组合 | 共同样本数 | Top-8 标签 Jaccard | 语言分布余弦 | 主题分布余弦 |")
        lines.append("| --- | ---: | ---: | ---: | ---: |")
        for pair_name, agr in report["pairwiseAgreement"].items():
            lines.append(
                f"| `{pair_name}` | {agr.get('commonSubjects', 0)} | "
                f"{_fmt_opt(agr.get('top8TagJaccard'))} | {_fmt_opt(agr.get('languageCosineAgreement'))} | {_fmt_opt(agr.get('topicCosineAgreement'))} |"
            )
        lines.append("")

    if report.get("methodDeltas"):
        lines.append("## 4. 改进、退化与不确定样本分析")
        lines.append("")
        lines.append("| 对比方向 (候选 vs 基线) | 共同有效样本 | 改进数 (+ΔF1>0.01) | 退化数 (-ΔF1<-0.01) | 持平/不确定 | 平均 ΔF1 | 平均 ΔJaccard | 平均 Δ主题余弦 |")
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for comp_name, delta in report["methodDeltas"].items():
            lines.append(
                f"| `{comp_name}` | {delta.get('commonSubjects', 0)} | {delta.get('improvedCount', 0)} | "
                f"{delta.get('regressedCount', 0)} | {delta.get('uncertainOrTiedCount', 0)} | "
                f"{_fmt_opt(delta.get('meanF1Delta'))} | {_fmt_opt(delta.get('meanJaccardDelta'))} | {_fmt_opt(delta.get('meanTopicCosineDelta'))} |"
            )
        lines.append("")

    llm_block = (report.get("methods") or {}).get("llm_reference") or {}
    if isinstance(llm_block.get("stability"), dict):
        st = llm_block["stability"]
        sm = st.get("summary") or {}
        lines.append("## 5. 通用大模型固定子集重复调用波动分析")
        lines.append("")
        lines.append(
            f"- 固定子集规模：`{st.get('subsetSize')}`，每样本独立调用总次数：`{st.get('totalCallsPerSubsetSubject')}`，"
            f"各轮失败数：`{st.get('failuresPerRun')}`，状态完全一致率：`{_fmt_opt(st.get('statusExactConsistencyRate'))}`"
        )
        lines.append("")
        lines.append("| 稳定性指标 | 均值 (mean) | 标准差 (std) | 最小值 (min) | 最大值 (max) |")
        lines.append("| --- | ---: | ---: | ---: | ---: |")
        for label, key in [
            ("Top-8 Jaccard", "top8TagJaccard"),
            ("语言分布余弦", "languageCosineAgreement"),
            ("主题分布余弦", "topicCosineAgreement"),
        ]:
            row = sm.get(key) or {}
            lines.append(
                f"| {label} | {_fmt_opt(row.get('mean'))} | {_fmt_opt(row.get('std'))} | "
                f"{_fmt_opt(row.get('min'))} | {_fmt_opt(row.get('max'))} |"
            )
        lines.append("")

    if report.get("blindAuditSummary"):
        ba = report["blindAuditSummary"]
        lines.append("## 6. 匿名盲评证据核查汇总")
        lines.append("")
        lines.append(f"- 已核查条目数：`{ba.get('annotatedEntries', 0)}`（未匹配：`{ba.get('unmatchedEntries', 0)}`，非法分类：`{ba.get('invalidCategoryEntries', 0)}`）")
        lines.append("")
        lines.append("| 方法 | 核查总数 | 有依据 (`grounded`) | 推断过强 (`over_inferred`) | 引用不存在 (`nonexistent_citation`) | 证据不足 (`insufficient_evidence`) |")
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
        for m_name, m_stat in (ba.get("byMethod") or {}).items():
            cnts = m_stat.get("counts") or {}
            lines.append(
                f"| `{m_name}` | {m_stat.get('total', 0)} | {cnts.get('grounded', 0)} | "
                f"{cnts.get('over_inferred', 0)} | {cnts.get('nonexistent_citation', 0)} | {cnts.get('insufficient_evidence', 0)} |"
            )
        lines.append("")

    completed_methods = [(name, block) for name, block in report["methods"].items() if block.get("status") == "completed"]
    if completed_methods:
        lines.append("## 7. 各方法分场景、来源与稀疏度统计")
        lines.append("")
        for idx, (name, block) in enumerate(completed_methods, start=1):
            lines.append(f"### 7.{idx} `{name}`")
            lines.append("")
            for section_title, key_name in [
                ("按行为场景 (`byScenario`)", "byScenario"),
                ("按数据源类别 (`bySourceKind`)", "bySourceKind"),
                ("按稀疏程度 (`bySparsity`)", "bySparsity"),
            ]:
                lines.append(f"#### {section_title}")
                lines.append("")
                lines.append("| 分组 | 样本数 | 失败数 | F1@8 | 主题余弦(非空) | 证据有效率 | 空画像准确率 |")
                lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
                for grp, sv in block["metrics"][key_name].items():
                    lines.append(
                        f"| `{grp}` | {sv['count']} | {sv.get('failedCount', 0)} | {_fmt_opt(sv.get('f1At8'))} | "
                        f"{_fmt_opt(sv.get('topicCosine'))} | {_fmt_opt(sv.get('evidenceValidRate'))} | "
                        f"{_fmt_opt(sv.get('emptyHandlingAccuracy'))} |"
                    )
                lines.append("")

    return "\n".join(lines)


def _evaluate_prediction_map(
    pred_map: Dict[str, Dict[str, Any]],
    evidence_by_id: Dict[str, Dict[str, Any]],
    truth_by_id: Dict[str, Dict[str, Any]],
    control_by_id: Dict[str, Dict[str, Any]],
    subject_by_id: Dict[str, Dict[str, Any]],
    aliases: Dict[str, Any],
    error_by_id: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    err_lookup = error_by_id or {}
    for sid in sorted(evidence_by_id):
        if sid in pred_map:
            rows.append(
                evaluate_subject_prediction(
                    pred_map[sid],
                    evidence_by_id[sid],
                    truth_row=truth_by_id.get(sid),
                    control_case=control_by_id.get(sid),
                    aliases=aliases,
                    subject_row=subject_by_id.get(sid),
                )
            )
        else:
            rows.append(
                make_failed_subject_evaluation(
                    evidence_by_id[sid],
                    truth_row=truth_by_id.get(sid),
                    control_case=control_by_id.get(sid),
                    subject_row=subject_by_id.get(sid),
                    error_message=err_lookup.get(sid, "missing_prediction"),
                )
            )
    return rows


def run_experiment_pipeline(
    dataset_dir: Path,
    output_dir: Path,
    split: str = "test",
    taxonomy_path: Path = DEFAULT_TAXONOMY_PATH,
    aliases_path: Optional[Path] = None,
    baseline_predictions_path: Optional[Path] = None,
    baseline_cmd: Optional[str] = None,
    server_export_dir: Optional[Path] = None,
    learned_predictions_path: Optional[Path] = None,
    learned_cmd: Optional[str] = None,
    extra_models: Optional[List[Tuple[str, Path]]] = None,
    llm_predictions_path: Optional[Path] = None,
    run_llm_api: bool = False,
    subset_repeats: int = 3,
    repeat_subset_size: int = 20,
    repeat_seed: int = 20261103,
    llm_provider: Optional[str] = None,
    llm_temperature: float = 0.0,
    llm_timeout: int = 60,
    blind_review_count: int = 15,
    blind_audit_file: Optional[Path] = None,
    blind_key_file: Optional[Path] = None,
    llm_caller: Optional[Callable[..., Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    dataset_dir = dataset_dir.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    preds_dir = output_dir / "predictions"
    preds_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = dataset_dir / "dataset-manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"dataset-manifest.json not found in {dataset_dir}")
    dataset_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    evidence_path = dataset_dir / "evidence-views" / f"{split}.jsonl"
    if not evidence_path.exists():
        raise FileNotFoundError(f"evidence-views/{split}.jsonl not found in {dataset_dir}")
    evidence_rows = read_jsonl(evidence_path)

    with taxonomy_path.open("r", encoding="utf-8") as handle:
        taxonomy = json.load(handle)
    aliases = load_aliases(aliases_path)

    # Read evaluation-only metadata ONLY for scoring & subgroup breakdown, NEVER passed to adapters/prompts
    truth_by_id = {
        str(r["subjectId"]): r
        for r in read_jsonl(dataset_dir / "evaluation-only" / "generator-truth.jsonl")
        if r.get("subjectId")
    }
    control_by_id = {
        str(r["subjectId"]): r
        for r in read_jsonl(dataset_dir / "evaluation-only" / "control-cases.jsonl")
        if r.get("subjectId")
    }
    subject_by_id = {
        str(r["subjectId"]): r
        for r in read_jsonl(dataset_dir / "canonical" / "subjects.jsonl")
        if r.get("subjectId")
    }

    # Verify evidenceHash integrity and build clean LLM prompt package
    prompts: List[Dict[str, Any]] = []
    evidence_by_id: Dict[str, Dict[str, Any]] = {}
    for row in evidence_rows:
        sid = str(row["subjectId"])
        evidence_by_id[sid] = row
        prompts.append(build_llm_prompt_for_subject(row, taxonomy))

    prompts_path = output_dir / "llm-prompts.jsonl"
    write_jsonl(prompts_path, prompts)

    # Deterministically freeze the repeat-stability subset BEFORE any model call
    repeat_subset_prompts = select_stratified_repeat_subset(
        prompts,
        truth_by_id=truth_by_id,
        control_by_id=control_by_id,
        subset_size=repeat_subset_size,
        seed=repeat_seed,
    )
    repeat_subset_ids = [str(p["subjectId"]) for p in repeat_subset_prompts]
    repeat_subset_path = output_dir / "repeat-subset-ids.json"
    repeat_subset_path.write_text(
        json.dumps(
            {
                "seed": repeat_seed,
                "requestedSubsetSize": repeat_subset_size,
                "actualSubsetSize": len(repeat_subset_ids),
                "totalCallsPlannedPerSubject": max(1, subset_repeats),
                "subjectIds": repeat_subset_ids,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    methods_report: Dict[str, Any] = {}
    predictions_by_method: Dict[str, Dict[str, Dict[str, Any]]] = {}
    evals_by_method: Dict[str, List[Dict[str, Any]]] = {}

    # 1. Local rule-weighted content baseline
    base_out_path = preds_dir / "baseline_local_v1.jsonl"
    base_ms = 0
    if baseline_cmd:
        ok, base_ms, base_err = run_prediction_command(
            baseline_cmd, dataset_dir, split, base_out_path, evidence_path
        )
        if not ok:
            raise RuntimeError(f"baseline_cmd failed: {base_err}")
        baseline_predictions_path = base_out_path

    t0 = time.perf_counter()
    if baseline_predictions_path:
        base_map = load_predictions_map(baseline_predictions_path)
    else:
        base_map = {
            sid: run_rule_baseline_for_subject(row, aliases)
            for sid, row in evidence_by_id.items()
        }
    base_ms = base_ms or int((time.perf_counter() - t0) * 1000)
    write_jsonl(base_out_path, [base_map[sid] for sid in sorted(base_map)])
    base_eval = _evaluate_prediction_map(base_map, evidence_by_id, truth_by_id, control_by_id, subject_by_id, aliases)
    base_ver = next((p.get("modelVersion") for p in base_map.values() if p.get("modelVersion")), "baseline-local-v1")
    predictions_by_method["baseline_local_v1"] = base_map
    evals_by_method["baseline_local_v1"] = base_eval
    methods_report["baseline_local_v1"] = {
        "status": "completed",
        "modelVersion": base_ver,
        "durationMs": base_ms,
        "predictionsFile": "predictions/baseline_local_v1.jsonl",
        "metrics": aggregate_metrics(base_eval),
        "perSubject": base_eval,
    }

    # Optional Member A learning-export bundle (baseline_mr_fixed_v1 + learned_model)
    server_export_meta: Optional[Dict[str, Any]] = None
    if server_export_dir:
        bundle = load_server_export_bundle(server_export_dir)
        sm = bundle["manifest"]
        server_export_meta = {
            "exportDir": bundle["exportDir"],
            "protocolDigest": sm.get("protocolDigest"),
            "datasetVersion": sm.get("datasetVersion"),
            "catalogSnapshotId": sm.get("catalogSnapshotId"),
            "featureSpaceVersion": sm.get("featureSpaceVersion"),
            "modelVersion": sm.get("modelVersion"),
            "framework": sm.get("framework"),
            "userBlocks": sm.get("userBlocks"),
            "elapsedMs": sm.get("elapsedMs"),
        }
        if bundle["baselinePath"] is not None:
            t_mr = time.perf_counter()
            mr_base_map = load_predictions_map(bundle["baselinePath"])
            mr_base_out = preds_dir / "baseline_mr_fixed_v1.jsonl"
            write_jsonl(mr_base_out, [mr_base_map[sid] for sid in sorted(mr_base_map)])
            mr_base_eval = _evaluate_prediction_map(mr_base_map, evidence_by_id, truth_by_id, control_by_id, subject_by_id, aliases)
            mr_ver = next((p.get("modelVersion") for p in mr_base_map.values() if p.get("modelVersion")), "rules-mr-30d-3-1.5-v1")
            predictions_by_method["baseline_mr_fixed_v1"] = mr_base_map
            evals_by_method["baseline_mr_fixed_v1"] = mr_base_eval
            methods_report["baseline_mr_fixed_v1"] = {
                "status": "completed",
                "modelVersion": mr_ver,
                "durationMs": int((time.perf_counter() - t_mr) * 1000),
                "predictionsFile": "predictions/baseline_mr_fixed_v1.jsonl",
                "metrics": aggregate_metrics(mr_base_eval),
                "perSubject": mr_base_eval,
            }
        if bundle["learnedPath"] is not None and not learned_predictions_path and not learned_cmd:
            learned_predictions_path = bundle["learnedPath"]

    # 2. Learned model adapter
    learned_out_path = preds_dir / "learned_model.jsonl"
    learned_error = None
    learned_duration = 0
    if learned_cmd:
        ok, learned_duration, learned_error = run_prediction_command(
            learned_cmd, dataset_dir, split, learned_out_path, evidence_path
        )
        if ok:
            learned_predictions_path = learned_out_path

    if learned_predictions_path and learned_predictions_path.exists():
        t1 = time.perf_counter()
        learned_map = load_predictions_map(learned_predictions_path)
        if learned_predictions_path != learned_out_path:
            write_jsonl(learned_out_path, [learned_map[sid] for sid in sorted(learned_map)])
        learned_duration = learned_duration or int((time.perf_counter() - t1) * 1000)
        learned_eval = _evaluate_prediction_map(learned_map, evidence_by_id, truth_by_id, control_by_id, subject_by_id, aliases)
        sample_ver = next((p.get("modelVersion") for p in learned_map.values() if p.get("modelVersion")), "learned-model")
        predictions_by_method["learned_model"] = learned_map
        evals_by_method["learned_model"] = learned_eval
        methods_report["learned_model"] = {
            "status": "completed",
            "modelVersion": sample_ver,
            "durationMs": learned_duration,
            "predictionsFile": "predictions/learned_model.jsonl",
            "metrics": aggregate_metrics(learned_eval),
            "perSubject": learned_eval,
        }
    else:
        methods_report["learned_model"] = {
            "status": "error" if learned_error else "pending_server_export",
            "modelVersion": None,
            "error": learned_error or "等待成员甲集群 learning-export 导出 learned.jsonl（--server-export-dir 或 --learned-predictions）",
            "durationMs": learned_duration,
        }

    # Optional extra model files (e.g., feedback-retrained model version on the same frozen test benchmark)
    for extra_name, extra_path in (extra_models or []):
        clean_name = "".join(ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in str(extra_name).strip())
        if not clean_name or not extra_path.exists():
            continue
        t_ex = time.perf_counter()
        ex_map = load_predictions_map(extra_path)
        ex_out = preds_dir / f"{clean_name}.jsonl"
        write_jsonl(ex_out, [ex_map[sid] for sid in sorted(ex_map)])
        ex_eval = _evaluate_prediction_map(ex_map, evidence_by_id, truth_by_id, control_by_id, subject_by_id, aliases)
        ex_ver = next((p.get("modelVersion") for p in ex_map.values() if p.get("modelVersion")), clean_name)
        predictions_by_method[clean_name] = ex_map
        evals_by_method[clean_name] = ex_eval
        methods_report[clean_name] = {
            "status": "completed",
            "modelVersion": ex_ver,
            "durationMs": int((time.perf_counter() - t_ex) * 1000),
            "predictionsFile": f"predictions/{clean_name}.jsonl",
            "metrics": aggregate_metrics(ex_eval),
            "perSubject": ex_eval,
        }

    # 3. Independent LLM reference adapter
    llm_raw_log_path = output_dir / "llm-raw-responses.jsonl"
    llm_stability: Optional[Dict[str, Any]] = None

    if run_llm_api:
        caller = llm_caller or call_openai_compatible_llm
        api_url = os.environ.get("HAPPYGIT_LLM_API_URL", "").strip()
        api_key = os.environ.get("HAPPYGIT_LLM_API_KEY", "").strip()
        model_name = os.environ.get("HAPPYGIT_LLM_MODEL", "").strip()
        provider_name = llm_provider or os.environ.get("HAPPYGIT_LLM_PROVIDER", "").strip() or None
        if llm_caller is None and not (api_url and api_key and model_name):
            raise RuntimeError("Missing HAPPYGIT_LLM_API_URL, HAPPYGIT_LLM_API_KEY, or HAPPYGIT_LLM_MODEL env vars")
        if not model_name:
            model_name = "custom-llm-caller"

        t2 = time.perf_counter()
        llm_logs: List[Dict[str, Any]] = []
        llm_map: Dict[str, Dict[str, Any]] = {}
        llm_errors: Dict[str, str] = {}
        failures = 0
        for p_row in prompts:
            call_res = caller(
                p_row,
                api_url,
                api_key,
                model_name,
                timeout_sec=llm_timeout,
                temperature=llm_temperature,
                provider=provider_name,
            )
            llm_logs.append({**call_res, "repeatIndex": 1})
            if call_res["ok"]:
                llm_map[p_row["subjectId"]] = call_res["prediction"]
            else:
                failures += 1
                llm_errors[p_row["subjectId"]] = str(call_res.get("error") or "llm_call_failed")
        llm_ms = int((time.perf_counter() - t2) * 1000)

        # Total subset_repeats calls on fixed subset: run 1 comes from main pass + (subset_repeats - 1) extra independent runs
        if subset_repeats > 1 and repeat_subset_prompts:
            run1_subset = {sid: llm_map[sid] for sid in repeat_subset_ids if sid in llm_map}
            run1_fails = sum(1 for sid in repeat_subset_ids if sid not in llm_map)
            repeat_runs: List[Dict[str, Dict[str, Any]]] = [run1_subset]
            failures_per_run: List[int] = [run1_fails]
            for rep_idx in range(2, subset_repeats + 1):
                rep_map: Dict[str, Dict[str, Any]] = {}
                rep_fail = 0
                for p_row in repeat_subset_prompts:
                    rep_res = caller(
                        p_row,
                        api_url,
                        api_key,
                        model_name,
                        timeout_sec=llm_timeout,
                        temperature=llm_temperature,
                        provider=provider_name,
                    )
                    llm_logs.append({**rep_res, "repeatIndex": rep_idx})
                    if rep_res["ok"]:
                        rep_map[p_row["subjectId"]] = rep_res["prediction"]
                    else:
                        rep_fail += 1
                repeat_runs.append(rep_map)
                failures_per_run.append(rep_fail)
            llm_stability = summarize_repeat_stability(
                repeat_runs=repeat_runs,
                subset_ids=repeat_subset_ids,
                aliases=aliases,
                failures_per_run=failures_per_run,
            )

        write_jsonl(llm_raw_log_path, llm_logs)
        write_jsonl(preds_dir / "llm_reference.jsonl", [llm_map[sid] for sid in sorted(llm_map)])
        llm_eval = _evaluate_prediction_map(
            llm_map,
            evidence_by_id,
            truth_by_id,
            control_by_id,
            subject_by_id,
            aliases,
            error_by_id=llm_errors,
        )
        resolved_model_ver = next((r.get("modelIdentifier") for r in llm_logs if r.get("ok") and r.get("modelIdentifier")), model_name)
        resolved_provider = next((r.get("provider") for r in llm_logs if r.get("provider")), provider_name)
        predictions_by_method["llm_reference"] = llm_map
        evals_by_method["llm_reference"] = llm_eval
        methods_report["llm_reference"] = {
            "status": "completed",
            "modelVersion": resolved_model_ver,
            "provider": resolved_provider,
            "temperature": llm_temperature,
            "durationMs": llm_ms,
            "failedCalls": failures,
            "promptsFile": "llm-prompts.jsonl",
            "rawResponsesFile": "llm-raw-responses.jsonl",
            "predictionsFile": "predictions/llm_reference.jsonl",
            "stability": llm_stability,
            "metrics": aggregate_metrics(llm_eval),
            "perSubject": llm_eval,
        }
    elif llm_predictions_path and llm_predictions_path.exists():
        t2 = time.perf_counter()
        llm_map = load_predictions_map(llm_predictions_path)
        write_jsonl(preds_dir / "llm_reference.jsonl", [llm_map[sid] for sid in sorted(llm_map)])
        llm_ms = int((time.perf_counter() - t2) * 1000)
        llm_eval = _evaluate_prediction_map(llm_map, evidence_by_id, truth_by_id, control_by_id, subject_by_id, aliases)
        sample_ver = next((p.get("modelVersion") for p in llm_map.values() if p.get("modelVersion")), "llm-reference")
        predictions_by_method["llm_reference"] = llm_map
        evals_by_method["llm_reference"] = llm_eval
        methods_report["llm_reference"] = {
            "status": "completed",
            "modelVersion": sample_ver,
            "durationMs": llm_ms,
            "promptsFile": "llm-prompts.jsonl",
            "predictionsFile": "predictions/llm_reference.jsonl",
            "metrics": aggregate_metrics(llm_eval),
            "perSubject": llm_eval,
        }
    else:
        methods_report["llm_reference"] = {
            "status": "pending_api_credentials",
            "modelVersion": None,
            "promptsFile": "llm-prompts.jsonl",
            "promptCount": len(prompts),
            "repeatSubsetFile": "repeat-subset-ids.json",
            "note": "已冻结仅含共同证据与公开 taxonomy 的大模型输入包及固定重复抽样子集；未检测到外部大模型 API 凭据，故如实记录未执行状态，绝不编造响应。",
        }

    # Pairwise agreement across completed methods
    method_names = sorted(predictions_by_method.keys())
    pairwise: Dict[str, Any] = {}
    for i in range(len(method_names)):
        for j in range(i + 1, len(method_names)):
            m_a, m_b = method_names[i], method_names[j]
            pairwise[f"{m_a}__vs__{m_b}"] = compute_pairwise_agreement(
                predictions_by_method[m_a], predictions_by_method[m_b], aliases=aliases
            )

    # Improvement / Regression / Uncertain breakdown against baselines & between model versions
    method_deltas: Dict[str, Any] = {}
    for base_name in ("baseline_local_v1", "baseline_mr_fixed_v1"):
        if base_name not in evals_by_method:
            continue
        for cand_name in method_names:
            if cand_name == base_name or cand_name in ("baseline_local_v1", "baseline_mr_fixed_v1"):
                continue
            method_deltas[f"{cand_name}__vs__{base_name}"] = compute_method_comparison_deltas(
                evals_by_method[base_name], evals_by_method[cand_name]
            )
    if "learned_model" in evals_by_method:
        for extra_name, _ in (extra_models or []):
            clean_name = "".join(ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in str(extra_name).strip())
            if clean_name in evals_by_method and clean_name != "learned_model":
                method_deltas[f"{clean_name}__vs__learned_model"] = compute_method_comparison_deltas(
                    evals_by_method["learned_model"], evals_by_method[clean_name]
                )

    blind_audit_summary: Optional[Dict[str, Any]] = None
    existing_key_path = output_dir / "blind-review-key.json"
    if blind_audit_file and blind_audit_file.exists():
        resolved_key = blind_key_file if (blind_key_file and blind_key_file.exists()) else existing_key_path
        if resolved_key.exists():
            key_data = json.loads(resolved_key.read_text(encoding="utf-8"))
            audit_rows = read_jsonl(blind_audit_file)
            blind_audit_summary = summarize_blind_audit(audit_rows, key_data)

    preserve_existing_blind_bundle = bool(
        blind_audit_file
        and blind_audit_file.exists()
        and existing_key_path.exists()
        and (blind_key_file is None or blind_key_file.resolve() == existing_key_path.resolve())
    )
    if preserve_existing_blind_bundle:
        blind_review = {
            "sampleCount": len(read_jsonl(output_dir / "blind-review-sample.jsonl")),
            "sampleFile": "blind-review-sample.jsonl",
            "keyFile": "blind-review-key.json",
            "worksheetFile": "blind-review-worksheet.md",
            "auditTemplateFile": "blind-review-audit-template.jsonl",
            "preservedForAudit": True,
        }
    else:
        blind_review = export_blind_review_sample(
            output_dir,
            evidence_by_id,
            predictions_by_method,
            sample_count=blind_review_count,
        )

    report: Dict[str, Any] = {
        "schemaVersion": "1.1.0",
        "metadata": {
            "executedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "gitCommit": current_git_commit(),
            "datasetVersion": dataset_manifest.get("datasetVersion"),
            "catalogMode": dataset_manifest.get("catalogMode"),
            "behaviorSourceMode": dataset_manifest.get("behaviorSourceMode"),
            "datasetDir": str(dataset_dir),
            "split": split,
            "subjectCount": len(evidence_by_id),
            "evidenceFileSha256": file_sha256(evidence_path),
            "promptsFileSha256": file_sha256(prompts_path),
            "aliasesTaxonomyVersion": aliases.get("taxonomyVersion"),
            "referenceTime": dataset_manifest.get("referenceTime"),
            "repeatSubset": {
                "seed": repeat_seed,
                "subsetSize": len(repeat_subset_ids),
                "totalCallsPlannedPerSubject": max(1, subset_repeats),
                "file": "repeat-subset-ids.json",
            },
            "serverExport": server_export_meta,
            "blindReview": blind_review,
        },
        "methods": methods_report,
        "pairwiseAgreement": pairwise,
        "methodDeltas": method_deltas,
        "blindAuditSummary": blind_audit_summary,
        "charts": [],
    }

    report["charts"] = render_experiment_charts(report, output_dir / "charts")

    (output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "run-manifest.json").write_text(json.dumps(report["metadata"], ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "report.md").write_text(render_markdown_report(report), encoding="utf-8")
    return report


def _parse_extra_models(items: Optional[List[str]]) -> List[Tuple[str, Path]]:
    parsed: List[Tuple[str, Path]] = []
    for raw in items or []:
        if "=" not in raw:
            raise ValueError(f"Invalid --extra-model '{raw}', expected format name=path/to/preds.jsonl")
        name, p_str = raw.split("=", 1)
        parsed.append((name.strip(), Path(p_str.strip())))
    return parsed


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="HappyGit file-based portrait experiment runner")
    parser.add_argument("--dataset-dir", required=True, type=Path, help="Dataset directory containing dataset-manifest.json & evidence-views/")
    parser.add_argument("--output-dir", required=True, type=Path, help="Output directory for run manifest, prompts, predictions, charts, and report")
    parser.add_argument("--split", default="test", choices=["validation", "test"], help="Evaluation split (default: test)")
    parser.add_argument("--taxonomy", default=DEFAULT_TAXONOMY_PATH, type=Path, help="Path to public taxonomy.json")
    parser.add_argument("--aliases", default=None, type=Path, help="Path to frozen taxonomy_aliases.json")
    parser.add_argument("--baseline-predictions", default=None, type=Path, help="Optional JSONL of external local baseline predictions")
    parser.add_argument("--baseline-cmd", default=None, type=str, help="Optional CLI command template to invoke baseline inference")
    parser.add_argument("--server-export-dir", default=None, type=Path, help="Member A learning-export directory (run-manifest.json + baseline.jsonl + learned.jsonl)")
    parser.add_argument("--learned-predictions", default=None, type=Path, help="Optional JSONL of A's learned model predictions")
    parser.add_argument("--learned-cmd", default=None, type=str, help="Optional CLI command template to invoke A's learned inference")
    parser.add_argument("--extra-model", action="append", default=None, help="Additional model JSONL as label=path (e.g., learned_retrained_v2=path/to/learned.jsonl)")
    parser.add_argument("--llm-predictions", default=None, type=Path, help="Optional JSONL of LLM reference predictions")
    parser.add_argument("--run-llm-api", action="store_true", help="Actually call external LLM API using env vars (Round 3)")
    parser.add_argument("--subset-repeats", type=int, default=3, help="Total independent calls per fixed subset user when --run-llm-api is set (default: 3)")
    parser.add_argument("--repeat-subset-size", type=int, default=20, help="Fixed stratified subset size for repeat variance evaluation (default: 20)")
    parser.add_argument("--repeat-seed", type=int, default=20261103, help="Deterministic seed for repeat subset selection")
    parser.add_argument("--llm-provider", default=None, type=str, help="Explicit LLM provider label saved to raw logs")
    parser.add_argument("--llm-temperature", type=float, default=0.0, help="LLM sampling temperature (default: 0.0)")
    parser.add_argument("--llm-timeout", type=int, default=60, help="Per-call LLM HTTP timeout seconds")
    parser.add_argument("--blind-review-count", type=int, default=15, help="Export anonymized blind spot-check sample count (0 to disable)")
    parser.add_argument("--blind-audit-file", default=None, type=Path, help="Completed blind-review-audit JSONL to unblind and summarize into report")
    parser.add_argument("--blind-key-file", default=None, type=Path, help="Matching blind-review-key.json for --blind-audit-file")

    args = parser.parse_args(argv)
    report = run_experiment_pipeline(
        dataset_dir=args.dataset_dir,
        output_dir=args.output_dir,
        split=args.split,
        taxonomy_path=args.taxonomy,
        aliases_path=args.aliases,
        baseline_predictions_path=args.baseline_predictions,
        baseline_cmd=args.baseline_cmd,
        server_export_dir=args.server_export_dir,
        learned_predictions_path=args.learned_predictions,
        learned_cmd=args.learned_cmd,
        extra_models=_parse_extra_models(args.extra_model),
        llm_predictions_path=args.llm_predictions,
        run_llm_api=args.run_llm_api,
        subset_repeats=args.subset_repeats,
        repeat_subset_size=args.repeat_subset_size,
        repeat_seed=args.repeat_seed,
        llm_provider=args.llm_provider,
        llm_temperature=args.llm_temperature,
        llm_timeout=args.llm_timeout,
        blind_review_count=args.blind_review_count,
        blind_audit_file=args.blind_audit_file,
        blind_key_file=args.blind_key_file,
    )
    print(json.dumps({
        "datasetVersion": report["metadata"]["datasetVersion"],
        "split": report["metadata"]["split"],
        "subjectCount": report["metadata"]["subjectCount"],
        "charts": report.get("charts", []),
        "methods": {k: {"status": v.get("status"), "overall": (v.get("metrics") or {}).get("overall")} for k, v in report["methods"].items()},
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
