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
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

EXPERIMENTS_DIR = Path(__file__).resolve().parent
if str(EXPERIMENTS_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_DIR))

from metrics import (  # noqa: E402
    aggregate_metrics,
    compute_pairwise_agreement,
    evaluate_subject_prediction,
    load_aliases,
    normalize_distribution,
    normalize_language,
    normalize_topic,
)
from prompt_builder import build_llm_prompt_for_subject, compute_sha256_canonical  # noqa: E402


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
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=str(REPO_ROOT),
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out or None
    except Exception:
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
) -> Dict[str, Any]:
    endpoint = api_url.rstrip("/")
    if not endpoint.endswith("/chat/completions"):
        endpoint = f"{endpoint}/chat/completions"

    body = json.dumps({
        "model": model_name,
        "temperature": 0.0,
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
            "modelIdentifier": resp_json.get("model") or model_name,
            "promptVersion": prompt_row["promptVersion"],
            "promptDigest": prompt_row["promptDigest"],
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
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, KeyError, IndexError, TimeoutError) as err:
        return {
            "ok": False,
            "subjectId": prompt_row["subjectId"],
            "modelIdentifier": model_name,
            "promptVersion": prompt_row["promptVersion"],
            "promptDigest": prompt_row["promptDigest"],
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


def render_markdown_report(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# HappyGit 画像评测报告 (Experiment Report)")
    lines.append("")
    meta = report["metadata"]
    lines.append(f"- **运行时间**：`{meta['executedAt']}`")
    lines.append(f"- **代码提交**：`{meta.get('gitCommit') or 'unknown'}`")
    lines.append(f"- **数据集版本**：`{meta.get('datasetVersion')}` (`split={meta.get('split')}`, 样本数 `{meta.get('subjectCount')}`)")
    lines.append(f"- **词表别名版本**：`{meta.get('aliasesTaxonomyVersion')}`")
    lines.append("")
    lines.append("## 1. 各方法整体对比")
    lines.append("")
    lines.append("| 方法 | 模型标识 | 样本数 | Top-8 P | Top-8 R | Top-8 F1 | nDCG@8 | 语言余弦 | 主题余弦 | 证据有效率 | 幻觉引用数 | 空画像准确率 | 耗时(ms) |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")

    def _fmt_opt(v: Any) -> str:
        return f"{v:.4f}" if isinstance(v, (int, float)) else "-"

    for name, block in report["methods"].items():
        if block.get("status") != "completed":
            lines.append(f"| {name} | {block.get('modelVersion') or '-'} | 0 | - | - | - | - | - | - | - | - | - | ({block.get('status')}) |")
            continue
        ov = block["metrics"]["overall"]
        lines.append(
            f"| {name} | `{block.get('modelVersion')}` | {ov['count']} | "
            f"{_fmt_opt(ov['precisionAt8'])} | {_fmt_opt(ov['recallAt8'])} | {_fmt_opt(ov['f1At8'])} | {_fmt_opt(ov['ndcgAt8'])} | "
            f"{_fmt_opt(ov['langCosine'])} | {_fmt_opt(ov['topicCosine'])} | {_fmt_opt(ov['evidenceValidRate'])} | "
            f"{ov['hallucinatedEvidenceTotal']} | {_fmt_opt(ov['emptyHandlingAccuracy'])} | {block.get('durationMs', 0)} |"
        )
    lines.append("")

    if report.get("pairwiseAgreement"):
        lines.append("## 2. 方法间一致性对比 (两两对照)")
        lines.append("")
        lines.append("| 对照组合 | 共同样本数 | Top-8 标签 Jaccard | 语言分布余弦 | 主题分布余弦 |")
        lines.append("| --- | ---: | ---: | ---: | ---: |")
        for pair_name, agr in report["pairwiseAgreement"].items():
            lines.append(
                f"| `{pair_name}` | {agr.get('commonSubjects', 0)} | "
                f"{_fmt_opt(agr.get('top8TagJaccard'))} | {_fmt_opt(agr.get('languageCosineAgreement'))} | {_fmt_opt(agr.get('topicCosineAgreement'))} |"
            )
        lines.append("")

    for name, block in report["methods"].items():
        if block.get("status") != "completed":
            continue
        lines.append(f"## 3. `{name}` 分场景、来源与稀疏度统计")
        lines.append("")
        for section_title, key_name in [
            ("按行为场景 (`byScenario`)", "byScenario"),
            ("按数据源类别 (`bySourceKind`)", "bySourceKind"),
            ("按稀疏程度 (`bySparsity`)", "bySparsity"),
        ]:
            lines.append(f"### {section_title}")
            lines.append("")
            lines.append("| 分组 | 样本数 | F1@8 | 主题余弦 | 证据有效率 | 空画像准确率 |")
            lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
            for grp, sv in block["metrics"][key_name].items():
                lines.append(
                    f"| `{grp}` | {sv['count']} | {_fmt_opt(sv.get('f1At8'))} | "
                    f"{_fmt_opt(sv.get('topicCosine'))} | {_fmt_opt(sv.get('evidenceValidRate'))} | "
                    f"{_fmt_opt(sv.get('emptyHandlingAccuracy'))} |"
                )
            lines.append("")

    return "\n".join(lines)


def run_experiment_pipeline(
    dataset_dir: Path,
    output_dir: Path,
    split: str = "test",
    taxonomy_path: Path = DEFAULT_TAXONOMY_PATH,
    aliases_path: Optional[Path] = None,
    baseline_predictions_path: Optional[Path] = None,
    learned_predictions_path: Optional[Path] = None,
    learned_cmd: Optional[str] = None,
    llm_predictions_path: Optional[Path] = None,
    run_llm_api: bool = False,
    subset_repeats: int = 0,
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

    methods_report: Dict[str, Any] = {}
    predictions_by_method: Dict[str, Dict[str, Dict[str, Any]]] = {}

    # 1. Baseline method
    t0 = time.perf_counter()
    if baseline_predictions_path:
        base_map = load_predictions_map(baseline_predictions_path)
    else:
        base_map = {
            sid: run_rule_baseline_for_subject(row, aliases)
            for sid, row in evidence_by_id.items()
        }
    base_ms = int((time.perf_counter() - t0) * 1000)
    write_jsonl(preds_dir / "baseline_local_v1.jsonl", [base_map[sid] for sid in sorted(base_map)])
    base_eval = [
        evaluate_subject_prediction(
            base_map[sid],
            evidence_by_id[sid],
            truth_row=truth_by_id.get(sid),
            control_case=control_by_id.get(sid),
            aliases=aliases,
            subject_row=subject_by_id.get(sid),
        )
        for sid in sorted(evidence_by_id)
        if sid in base_map
    ]
    predictions_by_method["baseline_local_v1"] = base_map
    methods_report["baseline_local_v1"] = {
        "status": "completed",
        "modelVersion": "baseline-local-v1",
        "durationMs": base_ms,
        "predictionsFile": "predictions/baseline_local_v1.jsonl",
        "metrics": aggregate_metrics(base_eval),
        "perSubject": base_eval,
    }

    # 2. Learned model adapter
    learned_out_path = preds_dir / "learned_model.jsonl"
    learned_error = None
    learned_duration = 0
    if learned_cmd:
        t1 = time.perf_counter()
        formatted_cmd = learned_cmd.format(
            dataset_dir=str(dataset_dir),
            split=split,
            output=str(learned_out_path),
            evidence_file=str(evidence_path),
        )
        proc = subprocess.run(
            shlex.split(formatted_cmd),
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        learned_duration = int((time.perf_counter() - t1) * 1000)
        if proc.returncode != 0:
            learned_error = f"learned_cmd failed ({proc.returncode}): {proc.stderr.strip()}"
        else:
            learned_predictions_path = learned_out_path

    if learned_predictions_path and learned_predictions_path.exists():
        t1 = time.perf_counter()
        learned_map = load_predictions_map(learned_predictions_path)
        if learned_predictions_path != learned_out_path:
            write_jsonl(learned_out_path, [learned_map[sid] for sid in sorted(learned_map)])
        learned_duration = learned_duration or int((time.perf_counter() - t1) * 1000)
        learned_eval = [
            evaluate_subject_prediction(
                learned_map[sid],
                evidence_by_id[sid],
                truth_row=truth_by_id.get(sid),
                control_case=control_by_id.get(sid),
                aliases=aliases,
                subject_row=subject_by_id.get(sid),
            )
            for sid in sorted(evidence_by_id)
            if sid in learned_map
        ]
        sample_ver = next((p.get("modelVersion") for p in learned_map.values() if p.get("modelVersion")), "learned-model")
        predictions_by_method["learned_model"] = learned_map
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
            "status": "error" if learned_error else "pending_model_artifact",
            "modelVersion": None,
            "error": learned_error or "等待成员甲第二轮训练并导出 learned_model 预测文件或 CLI 入口",
            "durationMs": learned_duration,
        }

    # 3. Independent LLM reference adapter
    llm_raw_log_path = output_dir / "llm-raw-responses.jsonl"
    llm_stability: Optional[Dict[str, Any]] = None

    if run_llm_api:
        api_url = os.environ.get("HAPPYGIT_LLM_API_URL", "").strip()
        api_key = os.environ.get("HAPPYGIT_LLM_API_KEY", "").strip()
        model_name = os.environ.get("HAPPYGIT_LLM_MODEL", "").strip()
        if not (api_url and api_key and model_name):
            raise RuntimeError("Missing HAPPYGIT_LLM_API_URL, HAPPYGIT_LLM_API_KEY, or HAPPYGIT_LLM_MODEL env vars")

        t2 = time.perf_counter()
        llm_logs: List[Dict[str, Any]] = []
        llm_map: Dict[str, Dict[str, Any]] = {}
        failures = 0
        for p_row in prompts:
            call_res = call_openai_compatible_llm(p_row, api_url, api_key, model_name)
            llm_logs.append(call_res)
            if call_res["ok"]:
                llm_map[p_row["subjectId"]] = call_res["prediction"]
            else:
                failures += 1
        llm_ms = int((time.perf_counter() - t2) * 1000)

        if subset_repeats > 1 and prompts:
            subset = prompts[: min(5, len(prompts))]
            repeat_runs: List[Dict[str, Dict[str, Any]]] = []
            for rep_idx in range(subset_repeats):
                rep_map: Dict[str, Dict[str, Any]] = {}
                for p_row in subset:
                    rep_res = call_openai_compatible_llm(p_row, api_url, api_key, model_name)
                    llm_logs.append({**rep_res, "repeatIndex": rep_idx + 1})
                    if rep_res["ok"]:
                        rep_map[p_row["subjectId"]] = rep_res["prediction"]
                repeat_runs.append(rep_map)
            pair_scores = []
            for idx_a in range(len(repeat_runs)):
                for idx_b in range(idx_a + 1, len(repeat_runs)):
                    pair_scores.append(compute_pairwise_agreement(repeat_runs[idx_a], repeat_runs[idx_b], aliases=aliases))
            llm_stability = {
                "subsetSize": len(subset),
                "repeats": subset_repeats,
                "pairwiseStability": pair_scores,
            }

        write_jsonl(llm_raw_log_path, llm_logs)
        write_jsonl(preds_dir / "llm_reference.jsonl", [llm_map[sid] for sid in sorted(llm_map)])
        llm_eval = [
            evaluate_subject_prediction(
                llm_map[sid],
                evidence_by_id[sid],
                truth_row=truth_by_id.get(sid),
                control_case=control_by_id.get(sid),
                aliases=aliases,
                subject_row=subject_by_id.get(sid),
            )
            for sid in sorted(evidence_by_id)
            if sid in llm_map
        ]
        predictions_by_method["llm_reference"] = llm_map
        methods_report["llm_reference"] = {
            "status": "completed",
            "modelVersion": model_name,
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
        llm_eval = [
            evaluate_subject_prediction(
                llm_map[sid],
                evidence_by_id[sid],
                truth_row=truth_by_id.get(sid),
                control_case=control_by_id.get(sid),
                aliases=aliases,
                subject_row=subject_by_id.get(sid),
            )
            for sid in sorted(evidence_by_id)
            if sid in llm_map
        ]
        sample_ver = next((p.get("modelVersion") for p in llm_map.values() if p.get("modelVersion")), "llm-reference")
        predictions_by_method["llm_reference"] = llm_map
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
            "status": "prompts_prepared_pending_round3_run",
            "modelVersion": None,
            "promptsFile": "llm-prompts.jsonl",
            "promptCount": len(prompts),
            "note": "已冻结仅含共同证据与公开 taxonomy 的大模型输入包，正式大模型 API 调用按协同计划在第三轮执行。",
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

    report = {
        "schemaVersion": "1.0.0",
        "metadata": {
            "executedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "gitCommit": current_git_commit(),
            "datasetVersion": dataset_manifest.get("datasetVersion"),
            "datasetDir": str(dataset_dir),
            "split": split,
            "subjectCount": len(evidence_by_id),
            "evidenceFileSha256": file_sha256(evidence_path),
            "promptsFileSha256": file_sha256(prompts_path),
            "aliasesTaxonomyVersion": aliases.get("taxonomyVersion"),
            "referenceTime": dataset_manifest.get("referenceTime"),
        },
        "methods": methods_report,
        "pairwiseAgreement": pairwise,
    }

    (output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "run-manifest.json").write_text(json.dumps(report["metadata"], ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "report.md").write_text(render_markdown_report(report), encoding="utf-8")
    return report


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="HappyGit file-based portrait experiment runner")
    parser.add_argument("--dataset-dir", required=True, type=Path, help="Dataset directory containing dataset-manifest.json & evidence-views/")
    parser.add_argument("--output-dir", required=True, type=Path, help="Output directory for run manifest, prompts, predictions, and report")
    parser.add_argument("--split", default="test", choices=["validation", "test"], help="Evaluation split (default: test)")
    parser.add_argument("--taxonomy", default=DEFAULT_TAXONOMY_PATH, type=Path, help="Path to public taxonomy.json")
    parser.add_argument("--aliases", default=None, type=Path, help="Path to frozen taxonomy_aliases.json")
    parser.add_argument("--baseline-predictions", default=None, type=Path, help="Optional JSONL of external baseline predictions")
    parser.add_argument("--learned-predictions", default=None, type=Path, help="Optional JSONL of A's learned model predictions")
    parser.add_argument("--learned-cmd", default=None, type=str, help="Optional CLI command template to invoke A's learned inference")
    parser.add_argument("--llm-predictions", default=None, type=Path, help="Optional JSONL of LLM reference predictions")
    parser.add_argument("--run-llm-api", action="store_true", help="Actually call external LLM API using env vars (Round 3)")
    parser.add_argument("--subset-repeats", type=int, default=0, help="Repeat calls on fixed subset to report LLM variance")

    args = parser.parse_args(argv)
    report = run_experiment_pipeline(
        dataset_dir=args.dataset_dir,
        output_dir=args.output_dir,
        split=args.split,
        taxonomy_path=args.taxonomy,
        aliases_path=args.aliases,
        baseline_predictions_path=args.baseline_predictions,
        learned_predictions_path=args.learned_predictions,
        learned_cmd=args.learned_cmd,
        llm_predictions_path=args.llm_predictions,
        run_llm_api=args.run_llm_api,
        subset_repeats=args.subset_repeats,
    )
    print(json.dumps({
        "datasetVersion": report["metadata"]["datasetVersion"],
        "split": report["metadata"]["split"],
        "subjectCount": report["metadata"]["subjectCount"],
        "methods": {k: {"status": v.get("status"), "overall": (v.get("metrics") or {}).get("overall")} for k, v in report["methods"].items()},
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
