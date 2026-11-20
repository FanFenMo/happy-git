#!/usr/bin/env python3
"""Unit tests for the file-based interest portrait experiment runner."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

EXPERIMENTS_DIR = Path(__file__).resolve().parent
if str(EXPERIMENTS_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_DIR))

from metrics import evaluate_subject_prediction, load_aliases  # noqa: E402
from prompt_builder import FORBIDDEN_LEAK_KEYS, build_llm_prompt_for_subject  # noqa: E402
from run_experiment import run_experiment_pipeline  # noqa: E402


REPO_ROOT = EXPERIMENTS_DIR.parent.parent
PILOT_FIXTURE_DIR = REPO_ROOT / "tools" / "datasets" / "generated" / "pilot-synthetic-fixture"
TAXONOMY_PATH = REPO_ROOT / "tools" / "datasets" / "taxonomy.json"


class ExperimentRunnerTest(unittest.TestCase):
    def test_prompt_excludes_leakage_keys_and_verifies_hash(self) -> None:
        taxonomy = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
        evidence_line = (PILOT_FIXTURE_DIR / "evidence-views" / "test.jsonl").read_text(encoding="utf-8").splitlines()[0]
        row = json.loads(evidence_line)

        prompt_pkg = build_llm_prompt_for_subject(row, taxonomy)
        self.assertEqual(prompt_pkg["evidenceHash"], row["evidenceHash"])
        combined_text = prompt_pkg["systemPrompt"] + "\n" + prompt_pkg["userPrompt"]
        for forbidden in FORBIDDEN_LEAK_KEYS:
            self.assertNotIn(forbidden, combined_text)

        # Tampered evidenceHash must raise ValueError
        tampered = json.loads(evidence_line)
        tampered["evidenceHash"] = "0" * 64
        with self.assertRaises(ValueError):
            build_llm_prompt_for_subject(tampered, taxonomy)

    def test_hallucinated_evidence_and_empty_handling_metrics(self) -> None:
        aliases = load_aliases()
        ev_rows = [
            json.loads(line)
            for line in (PILOT_FIXTURE_DIR / "evidence-views" / "test.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        ctrl_rows = {
            r["subjectId"]: r
            for r in [
                json.loads(line)
                for line in (PILOT_FIXTURE_DIR / "evaluation-only" / "control-cases.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        }

        empty_row = next(r for r in ev_rows if ctrl_rows.get(r["subjectId"], {}).get("scenario") == "no_evidence")
        honest_empty = evaluate_subject_prediction(
            {"status": "empty", "languages": {}, "topics": {}, "topInterests": [], "evidenceRepos": []},
            empty_row,
            control_case=ctrl_rows[empty_row["subjectId"]],
            aliases=aliases,
        )
        self.assertTrue(honest_empty["emptyHandlingCorrect"])

        forced_non_empty = evaluate_subject_prediction(
            {"status": "ready", "languages": {"Rust": 1.0}, "topics": {"llm": 1.0}, "topInterests": [{"tag": "llm"}], "evidenceRepos": ["99999999"]},
            empty_row,
            control_case=ctrl_rows[empty_row["subjectId"]],
            aliases=aliases,
        )
        self.assertFalse(forced_non_empty["emptyHandlingCorrect"])
        self.assertEqual(forced_non_empty["hallucinatedEvidenceCount"], 1)
        self.assertEqual(forced_non_empty["evidenceValidRate"], 0.0)

    def test_end_to_end_pipeline_with_mock_learned_and_llm_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "exp-out"
            test_rows = [
                json.loads(line)
                for line in (PILOT_FIXTURE_DIR / "evidence-views" / "test.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            learned_path = Path(tmp) / "learned_preds.jsonl"
            llm_path = Path(tmp) / "llm_preds.jsonl"
            learned_lines = []
            llm_lines = []
            for row in test_rows:
                sid = row["subjectId"]
                ev = row["evidence"]
                allowed_repo_ids = [str(r["repoId"]) for r in (ev.get("repositories") or [])[:2]]
                if not allowed_repo_ids:
                    pred = {"subjectId": sid, "modelVersion": "mr-content-v2-data2", "status": "empty", "languages": {}, "topics": {}, "topInterests": [], "evidenceRepos": []}
                else:
                    pred = {
                        "subjectId": sid,
                        "modelVersion": "mr-content-v2-data2",
                        "status": "ready",
                        "languages": {"TypeScript": 0.6, "JavaScript": 0.4},
                        "topics": {"vuejs": 0.7, "reactjs": 0.3},  # Test alias mapping vuejs->vue, reactjs->react
                        "topInterests": [{"tag": "vuejs", "score": 0.7, "evidenceRepos": allowed_repo_ids}],
                        "evidenceRepos": allowed_repo_ids,
                    }
                learned_lines.append(json.dumps(pred))
                llm_lines.append(json.dumps({**pred, "modelVersion": "gpt-ref-test"}))

            learned_path.write_text("\n".join(learned_lines) + "\n", encoding="utf-8")
            llm_path.write_text("\n".join(llm_lines) + "\n", encoding="utf-8")

            report = run_experiment_pipeline(
                dataset_dir=PILOT_FIXTURE_DIR,
                output_dir=out_dir,
                split="test",
                learned_predictions_path=learned_path,
                llm_predictions_path=llm_path,
            )

            self.assertEqual(report["metadata"]["subjectCount"], len(test_rows))
            self.assertEqual(report["methods"]["baseline_local_v1"]["status"], "completed")
            self.assertEqual(report["methods"]["learned_model"]["status"], "completed")
            self.assertEqual(report["methods"]["llm_reference"]["status"], "completed")
            self.assertGreater(report["methods"]["baseline_local_v1"]["metrics"]["overall"]["evidenceValidRate"], 0.99)
            self.assertEqual(report["methods"]["baseline_local_v1"]["metrics"]["overall"]["emptyHandlingAccuracy"], 1.0)
            self.assertIn("baseline_local_v1__vs__learned_model", report["pairwiseAgreement"])
            self.assertTrue((out_dir / "report.md").exists())
            self.assertTrue((out_dir / "llm-prompts.jsonl").exists())
            # Verify anonymized blind spot-check export contains zero method names or leakage
            blind_sample_path = out_dir / "blind-review-sample.jsonl"
            blind_key_path = out_dir / "blind-review-key.json"
            self.assertTrue(blind_sample_path.exists())
            self.assertTrue(blind_key_path.exists())
            blind_text = blind_sample_path.read_text(encoding="utf-8")
            self.assertNotIn("baseline_local_v1", blind_text)
            self.assertNotIn("learned_model", blind_text)
            self.assertNotIn("llm_reference", blind_text)
            self.assertNotIn("mr-content-v2-data2", blind_text)
            self.assertNotIn("gpt-ref-test", blind_text)

    def test_baseline_cmd_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            adapter_script = tmp_dir / "mock_baseline.py"
            adapter_script.write_text(
                "\n".join([
                    "import json, sys",
                    "from pathlib import Path",
                    "ev_path, out_path = Path(sys.argv[1]), Path(sys.argv[2])",
                    "rows = [json.loads(l) for l in ev_path.read_text(encoding='utf-8').splitlines() if l.strip()]",
                    "out = []",
                    "for r in rows:",
                    "    repos = (r.get('evidence') or {}).get('repositories') or []",
                    "    if not repos:",
                    "        out.append({'subjectId': r['subjectId'], 'modelVersion': 'cmd-base-v1', 'status': 'empty', 'languages': {}, 'topics': {}, 'topInterests': [], 'evidenceRepos': []})",
                    "    else:",
                    "        rid = str(repos[0]['repoId'])",
                    "        out.append({'subjectId': r['subjectId'], 'modelVersion': 'cmd-base-v1', 'status': 'ready', 'languages': {'Python': 1.0}, 'topics': {'llm': 1.0}, 'topInterests': [{'tag': 'llm', 'score': 1.0, 'evidenceRepos': [rid]}], 'evidenceRepos': [rid]})",
                    "out_path.write_text('\\n'.join(json.dumps(x) for x in out) + '\\n', encoding='utf-8')",
                ]),
                encoding="utf-8",
            )
            out_dir = tmp_dir / "cmd-out"
            cmd_tpl = f'"{sys.executable}" "{adapter_script}" "{{evidence_file}}" "{{output}}"'
            report = run_experiment_pipeline(
                dataset_dir=PILOT_FIXTURE_DIR,
                output_dir=out_dir,
                split="test",
                baseline_cmd=cmd_tpl,
                blind_review_count=0,
            )
            self.assertEqual(report["methods"]["baseline_local_v1"]["modelVersion"], "cmd-base-v1")
            self.assertEqual(report["methods"]["baseline_local_v1"]["status"], "completed")
            self.assertIsNone(report["metadata"]["blindReview"])

    def test_server_export_bundle_extra_model_llm_repeats_blind_audit_and_charts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            test_rows = [
                json.loads(line)
                for line in (PILOT_FIXTURE_DIR / "evidence-views" / "test.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            # 1. Build a compliant Member A learning-export bundle with SHA-256 checksums
            export_dir = tmp_dir / "server-export"
            export_dir.mkdir(parents=True, exist_ok=True)
            mr_base_lines, learned_lines, retrained_lines = [], [], []
            for row in test_rows:
                sid = row["subjectId"]
                repos = (row.get("evidence") or {}).get("repositories") or []
                allowed = [str(r["repoId"]) for r in repos[:2]]
                if not allowed:
                    empty_row = {
                        "subjectId": sid,
                        "status": "empty",
                        "languages": {},
                        "topics": {},
                        "topInterests": [],
                        "usedRepoIds": [],
                        "evidenceRepos": [],
                    }
                    mr_base_lines.append(json.dumps({**empty_row, "method": "baseline_mr_fixed_v1", "modelVersion": "rules-mr-30d-3-1.5-v1"}))
                    learned_lines.append(json.dumps({**empty_row, "method": "learned_model", "modelVersion": "portrait-r3-init"}))
                    retrained_lines.append(json.dumps({**empty_row, "method": "learned_model", "modelVersion": "portrait-r3-retrained"}))
                else:
                    first_lang = repos[0].get("primaryLanguage") or "Python"
                    first_topics = repos[0].get("topics") or ["llm"]
                    mr_base_lines.append(json.dumps({
                        "subjectId": sid,
                        "method": "baseline_mr_fixed_v1",
                        "modelVersion": "rules-mr-30d-3-1.5-v1",
                        "status": "ready",
                        "languages": {first_lang: 1.0},
                        "topics": {first_topics[0]: 1.0},
                        "topInterests": [{"tag": first_topics[0], "score": 1.0, "evidenceRepos": allowed}],
                        "usedRepoIds": allowed,
                    }))
                    learned_lines.append(json.dumps({
                        "subjectId": sid,
                        "method": "learned_model",
                        "modelVersion": "portrait-r3-init",
                        "status": "ready",
                        "languages": {first_lang: 1.0},
                        "topics": {t: round(1.0 / len(first_topics), 4) for t in first_topics},
                        "topInterests": [{"tag": t, "score": 0.5, "evidenceRepos": allowed} for t in first_topics],
                        "evidenceRepos": allowed,
                    }))
                    retrained_lines.append(json.dumps({
                        "subjectId": sid,
                        "method": "learned_model",
                        "modelVersion": "portrait-r3-retrained",
                        "status": "ready",
                        "languages": {first_lang: 1.0},
                        "topics": {t: round(1.0 / len(first_topics), 4) for t in first_topics},
                        "topInterests": [{"tag": t, "score": 0.6, "evidenceRepos": allowed} for t in first_topics],
                        "evidenceRepos": allowed,
                    }))

            base_file = export_dir / "baseline.jsonl"
            learned_file = export_dir / "learned.jsonl"
            retrained_file = tmp_dir / "learned_retrained.jsonl"
            base_file.write_text("\n".join(mr_base_lines) + "\n", encoding="utf-8")
            learned_file.write_text("\n".join(learned_lines) + "\n", encoding="utf-8")
            retrained_file.write_text("\n".join(retrained_lines) + "\n", encoding="utf-8")

            export_manifest = {
                "schemaVersion": "1.0.0",
                "state": "completed",
                "protocolDigest": "abc123",
                "datasetVersion": "hg-pilot-synthetic_fixture-20261103",
                "catalogSnapshotId": "cat_1",
                "featureSpaceVersion": "fs_1",
                "modelVersion": "portrait-r3-init",
                "framework": "local",
                "userBlocks": 1,
                "elapsedMs": 120,
                "files": {
                    "baseline": {"path": "baseline.jsonl", "sha256": hashlib.sha256(base_file.read_bytes()).hexdigest()},
                    "learned": {"path": "learned.jsonl", "sha256": hashlib.sha256(learned_file.read_bytes()).hexdigest()},
                },
            }
            (export_dir / "run-manifest.json").write_text(json.dumps(export_manifest), encoding="utf-8")

            # 2. Fake LLM caller tracking call counts per subject & simulating 1 failed subject
            call_counts: dict[str, int] = {}
            failed_sid = str(test_rows[-1]["subjectId"])

            def fake_llm_caller(prompt_row, api_url, api_key, model_name, timeout_sec=60, temperature=0.0, provider=None):
                sid = str(prompt_row["subjectId"])
                call_counts[sid] = call_counts.get(sid, 0) + 1
                if sid == failed_sid:
                    return {
                        "ok": False,
                        "subjectId": sid,
                        "provider": provider or "test-provider",
                        "calledAt": "2026-11-18T00:00:00Z",
                        "modelIdentifier": "test-llm-v1",
                        "promptVersion": prompt_row["promptVersion"],
                        "promptDigest": prompt_row["promptDigest"],
                        "requestParams": {"temperature": temperature},
                        "evidenceHash": prompt_row["evidenceHash"],
                        "elapsedMs": 15,
                        "error": "simulated_timeout",
                    }
                ev = next(r["evidence"] for r in test_rows if str(r["subjectId"]) == sid)
                repos = ev.get("repositories") or []
                if not repos:
                    pred = {"subjectId": sid, "method": "llm_reference", "modelVersion": "test-llm-v1", "status": "empty", "languages": {}, "topics": {}, "topInterests": [], "evidenceRepos": []}
                else:
                    rid = str(repos[0]["repoId"])
                    topic = (repos[0].get("topics") or ["llm"])[0]
                    pred = {
                        "subjectId": sid,
                        "method": "llm_reference",
                        "modelVersion": "test-llm-v1",
                        "status": "ready",
                        "languages": {repos[0].get("primaryLanguage") or "Python": 1.0},
                        "topics": {topic: 1.0},
                        "topInterests": [{"tag": topic, "score": 1.0, "evidenceRepos": [rid]}],
                        "evidenceRepos": [rid],
                    }
                return {
                    "ok": True,
                    "subjectId": sid,
                    "provider": provider or "test-provider",
                    "calledAt": "2026-11-18T00:00:00Z",
                    "modelIdentifier": "test-llm-v1",
                    "promptVersion": prompt_row["promptVersion"],
                    "promptDigest": prompt_row["promptDigest"],
                    "requestParams": {"temperature": temperature},
                    "evidenceHash": prompt_row["evidenceHash"],
                    "elapsedMs": 25,
                    "prediction": pred,
                    "rawResponse": json.dumps(pred),
                }

            out_dir = tmp_dir / "round3-out"
            report = run_experiment_pipeline(
                dataset_dir=PILOT_FIXTURE_DIR,
                output_dir=out_dir,
                split="test",
                server_export_dir=export_dir,
                extra_models=[("learned_retrained", retrained_file)],
                run_llm_api=True,
                subset_repeats=3,
                repeat_subset_size=3,
                llm_provider="test-provider",
                llm_caller=fake_llm_caller,
            )

            self.assertIn("baseline_local_v1", report["methods"])
            self.assertIn("baseline_mr_fixed_v1", report["methods"])
            self.assertIn("learned_model", report["methods"])
            self.assertIn("learned_retrained", report["methods"])
            self.assertIn("llm_reference", report["methods"])
            self.assertEqual(report["methods"]["llm_reference"]["metrics"]["overall"]["failedCount"], 1)
            self.assertEqual(report["methods"]["llm_reference"]["stability"]["totalCallsPerSubsetSubject"], 3)
            # Subset users were called exactly 3 times total (1 main + 2 repeats), non-subset called 1 time
            subset_ids = set(report["methods"]["llm_reference"]["stability"]["subsetSubjectIds"])
            for sid, cnt in call_counts.items():
                self.assertEqual(cnt, 3 if sid in subset_ids else 1)

            # Verify empty distributions were separated (not padded into cosine averages)
            empty_evals = [r for r in report["methods"]["baseline_local_v1"]["perSubject"] if r["expectedEmpty"]]
            self.assertEqual(len(empty_evals), 1)
            self.assertIsNone(empty_evals[0]["langCosine"])
            self.assertTrue(empty_evals[0]["emptyLangExact"])

            # Verify SVG charts generated
            self.assertGreaterEqual(len(report["charts"]), 3)
            for c in report["charts"]:
                self.assertTrue((out_dir / c["path"]).exists())

            # Verify blind audit worksheet & unblinding pass
            template_rows = [
                json.loads(l)
                for l in (out_dir / "blind-review-audit-template.jsonl").read_text(encoding="utf-8").splitlines()
                if l.strip()
            ]
            self.assertTrue((out_dir / "blind-review-worksheet.md").exists())
            annotated_path = tmp_dir / "annotated.jsonl"
            for idx, r in enumerate(template_rows):
                r["category"] = "grounded" if idx % 2 == 0 else "over_inferred"
            annotated_path.write_text("\n".join(json.dumps(r) for r in template_rows) + "\n", encoding="utf-8")

            report2 = run_experiment_pipeline(
                dataset_dir=PILOT_FIXTURE_DIR,
                output_dir=out_dir,
                split="test",
                server_export_dir=export_dir,
                extra_models=[("learned_retrained", retrained_file)],
                blind_audit_file=annotated_path,
                blind_key_file=out_dir / "blind-review-key.json",
            )
            self.assertEqual(report2["blindAuditSummary"]["annotatedEntries"], len(template_rows))
            self.assertIn("learned_model", report2["blindAuditSummary"]["byMethod"])

            # Tampered server export SHA-256 must fail fast
            base_file.write_text("{}\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                run_experiment_pipeline(
                    dataset_dir=PILOT_FIXTURE_DIR,
                    output_dir=tmp_dir / "bad-export",
                    split="test",
                    server_export_dir=export_dir,
                )

    def test_precomputed_llm_repeats_raw_logs_extra_llm_and_isolated_bundle(self) -> None:
        from export_isolated_llm_bundle import export_isolated_bundle

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            test_rows = [
                json.loads(line)
                for line in (PILOT_FIXTURE_DIR / "evidence-views" / "test.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            # First run baseline-only to produce frozen llm-prompts.jsonl and repeat-subset-ids.json
            prep_dir = tmp_dir / "prep"
            run_experiment_pipeline(
                dataset_dir=PILOT_FIXTURE_DIR,
                output_dir=prep_dir,
                split="test",
                repeat_subset_size=3,
                blind_review_count=0,
            )

            # Export isolated bundle and verify zero leakage + validator script
            bundle_dir = tmp_dir / "isolated-bundle"
            manifest = export_isolated_bundle(
                prompts_jsonl=prep_dir / "llm-prompts.jsonl",
                repeat_subset_json=prep_dir / "repeat-subset-ids.json",
                output_dir=bundle_dir,
            )
            self.assertEqual(manifest["promptCount"], len(test_rows))
            self.assertTrue(manifest["zeroLeakageVerified"])
            self.assertTrue((bundle_dir / "validate_predictions.py").exists())
            self.assertEqual(len(list((bundle_dir / "prompts").glob("*.json"))), len(test_rows))

            # Build pre-computed main + 2 repeat runs for both llm_reference and an extra external LLM
            repeat_ids = json.loads((prep_dir / "repeat-subset-ids.json").read_text(encoding="utf-8"))["subjectIds"]
            llm_run1, llm_run2, llm_run3, raw_logs = [], [], [], []
            codex_run1, codex_run2, codex_run3 = [], [], []
            for row in test_rows:
                sid = str(row["subjectId"])
                repos = (row.get("evidence") or {}).get("repositories") or []
                if not repos:
                    pred = {"subjectId": sid, "modelVersion": "gemini-4-neon-xhigh", "status": "empty", "languages": {}, "topics": {}, "topInterests": [], "evidenceRepos": []}
                else:
                    rid = str(repos[0]["repoId"])
                    topic = (repos[0].get("topics") or ["llm"])[0]
                    pred = {
                        "subjectId": sid,
                        "modelVersion": "gemini-4-neon-xhigh",
                        "status": "ready",
                        "languages": {repos[0].get("primaryLanguage") or "Python": 1.0},
                        "topics": {topic: 1.0},
                        "topInterests": [{"tag": topic, "score": 1.0, "evidenceRepos": [rid]}],
                        "evidenceRepos": [rid],
                    }
                llm_run1.append(json.dumps(pred))
                codex_pred = {**pred, "modelVersion": "codex-6.2-sol-xhigh"}
                codex_run1.append(json.dumps(codex_pred))
                raw_logs.append(json.dumps({
                    "ok": True,
                    "repeatIndex": 1,
                    "subjectId": sid,
                    "provider": "antigravity-isolated-workflow",
                    "executionChannel": "antigravity-run_workflow-isolated",
                    "modelIdentifier": "gemini-4-neon-xhigh",
                    "elapsedMs": 120,
                }))
                if sid in repeat_ids:
                    llm_run2.append(json.dumps(pred))
                    llm_run3.append(json.dumps(pred))
                    codex_run2.append(json.dumps(codex_pred))
                    codex_run3.append(json.dumps(codex_pred))

            p_r1 = tmp_dir / "llm_r1.jsonl"
            p_r2 = tmp_dir / "llm_r2.jsonl"
            p_r3 = tmp_dir / "llm_r3.jsonl"
            p_raw = tmp_dir / "llm_raw.jsonl"
            c_r1 = tmp_dir / "codex_r1.jsonl"
            c_r2 = tmp_dir / "codex_r2.jsonl"
            c_r3 = tmp_dir / "codex_r3.jsonl"
            p_r1.write_text("\n".join(llm_run1) + "\n", encoding="utf-8")
            p_r2.write_text("\n".join(llm_run2) + "\n", encoding="utf-8")
            p_r3.write_text("\n".join(llm_run3) + "\n", encoding="utf-8")
            p_raw.write_text("\n".join(raw_logs) + "\n", encoding="utf-8")
            c_r1.write_text("\n".join(codex_run1) + "\n", encoding="utf-8")
            c_r2.write_text("\n".join(codex_run2) + "\n", encoding="utf-8")
            c_r3.write_text("\n".join(codex_run3) + "\n", encoding="utf-8")

            out_dir = tmp_dir / "dual-llm-out"
            report = run_experiment_pipeline(
                dataset_dir=PILOT_FIXTURE_DIR,
                output_dir=out_dir,
                split="test",
                repeat_subset_size=3,
                llm_predictions_path=p_r1,
                llm_repeat_predictions=[p_r2, p_r3],
                llm_raw_responses_path=p_raw,
                extra_models=[("llm_codex_sol_xhigh", c_r1)],
                extra_model_repeats=[("llm_codex_sol_xhigh", c_r2), ("llm_codex_sol_xhigh", c_r3)],
            )
            self.assertEqual(report["methods"]["llm_reference"]["modelVersion"], "gemini-4-neon-xhigh")
            self.assertEqual(report["methods"]["llm_reference"]["provider"], "antigravity-isolated-workflow")
            self.assertEqual(report["methods"]["llm_reference"]["stability"]["totalCallsPerSubsetSubject"], 3)
            self.assertEqual(report["methods"]["llm_codex_sol_xhigh"]["stability"]["totalCallsPerSubsetSubject"], 3)
            md_text = (out_dir / "report.md").read_text(encoding="utf-8")
            self.assertIn("### 5.1 `llm_codex_sol_xhigh`", md_text)
            self.assertIn("### 5.2 `llm_reference`", md_text)


if __name__ == "__main__":
    unittest.main()
