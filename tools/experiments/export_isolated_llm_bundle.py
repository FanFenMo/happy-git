#!/usr/bin/env python3
"""Export a strictly isolated, zero-leakage single-user LLM evaluation bundle.

Contains ONLY sanitized common-evidence prompts (matching llm-prompts.jsonl),
the fixed repeat-subset IDs, a zero-truth format/citation validator, and README
instructions for running independent external LLM sessions (e.g., Codex).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

EXPERIMENTS_DIR = Path(__file__).resolve().parent
if str(EXPERIMENTS_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_DIR))

from prompt_builder import FORBIDDEN_LEAK_KEYS, verify_no_leakage  # noqa: E402


VALIDATOR_SCRIPT = '''#!/usr/bin/env python3
"""Zero-truth validator for external LLM portrait prediction JSONL outputs.

Checks ONLY against the public sanitized prompts in this isolated bundle:
- Valid JSONL lines and required fields
- Subject coverage (all 100 test users or the 20 fixed repeat-subset users)
- Valid distribution values and topInterests structure
- Evidence citation validity (no repoId outside that user's sanitized evidence)
- Honest empty-evidence handling check
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Set


def extract_allowed_repo_ids(prompt_row: Dict[str, Any]) -> Set[str]:
    payload = json.loads(prompt_row["userPrompt"])
    ev = payload.get("userEvidence") or {}
    allowed: Set[str] = set()
    for section in ("stars", "owned"):
        block = ev.get(section) or {}
        for r in block.get("repos") or []:
            if isinstance(r, dict) and r.get("repoId") is not None:
                allowed.add(str(r["repoId"]))
    for b in ev.get("browseEvents") or []:
        if isinstance(b, dict) and b.get("repoId") is not None:
            allowed.add(str(b["repoId"]))
    return allowed


def has_any_evidence(prompt_row: Dict[str, Any]) -> bool:
    payload = json.loads(prompt_row["userPrompt"])
    ev = payload.get("userEvidence") or {}
    if extract_allowed_repo_ids(prompt_row):
        return True
    return bool(ev.get("manualTags"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate LLM prediction JSONL against isolated prompts only")
    parser.add_argument("predictions", type=Path, help="Path to prediction JSONL file")
    parser.add_argument("--mode", choices=["all100", "repeat20"], default="all100", help="Expected subject coverage")
    args = parser.parse_args()

    bundle_dir = Path(__file__).resolve().parent
    prompts_by_id: Dict[str, Dict[str, Any]] = {}
    for line in (bundle_dir / "llm-prompts.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        prompts_by_id[str(row["subjectId"])] = row

    repeat_meta = json.loads((bundle_dir / "repeat-subset-ids.json").read_text(encoding="utf-8"))
    expected_ids = (
        sorted(prompts_by_id.keys())
        if args.mode == "all100"
        else list(repeat_meta.get("subjectIds") or [])
    )

    preds_by_id: Dict[str, Dict[str, Any]] = {}
    duplicate_ids: List[str] = []
    parse_errors: List[str] = []
    for idx, line in enumerate(args.predictions.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            parse_errors.append(f"line {idx}: {exc}")
            continue
        sid = str(row.get("subjectId") or "")
        if not sid:
            parse_errors.append(f"line {idx}: missing subjectId")
            continue
        if sid in preds_by_id:
            duplicate_ids.append(sid)
        preds_by_id[sid] = row

    missing_ids = [sid for sid in expected_ids if sid not in preds_by_id]
    unexpected_ids = [sid for sid in preds_by_id if sid not in prompts_by_id]

    schema_issues: List[str] = []
    hallucinated_citations: List[Dict[str, Any]] = []
    empty_mismatches: List[str] = []

    for sid in expected_ids:
        pred = preds_by_id.get(sid)
        if not pred:
            continue
        prompt_row = prompts_by_id[sid]
        allowed = extract_allowed_repo_ids(prompt_row)
        non_empty_ev = has_any_evidence(prompt_row)

        status = str(pred.get("status") or "")
        if status not in ("ready", "empty"):
            schema_issues.append(f"{sid}: invalid status={status!r}")
        if not isinstance(pred.get("languages"), dict):
            schema_issues.append(f"{sid}: languages must be object")
        if not isinstance(pred.get("topics"), dict):
            schema_issues.append(f"{sid}: topics must be object")
        if not isinstance(pred.get("topInterests"), list):
            schema_issues.append(f"{sid}: topInterests must be array")
        if not isinstance(pred.get("evidenceRepos"), list):
            schema_issues.append(f"{sid}: evidenceRepos must be array")

        if not non_empty_ev and (status != "empty" or pred.get("evidenceRepos") or pred.get("topInterests")):
            empty_mismatches.append(sid)

        cited: Set[str] = set(str(r) for r in (pred.get("evidenceRepos") or []))
        for item in pred.get("topInterests") or []:
            if isinstance(item, dict):
                for r in item.get("evidenceRepos") or []:
                    cited.add(str(r))
        bad_refs = sorted(r for r in cited if r not in allowed)
        if bad_refs:
            hallucinated_citations.append({"subjectId": sid, "invalidRepoIds": bad_refs})

    summary = {
        "file": str(args.predictions),
        "mode": args.mode,
        "expectedCount": len(expected_ids),
        "presentCount": len([sid for sid in expected_ids if sid in preds_by_id]),
        "missingCount": len(missing_ids),
        "missingIds": missing_ids[:20],
        "duplicateIds": duplicate_ids,
        "unexpectedIds": unexpected_ids,
        "parseErrorCount": len(parse_errors),
        "parseErrors": parse_errors[:10],
        "schemaIssueCount": len(schema_issues),
        "schemaIssues": schema_issues[:10],
        "emptyEvidenceMismatchIds": empty_mismatches,
        "hallucinatedCitationSubjects": len(hallucinated_citations),
        "hallucinatedCitationSamples": hallucinated_citations[:10],
        "ok": (
            not missing_ids
            and not duplicate_ids
            and not unexpected_ids
            and not parse_errors
            and not schema_issues
        ),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
'''


README_TEMPLATE = """# HappyGit 独立外部大模型画像评测隔离包

> 本目录是**严格脱敏、零真值泄漏**的独立评测输入包，仅包含与基线模型、学习模型完全一致的共同公开证据与公开 `taxonomy`，**不含任何 `evaluation-only/` 真值、控制样本、场景配额或其它模型预测结果**。

## 物理隔离建议（强烈推荐）

如果使用 **Codex（如 `6.2 sol xhigh`）** 评测，建议：
1. 将本目录整体复制到仓库外的一个独立空目录（例如 `E:\\happygit-llm-eval-isolated`），**只打开该独立目录作为 Codex 的工作区**，确保 Codex 无法访问仓库里的任何真值或预测文件；
2. 每位用户必须是**独立无状态推理**（禁止把多位用户拼在同一个上下文里互相影响，也**严禁写 Python 规则/词频统计脚本代替大模型语义推理**）。

## 目录清单

- `prompts/001_<subjectId>.json` ~ `100_<subjectId>.json`：100 位测试用户的单用户脱敏提示包（每文件均含 `subjectId`、`evidenceHash`、`promptDigest`、`systemPrompt`、`userPrompt`）。
- `llm-prompts.jsonl`：与 `prompts/` 完全等价的 100 行 JSONL（SHA-256: `{prompts_sha256}`）。
- `repeat-subset-ids.json`：固定的 20 位分层重复抽样子集（seed=`{repeat_seed}`），用于独立重跑第 2 轮与第 3 轮，衡量重复调用波动性。
- `validate_predictions.py`：零真值格式与引用完整性校验脚本（仅对照本目录 `prompts/` 检验 JSON 合法性、ID 覆盖率与 `repoId` 是否越界）。
- `outputs/`：建议将评测产出 JSONL 放在这里。

## 要求产出的文件

放在 `outputs/` 目录下（UTF-8，每行一个 JSON 对象）：

1. **全量主评测（必选，100 行）**：`outputs/codex_run1_all100.jsonl`
2. **20 人固定子集第 2 次独立推理（推荐，20 行）**：`outputs/codex_run2_repeat20.jsonl`
3. **20 人固定子集第 3 次独立推理（推荐，20 行）**：`outputs/codex_run3_repeat20.jsonl`

### 每行 JSON 字段格式

```json
{{
  "subjectId": "subj_standard_0163",
  "method": "llm_codex_sol_xhigh",
  "modelVersion": "codex-6.2-sol-xhigh",
  "evidenceHash": "<原样拷贝输入中的 evidenceHash>",
  "promptDigest": "<原样拷贝输入中的 promptDigest>",
  "status": "ready",
  "languages": {{"Python": 0.55, "TypeScript": 0.25, "C++": 0.20}},
  "topics": {{"llm": 0.35, "machine-learning": 0.30, "deep-learning": 0.20, "nlp": 0.15}},
  "topInterests": [
    {{"tag": "llm", "score": 0.35, "evidenceRepos": ["1003043071", "1003143578"]}}
  ],
  "evidenceRepos": ["1003043071", "1003143578"],
  "rationale": "简短说明依据"
}}
```

> **空证据样本规则**：若某用户的 `stars.repos`、`owned.repos`、`browseEvents` 与 `manualTags` 均为空，**必须**输出 `"status": "empty"`、`languages: {{}}`、`topics: {{}}`、`topInterests: []`、`evidenceRepos: []`，绝不编造仓库或强行归类。

## 可直接复制给 Codex 的执行指令

```text
请严格按照当前目录 README.md 的防泄漏评测规范执行，不要访问当前目录之外的任何文件。
核心要求：
1. 必须由模型自身直接阅读每个用户的 sanitized JSON 证据并做语义推理，严禁编写规则统计/词频/启发式 Python 脚本来生成画像结果。
2. 每次推理只看单用户文件（prompts/001_*.json ~ 100_*.json），逐个独立评估（建议使用独立子代理或独立会话，每个子代理只处理 1 个用户文件，不跨用户共享上下文），将 100 条结果追加写入 outputs/codex_run1_all100.jsonl（每行 JSON 必须包含 subjectId, method="llm_codex_sol_xhigh", modelVersion="codex-6.2-sol-xhigh", evidenceHash, promptDigest, status, languages, topics, topInterests, evidenceRepos, rationale）。
3. 完成后，再针对 repeat-subset-ids.json 中的 20 位用户，用全新的独立上下文分别再跑 2 轮，输出到 outputs/codex_run2_repeat20.jsonl 和 outputs/codex_run3_repeat20.jsonl。
4. 运行 python validate_predictions.py outputs/codex_run1_all100.jsonl --mode all100（以及 repeat20 校验），确认无格式错误和缺失 ID（不要篡改模型原始推理结论）。
```

## 校验命令

```bash
python validate_predictions.py outputs/codex_run1_all100.jsonl --mode all100
python validate_predictions.py outputs/codex_run2_repeat20.jsonl --mode repeat20
python validate_predictions.py outputs/codex_run3_repeat20.jsonl --mode repeat20
```
"""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def export_isolated_bundle(
    prompts_jsonl: Path,
    repeat_subset_json: Path,
    output_dir: Path,
) -> Dict[str, Any]:
    prompts_jsonl = prompts_jsonl.resolve()
    repeat_subset_json = repeat_subset_json.resolve()
    output_dir = output_dir.resolve()

    if not prompts_jsonl.exists():
        raise FileNotFoundError(f"prompts file not found: {prompts_jsonl}")
    if not repeat_subset_json.exists():
        raise FileNotFoundError(f"repeat subset file not found: {repeat_subset_json}")

    rows: List[Dict[str, Any]] = []
    for line in prompts_jsonl.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        verify_no_leakage(row)
        user_payload = json.loads(str(row.get("userPrompt") or "{}"))
        verify_no_leakage(user_payload)
        rows.append(row)

    repeat_meta = json.loads(repeat_subset_json.read_text(encoding="utf-8"))
    repeat_ids = set(str(x) for x in (repeat_meta.get("subjectIds") or []))

    prompts_dir = output_dir / "prompts"
    outputs_dir = output_dir / "outputs"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)

    # Copy exact frozen llm-prompts.jsonl and repeat-subset-ids.json
    dst_prompts_jsonl = output_dir / "llm-prompts.jsonl"
    dst_prompts_jsonl.write_bytes(prompts_jsonl.read_bytes())
    dst_repeat_json = output_dir / "repeat-subset-ids.json"
    dst_repeat_json.write_bytes(repeat_subset_json.read_bytes())

    file_entries: List[Dict[str, Any]] = []
    for idx, row in enumerate(rows, start=1):
        sid = str(row["subjectId"])
        rel_name = f"{idx:03d}_{sid}.json"
        dst_file = prompts_dir / rel_name
        clean_row = {
            "subjectId": sid,
            "split": row.get("split", "test"),
            "promptVersion": row.get("promptVersion"),
            "evidenceHash": row.get("evidenceHash"),
            "promptDigest": row.get("promptDigest"),
            "systemPrompt": row.get("systemPrompt"),
            "userPrompt": row.get("userPrompt"),
        }
        dst_file.write_text(json.dumps(clean_row, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        file_entries.append({
            "index": idx,
            "subjectId": sid,
            "file": f"prompts/{rel_name}",
            "inRepeatSubset": sid in repeat_ids,
            "evidenceHash": row.get("evidenceHash"),
            "promptDigest": row.get("promptDigest"),
            "charLength": len(str(row.get("userPrompt") or "")),
        })

    prompts_sha = sha256_file(dst_prompts_jsonl)
    (output_dir / "validate_predictions.py").write_text(VALIDATOR_SCRIPT, encoding="utf-8")
    (output_dir / "README.md").write_text(
        README_TEMPLATE.format(
            prompts_sha256=prompts_sha,
            repeat_seed=repeat_meta.get("seed", 20261103),
        ),
        encoding="utf-8",
    )

    manifest = {
        "schemaVersion": "1.0.0",
        "zeroLeakageVerified": True,
        "checkedForbiddenKeys": list(FORBIDDEN_LEAK_KEYS),
        "promptsJsonlSha256": prompts_sha,
        "promptCount": len(file_entries),
        "repeatSubsetSize": len(repeat_ids),
        "repeatSeed": repeat_meta.get("seed"),
        "files": file_entries,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Export isolated zero-leakage LLM prompt bundle")
    parser.add_argument("--prompts-jsonl", required=True, type=Path, help="Frozen llm-prompts.jsonl")
    parser.add_argument("--repeat-subset", required=True, type=Path, help="Frozen repeat-subset-ids.json")
    parser.add_argument("--output-dir", required=True, type=Path, help="Target isolated bundle directory")
    args = parser.parse_args(argv)

    manifest = export_isolated_bundle(
        prompts_jsonl=args.prompts_jsonl,
        repeat_subset_json=args.repeat_subset,
        output_dir=args.output_dir,
    )
    print(json.dumps({
        "outputDir": str(args.output_dir.resolve()),
        "promptCount": manifest["promptCount"],
        "repeatSubsetSize": manifest["repeatSubsetSize"],
        "promptsJsonlSha256": manifest["promptsJsonlSha256"],
        "zeroLeakageVerified": manifest["zeroLeakageVerified"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
