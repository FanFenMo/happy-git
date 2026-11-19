#!/usr/bin/env python3
"""Fixed alignment & evaluation metrics for HappyGit interest portrait experiments.

Evaluates:
  1. Top-8 interest tag alignment (Precision@K, Recall@K, F1@K, Jaccard, nDCG@K)
  2. Language & topic distribution similarity (Cosine, 1 - JSD, L1)
  3. Evidence traceability & hallucination rate (evidenceRepos subset of allowed user inputs)
  4. Empty / no-evidence honesty (whether empty users produce empty/low-confidence portraits)
  5. Breakdowns by scenario, subject source (synthetic/ambiguous/real_styled), and sparsity tier.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


DEFAULT_ALIASES_PATH = Path(__file__).with_name("taxonomy_aliases.json")


def load_aliases(aliases_path: Optional[Path] = None) -> Dict[str, Any]:
    path = aliases_path or DEFAULT_ALIASES_PATH
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize_language(raw: Any, aliases: Dict[str, Any]) -> str:
    if not isinstance(raw, str):
        return ""
    cleaned = raw.strip()
    if not cleaned:
        return ""
    lang_map = aliases.get("languageAliases") or {}
    return str(lang_map.get(cleaned.lower(), cleaned))


def normalize_topic(raw: Any, aliases: Dict[str, Any]) -> str:
    if not isinstance(raw, str):
        return ""
    cleaned = raw.strip().lower().lstrip("#")
    if not cleaned:
        return ""
    topic_map = aliases.get("topicAliases") or {}
    return str(topic_map.get(cleaned, topic_map.get(raw.strip(), cleaned))).lower()


def normalize_distribution(raw: Any, key_normalizer) -> Dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    agg: Dict[str, float] = {}
    for k, v in raw.items():
        try:
            weight = float(v)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(weight) or weight <= 0:
            continue
        nk = key_normalizer(k)
        if nk:
            agg[nk] = agg.get(nk, 0.0) + weight
    total = sum(agg.values())
    if total <= 0:
        return {}
    return {k: v / total for k, v in sorted(agg.items())}


def cosine_similarity_dist(a: Dict[str, float], b: Dict[str, float]) -> Optional[float]:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    dot = sum(a.get(k, 0.0) * b.get(k, 0.0) for k in set(a) | set(b))
    norm_a = math.sqrt(sum(v * v for v in a.values()))
    norm_b = math.sqrt(sum(v * v for v in b.values()))
    if norm_a <= 0 or norm_b <= 0:
        return 0.0
    return max(0.0, min(1.0, dot / (norm_a * norm_b)))


def js_divergence(a: Dict[str, float], b: Dict[str, float]) -> float:
    """Jensen-Shannon divergence normalized to [0, 1] (base 2)."""
    if not a and not b:
        return 0.0
    if not a or not b:
        return 1.0
    keys = set(a) | set(b)
    sum_a = sum(a.values()) or 1.0
    sum_b = sum(b.values()) or 1.0
    jsd = 0.0
    for k in keys:
        pa = a.get(k, 0.0) / sum_a
        pb = b.get(k, 0.0) / sum_b
        pm = 0.5 * (pa + pb)
        if pa > 0 and pm > 0:
            jsd += 0.5 * pa * math.log2(pa / pm)
        if pb > 0 and pm > 0:
            jsd += 0.5 * pb * math.log2(pb / pm)
    return max(0.0, min(1.0, jsd))


def extract_top_tags(prediction: Dict[str, Any], aliases: Dict[str, Any], k: int = 8) -> List[str]:
    tags: List[str] = []
    seen: Set[str] = set()
    for item in prediction.get("topInterests") or []:
        raw = item.get("tag") if isinstance(item, dict) else item
        norm = normalize_topic(raw, aliases)
        if norm and norm not in seen:
            seen.add(norm)
            tags.append(norm)
    if not tags and isinstance(prediction.get("topics"), dict):
        sorted_topics = sorted(
            prediction["topics"].items(),
            key=lambda kv: (-float(kv[1]), str(kv[0])),
        )
        for raw, _ in sorted_topics:
            norm = normalize_topic(raw, aliases)
            if norm and norm not in seen:
                seen.add(norm)
                tags.append(norm)
    return tags[:k]


def extract_evidence_repo_ids(prediction: Dict[str, Any]) -> List[str]:
    seen: Set[str] = set()
    result: List[str] = []

    def _add(val: Any) -> None:
        if val is None:
            return
        if isinstance(val, dict):
            rid = val.get("repoId") or val.get("id")
        else:
            rid = val
        if rid is None:
            return
        s = str(rid).strip()
        if s and s not in seen:
            seen.add(s)
            result.append(s)

    for repo in prediction.get("evidenceRepos") or prediction.get("usedRepoIds") or []:
        _add(repo)
    for item in prediction.get("topInterests") or []:
        if isinstance(item, dict):
            for rid in item.get("evidenceRepos") or []:
                _add(rid)
    return result


def compute_allowed_evidence_repo_ids(evidence_view_row: Dict[str, Any]) -> Set[str]:
    ev = evidence_view_row.get("evidence") or {}
    allowed: Set[str] = set()
    stars = ev.get("stars") or {}
    owned = ev.get("owned") or {}
    if stars.get("complete") is not False:
        for rid in stars.get("repoIds") or []:
            allowed.add(str(rid))
    if owned.get("complete") is not False:
        for rid in owned.get("repoIds") or []:
            allowed.add(str(rid))
    for item in ev.get("browse") or []:
        if item.get("repoId"):
            allowed.add(str(item["repoId"]))
    return allowed


def compute_empirical_evidence_distributions(
    evidence_view_row: Dict[str, Any],
    aliases: Dict[str, Any],
) -> Tuple[Dict[str, float], Dict[str, float], int]:
    """Compute common-evidence empirical language and topic distributions from allowed repos only."""
    ev = evidence_view_row.get("evidence") or {}
    repos_by_id = {str(r["repoId"]): r for r in (ev.get("repositories") or []) if r.get("repoId")}
    weights: Dict[str, float] = {}
    stars = ev.get("stars") or {}
    owned = ev.get("owned") or {}
    for rid in stars.get("repoIds") or []:
        weights[str(rid)] = weights.get(str(rid), 0.0) + 3.0
    for rid in owned.get("repoIds") or []:
        weights[str(rid)] = weights.get(str(rid), 0.0) + 1.5
    browse_count = 0
    for b in ev.get("browse") or []:
        rid = str(b.get("repoId") or "")
        cnt = int(b.get("count") or 1)
        browse_count += cnt
        if rid:
            weights[rid] = weights.get(rid, 0.0) + min(1.0 + math.log(max(1, cnt)), 3.0)

    lang_raw: Dict[str, float] = {}
    topic_raw: Dict[str, float] = {}
    for rid, w in weights.items():
        repo = repos_by_id.get(rid)
        if not repo:
            continue
        pl = normalize_language(repo.get("primaryLanguage"), aliases)
        if pl:
            lang_raw[pl] = lang_raw.get(pl, 0.0) + w
        tps = [normalize_topic(t, aliases) for t in (repo.get("topics") or [])]
        tps = [t for t in tps if t]
        if tps:
            share = w / len(tps)
            for t in tps:
                topic_raw[t] = topic_raw.get(t, 0.0) + share

    return (
        normalize_distribution(lang_raw, lambda x: x),
        normalize_distribution(topic_raw, lambda x: x),
        len(weights),
    )


def classify_sparsity(evidence_view_row: Dict[str, Any]) -> str:
    ev = evidence_view_row.get("evidence") or {}
    stars_cnt = len((ev.get("stars") or {}).get("repoIds") or [])
    owned_cnt = len((ev.get("owned") or {}).get("repoIds") or [])
    browse_events = sum(int(b.get("count") or 0) for b in (ev.get("browse") or []))
    total_signals = stars_cnt * 3 + owned_cnt * 2 + browse_events
    if total_signals == 0 and not ev.get("manualTags"):
        return "empty"
    if browse_events <= 15 and stars_cnt <= 5:
        return "sparse"
    if browse_events <= 80:
        return "medium"
    return "dense"


def evaluate_subject_prediction(
    prediction: Dict[str, Any],
    evidence_view_row: Dict[str, Any],
    truth_row: Optional[Dict[str, Any]] = None,
    control_case: Optional[Dict[str, Any]] = None,
    aliases: Optional[Dict[str, Any]] = None,
    top_k: int = 8,
    subject_row: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    aliases = aliases or load_aliases()
    allowed_ids = compute_allowed_evidence_repo_ids(evidence_view_row)
    emp_lang, emp_topic, allowed_repo_count = compute_empirical_evidence_distributions(evidence_view_row, aliases)
    sparsity = classify_sparsity(evidence_view_row)

    pred_tags = extract_top_tags(prediction, aliases, k=top_k)
    pred_langs = normalize_distribution(prediction.get("languages"), lambda x: normalize_language(x, aliases))
    pred_topics = normalize_distribution(prediction.get("topics"), lambda x: normalize_topic(x, aliases))
    pred_ev_ids = extract_evidence_repo_ids(prediction)

    is_empty_prediction = (
        prediction.get("status") == "empty"
        or (len(pred_tags) == 0 and len(pred_langs) == 0 and len(pred_topics) == 0)
    )

    # Evidence traceability check
    if pred_ev_ids:
        invalid_ev = [rid for rid in pred_ev_ids if rid not in allowed_ids]
        hallucinated_evidence_count = len(invalid_ev)
        evidence_valid_rate = (len(pred_ev_ids) - hallucinated_evidence_count) / len(pred_ev_ids)
    else:
        hallucinated_evidence_count = 0
        evidence_valid_rate = 1.0 if len(allowed_ids) == 0 or is_empty_prediction else 0.0

    # Expected empty / control handling
    expected_empty = False
    if truth_row and truth_row.get("expectedConfidence") == "none":
        expected_empty = True
    if control_case and control_case.get("expectedConfidence") == "none":
        expected_empty = True
    if len(allowed_ids) == 0 and not (evidence_view_row.get("evidence") or {}).get("manualTags"):
        expected_empty = True

    empty_handling_correct: Optional[bool] = None
    if expected_empty:
        empty_handling_correct = bool(is_empty_prediction)

    # Top-K tag metrics against generator-truth (when available) or empirical top topics
    target_tags: List[str] = []
    if truth_row and truth_row.get("expectedTopTopics"):
        for t in truth_row.get("expectedTopTopics") or []:
            nt = normalize_topic(t, aliases)
            if nt and nt not in target_tags:
                target_tags.append(nt)
    elif emp_topic:
        target_tags = [k for k, _ in sorted(emp_topic.items(), key=lambda kv: (-kv[1], kv[0]))[:top_k]]

    precision_at_k: Optional[float] = None
    recall_at_k: Optional[float] = None
    f1_at_k: Optional[float] = None
    jaccard: Optional[float] = None
    ndcg_at_k: Optional[float] = None

    if target_tags:
        target_set = set(target_tags[:top_k])
        pred_set = set(pred_tags[:top_k])
        hits = len(target_set & pred_set)
        precision_at_k = hits / max(1, len(pred_tags[:top_k])) if pred_tags else 0.0
        recall_at_k = hits / max(1, len(target_set))
        f1_at_k = (2 * precision_at_k * recall_at_k / (precision_at_k + recall_at_k)) if (precision_at_k + recall_at_k) > 0 else 0.0
        union_len = len(target_set | pred_set)
        jaccard = (hits / union_len) if union_len > 0 else 1.0

        dcg = 0.0
        for rank, tag in enumerate(pred_tags[:top_k], start=1):
            if tag in target_set:
                dcg += 1.0 / math.log2(rank + 1)
        idcg = sum(1.0 / math.log2(r + 1) for r in range(1, min(len(target_set), top_k) + 1))
        ndcg_at_k = (dcg / idcg) if idcg > 0 else 0.0
    elif expected_empty:
        precision_at_k = 1.0 if not pred_tags else 0.0
        recall_at_k = 1.0 if not pred_tags else 0.0
        f1_at_k = 1.0 if not pred_tags else 0.0
        jaccard = 1.0 if not pred_tags else 0.0
        ndcg_at_k = 1.0 if not pred_tags else 0.0

    # Required control-case evidence coverage
    required_ev = [str(x) for x in (control_case.get("requiredEvidenceRepoIds") or [])] if control_case else []
    required_ev_recall: Optional[float] = None
    if required_ev:
        ev_set = set(pred_ev_ids)
        required_ev_recall = sum(1 for r in required_ev if r in ev_set) / len(required_ev)

    lang_evidence_empty = len(emp_lang) == 0
    topic_evidence_empty = len(emp_topic) == 0

    # Empty distributions are scored separately without padding into uniform vectors.
    if lang_evidence_empty:
        lang_cos: Optional[float] = None
        lang_js_sim: Optional[float] = None
        empty_lang_exact: Optional[bool] = len(pred_langs) == 0
    else:
        lang_cos = cosine_similarity_dist(pred_langs, emp_lang)
        lang_js_sim = 1.0 - js_divergence(pred_langs, emp_lang)
        empty_lang_exact = None

    if topic_evidence_empty:
        topic_cos: Optional[float] = None
        topic_js_sim: Optional[float] = None
        empty_topic_exact: Optional[bool] = len(pred_topics) == 0
    else:
        topic_cos = cosine_similarity_dist(pred_topics, emp_topic)
        topic_js_sim = 1.0 - js_divergence(pred_topics, emp_topic)
        empty_topic_exact = None

    scenario = (
        (control_case or {}).get("scenario")
        or (truth_row or {}).get("scenario")
        or (evidence_view_row.get("scenario"))
        or "unknown"
    )
    source_kind = (
        (subject_row or {}).get("sourceKind")
        or (truth_row or {}).get("subjectSourceKind")
        or (evidence_view_row.get("subjectSourceKind"))
        or ("ambiguous" if "ambiguous" in scenario else "synthetic")
    )

    return {
        "subjectId": str(evidence_view_row["subjectId"]),
        "split": evidence_view_row.get("split", "test"),
        "failed": False,
        "error": None,
        "scenario": scenario,
        "sourceKind": source_kind,
        "sparsity": sparsity,
        "allowedRepoCount": allowed_repo_count,
        "predictedTagCount": len(pred_tags),
        "predictedTags": pred_tags,
        "isEmptyPrediction": is_empty_prediction,
        "expectedEmpty": expected_empty,
        "emptyHandlingCorrect": empty_handling_correct,
        "langEvidenceEmpty": lang_evidence_empty,
        "topicEvidenceEmpty": topic_evidence_empty,
        "emptyLangExact": empty_lang_exact,
        "emptyTopicExact": empty_topic_exact,
        "precisionAtK": precision_at_k,
        "recallAtK": recall_at_k,
        "f1AtK": f1_at_k,
        "jaccard": jaccard,
        "ndcgAtK": ndcg_at_k,
        "langCosine": lang_cos,
        "langJsSimilarity": lang_js_sim,
        "topicCosine": topic_cos,
        "topicJsSimilarity": topic_js_sim,
        "evidenceValidRate": evidence_valid_rate,
        "hallucinatedEvidenceCount": hallucinated_evidence_count,
        "requiredEvidenceRecall": required_ev_recall,
    }


def make_failed_subject_evaluation(
    evidence_view_row: Dict[str, Any],
    truth_row: Optional[Dict[str, Any]] = None,
    control_case: Optional[Dict[str, Any]] = None,
    subject_row: Optional[Dict[str, Any]] = None,
    error_message: str = "prediction_missing_or_failed",
) -> Dict[str, Any]:
    scenario = (
        (control_case or {}).get("scenario")
        or (truth_row or {}).get("scenario")
        or (evidence_view_row.get("scenario"))
        or "unknown"
    )
    source_kind = (
        (subject_row or {}).get("sourceKind")
        or (truth_row or {}).get("subjectSourceKind")
        or (evidence_view_row.get("subjectSourceKind"))
        or ("ambiguous" if "ambiguous" in scenario else "synthetic")
    )
    return {
        "subjectId": str(evidence_view_row["subjectId"]),
        "split": evidence_view_row.get("split", "test"),
        "failed": True,
        "error": str(error_message),
        "scenario": scenario,
        "sourceKind": source_kind,
        "sparsity": classify_sparsity(evidence_view_row),
        "allowedRepoCount": len(compute_allowed_evidence_repo_ids(evidence_view_row)),
        "predictedTagCount": 0,
        "predictedTags": [],
        "isEmptyPrediction": False,
        "expectedEmpty": False,
        "emptyHandlingCorrect": None,
        "langEvidenceEmpty": False,
        "topicEvidenceEmpty": False,
        "emptyLangExact": None,
        "emptyTopicExact": None,
        "precisionAtK": None,
        "recallAtK": None,
        "f1AtK": None,
        "jaccard": None,
        "ndcgAtK": None,
        "langCosine": None,
        "langJsSimilarity": None,
        "topicCosine": None,
        "topicJsSimilarity": None,
        "evidenceValidRate": None,
        "hallucinatedEvidenceCount": 0,
        "requiredEvidenceRecall": None,
    }


def _avg(values: Iterable[Optional[float]]) -> Optional[float]:
    valid = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    if not valid:
        return None
    return round(sum(valid) / len(valid), 4)


def aggregate_metrics(per_subject: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not per_subject:
        return {"overall": {"count": 0, "succeededCount": 0, "failedCount": 0}, "byScenario": {}, "bySourceKind": {}, "bySparsity": {}}

    def _summarize(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        failed_rows = [r for r in rows if r.get("failed")]
        ok_rows = [r for r in rows if not r.get("failed")]
        e_rows = [r for r in ok_rows if r.get("emptyHandlingCorrect") is not None]
        non_empty_lang = [r for r in ok_rows if r.get("langCosine") is not None]
        non_empty_topic = [r for r in ok_rows if r.get("topicCosine") is not None]
        empty_lang_rows = [r for r in ok_rows if r.get("emptyLangExact") is not None]
        empty_topic_rows = [r for r in ok_rows if r.get("emptyTopicExact") is not None]
        return {
            "count": len(rows),
            "succeededCount": len(ok_rows),
            "failedCount": len(failed_rows),
            "precisionAt8": _avg(r.get("precisionAtK") for r in ok_rows),
            "recallAt8": _avg(r.get("recallAtK") for r in ok_rows),
            "f1At8": _avg(r.get("f1AtK") for r in ok_rows),
            "jaccard": _avg(r.get("jaccard") for r in ok_rows),
            "ndcgAt8": _avg(r.get("ndcgAtK") for r in ok_rows),
            "nonEmptyLangCount": len(non_empty_lang),
            "langCosine": _avg(r.get("langCosine") for r in non_empty_lang),
            "langJsSimilarity": _avg(r.get("langJsSimilarity") for r in non_empty_lang),
            "nonEmptyTopicCount": len(non_empty_topic),
            "topicCosine": _avg(r.get("topicCosine") for r in non_empty_topic),
            "topicJsSimilarity": _avg(r.get("topicJsSimilarity") for r in non_empty_topic),
            "emptyDistributionCount": len({r["subjectId"] for r in empty_lang_rows} | {r["subjectId"] for r in empty_topic_rows}),
            "emptyLangExactRate": _avg((1.0 if r["emptyLangExact"] else 0.0) for r in empty_lang_rows),
            "emptyTopicExactRate": _avg((1.0 if r["emptyTopicExact"] else 0.0) for r in empty_topic_rows),
            "evidenceValidRate": _avg(r.get("evidenceValidRate") for r in ok_rows),
            "hallucinatedEvidenceTotal": sum(int(r.get("hallucinatedEvidenceCount") or 0) for r in ok_rows),
            "emptyCaseCount": len(e_rows),
            "emptyHandlingAccuracy": _avg((1.0 if r["emptyHandlingCorrect"] else 0.0) for r in e_rows),
            "requiredEvidenceRecall": _avg(r.get("requiredEvidenceRecall") for r in ok_rows),
        }

    by_scenario: Dict[str, List[Dict[str, Any]]] = {}
    by_source: Dict[str, List[Dict[str, Any]]] = {}
    by_sparsity: Dict[str, List[Dict[str, Any]]] = {}
    for row in per_subject:
        by_scenario.setdefault(str(row["scenario"]), []).append(row)
        by_source.setdefault(str(row["sourceKind"]), []).append(row)
        by_sparsity.setdefault(str(row["sparsity"]), []).append(row)

    summary = _summarize(per_subject)
    return {
        "overall": summary,
        "byScenario": {k: _summarize(v) for k, v in sorted(by_scenario.items())},
        "bySourceKind": {k: _summarize(v) for k, v in sorted(by_source.items())},
        "bySparsity": {k: _summarize(v) for k, v in sorted(by_sparsity.items())},
    }


def compute_method_comparison_deltas(
    eval_base: List[Dict[str, Any]],
    eval_candidate: List[Dict[str, Any]],
    epsilon: float = 0.01,
) -> Dict[str, Any]:
    """Compare candidate vs base per subject: improved, regressed, or tied/uncertain."""
    base_map = {str(r["subjectId"]): r for r in eval_base if not r.get("failed")}
    cand_map = {str(r["subjectId"]): r for r in eval_candidate if not r.get("failed")}
    common_ids = sorted(set(base_map) & set(cand_map))
    if not common_ids:
        return {
            "commonSubjects": 0,
            "improvedCount": 0,
            "regressedCount": 0,
            "uncertainOrTiedCount": 0,
            "meanF1Delta": None,
            "meanJaccardDelta": None,
            "meanTopicCosineDelta": None,
            "byScenario": {},
        }

    improved = 0
    regressed = 0
    uncertain = 0
    f1_deltas: List[float] = []
    jac_deltas: List[float] = []
    topic_deltas: List[float] = []
    by_scenario: Dict[str, Dict[str, int]] = {}

    for sid in common_ids:
        b = base_map[sid]
        c = cand_map[sid]
        scen = str(c.get("scenario") or b.get("scenario") or "unknown")
        bucket = by_scenario.setdefault(scen, {"improved": 0, "regressed": 0, "uncertainOrTied": 0})
        bf1 = b.get("f1AtK")
        cf1 = c.get("f1AtK")
        bjac = b.get("jaccard")
        cjac = c.get("jaccard")
        btop = b.get("topicCosine")
        ctop = c.get("topicCosine")

        if isinstance(bf1, (int, float)) and isinstance(cf1, (int, float)):
            df1 = float(cf1) - float(bf1)
            f1_deltas.append(df1)
            if df1 > epsilon:
                improved += 1
                bucket["improved"] += 1
            elif df1 < -epsilon:
                regressed += 1
                bucket["regressed"] += 1
            else:
                uncertain += 1
                bucket["uncertainOrTied"] += 1
        else:
            uncertain += 1
            bucket["uncertainOrTied"] += 1

        if isinstance(bjac, (int, float)) and isinstance(cjac, (int, float)):
            jac_deltas.append(float(cjac) - float(bjac))
        if isinstance(btop, (int, float)) and isinstance(ctop, (int, float)):
            topic_deltas.append(float(ctop) - float(btop))

    return {
        "commonSubjects": len(common_ids),
        "epsilon": epsilon,
        "improvedCount": improved,
        "regressedCount": regressed,
        "uncertainOrTiedCount": uncertain,
        "meanF1Delta": _avg(f1_deltas),
        "meanJaccardDelta": _avg(jac_deltas),
        "meanTopicCosineDelta": _avg(topic_deltas),
        "byScenario": dict(sorted(by_scenario.items())),
    }


BLIND_AUDIT_CATEGORIES = (
    "grounded",
    "over_inferred",
    "nonexistent_citation",
    "insufficient_evidence",
)


def summarize_blind_audit(
    audit_rows: List[Dict[str, Any]],
    key_data: Dict[str, Any],
) -> Dict[str, Any]:
    """Unblind 4-category human evidence audit rows using blind-review-key.json."""
    mapping_by_subject = key_data.get("mappingBySubject") or {}
    per_method: Dict[str, Dict[str, int]] = {}
    unmatched = 0
    invalid_category = 0
    annotated = 0

    for row in audit_rows:
        sid = str(row.get("subjectId") or "")
        blind_label = str(row.get("blindLabel") or "")
        category = str(row.get("category") or "").strip().lower()
        if not category:
            continue
        if category not in BLIND_AUDIT_CATEGORIES:
            invalid_category += 1
            continue
        real_method = (mapping_by_subject.get(sid) or {}).get(blind_label)
        if not real_method:
            unmatched += 1
            continue
        annotated += 1
        counts = per_method.setdefault(
            real_method,
            {cat: 0 for cat in BLIND_AUDIT_CATEGORIES},
        )
        counts[category] += 1

    methods_out: Dict[str, Any] = {}
    for method, counts in sorted(per_method.items()):
        total = sum(counts.values())
        methods_out[method] = {
            "total": total,
            "counts": counts,
            "rates": {
                cat: round(counts[cat] / total, 4) if total > 0 else None
                for cat in BLIND_AUDIT_CATEGORIES
            },
        }

    return {
        "categories": list(BLIND_AUDIT_CATEGORIES),
        "annotatedEntries": annotated,
        "unmatchedEntries": unmatched,
        "invalidCategoryEntries": invalid_category,
        "byMethod": methods_out,
    }


def compute_pairwise_agreement(
    preds_a: Dict[str, Dict[str, Any]],
    preds_b: Dict[str, Dict[str, Any]],
    aliases: Optional[Dict[str, Any]] = None,
    top_k: int = 8,
) -> Dict[str, Any]:
    """Compare two methods strictly on common subjects (e.g., learned model vs independent LLM)."""
    aliases = aliases or load_aliases()
    common_ids = sorted(set(preds_a.keys()) & set(preds_b.keys()))
    if not common_ids:
        return {"commonSubjects": 0}

    jaccards: List[float] = []
    lang_sims: List[float] = []
    topic_sims: List[float] = []
    for sid in common_ids:
        pa, pb = preds_a[sid], preds_b[sid]
        ta = set(extract_top_tags(pa, aliases, k=top_k))
        tb = set(extract_top_tags(pb, aliases, k=top_k))
        if not ta and not tb:
            jaccards.append(1.0)
        elif not ta or not tb:
            jaccards.append(0.0)
        else:
            jaccards.append(len(ta & tb) / len(ta | tb))
        la = normalize_distribution(pa.get("languages"), lambda x: normalize_language(x, aliases))
        lb = normalize_distribution(pb.get("languages"), lambda x: normalize_language(x, aliases))
        lang_sims.append(cosine_similarity_dist(la, lb) or 0.0)
        tpa = normalize_distribution(pa.get("topics"), lambda x: normalize_topic(x, aliases))
        tpb = normalize_distribution(pb.get("topics"), lambda x: normalize_topic(x, aliases))
        topic_sims.append(cosine_similarity_dist(tpa, tpb) or 0.0)

    return {
        "commonSubjects": len(common_ids),
        "top8TagJaccard": _avg(jaccards),
        "languageCosineAgreement": _avg(lang_sims),
        "topicCosineAgreement": _avg(topic_sims),
    }
