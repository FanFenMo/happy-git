#!/usr/bin/env python3
"""Unit tests for the file-based interest portrait experiment runner."""

from __future__ import annotations

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


if __name__ == "__main__":
    unittest.main()
