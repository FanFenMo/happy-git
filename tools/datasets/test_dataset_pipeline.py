#!/usr/bin/env python3
"""Unit and integration tests for tools/datasets."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from build_dataset import STANDARD_SCENARIO_PLAN, _allocate_event_quotas, build_dataset
from validate_dataset import validate_dataset


class DatasetPipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.datasets_root = Path(__file__).resolve().parent

    def test_pilot_determinism_and_derived_profile_replay(self) -> None:
        with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
            dir1 = Path(tmp1) / "pilot1"
            dir2 = Path(tmp2) / "pilot2"
            replay_input = Path(tmp1) / "derived.jsonl"
            replay_input.write_text(
                json.dumps(
                    {
                        "subjectId": "subj_pilot_0001",
                        "profileVersion": "client-v2",
                        "topLanguages": ["Java", "TypeScript"],
                        "topTopics": ["hadoop", "vue"],
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            m1 = build_dataset(
                scale="pilot",
                catalog_mode="synthetic_fixture",
                output_dir=dir1,
                datasets_root=self.datasets_root,
                derived_profiles_input=replay_input,
            )
            m2 = build_dataset(
                scale="pilot",
                catalog_mode="synthetic_fixture",
                output_dir=dir2,
                datasets_root=self.datasets_root,
                derived_profiles_input=replay_input,
            )

            r1 = validate_dataset(dir1)
            r2 = validate_dataset(dir2)
            self.assertTrue(r1["valid"], r1["errors"])
            self.assertTrue(r2["valid"], r2["errors"])

            map1 = {f["path"]: f["sha256"] for f in m1["files"]}
            map2 = {f["path"]: f["sha256"] for f in m2["files"]}
            self.assertEqual(map1, map2)
            self.assertIn("evaluation-only/derived-profiles-replay.jsonl", map1)

    def test_standard_scale_quotas_and_stratification(self) -> None:
        subjects_plan = []
        seq = 1
        for scenario, n_train, n_val, n_test in STANDARD_SCENARIO_PLAN:
            for split_name, cnt in (("train", n_train), ("validation", n_val), ("test", n_test)):
                for _ in range(cnt):
                    subjects_plan.append(
                        {
                            "subjectId": f"subj_standard_{seq:04d}",
                            "split": split_name,
                            "scenario": scenario,
                            "seq": seq,
                        }
                    )
                    seq += 1
        self.assertEqual(len(subjects_plan), 1000)
        self.assertEqual(sum(1 for s in subjects_plan if s["split"] == "train"), 800)
        self.assertEqual(sum(1 for s in subjects_plan if s["split"] == "validation"), 100)
        self.assertEqual(sum(1 for s in subjects_plan if s["split"] == "test"), 100)

        quotas = _allocate_event_quotas(subjects_plan, 200000)
        self.assertEqual(sum(quotas.values()), 200000)

    def test_multi_file_real_catalog_dedup_and_stratified_freeze(self) -> None:
        taxonomy = json.loads((self.datasets_root / "taxonomy.json").read_text(encoding="utf-8"))
        domains = taxonomy["domains"]
        with tempfile.TemporaryDirectory() as tmp:
            catalog_dir = Path(tmp) / "exports"
            catalog_dir.mkdir(parents=True, exist_ok=True)
            batch1, batch2 = [], []
            for idx in range(1, 261):
                dom = domains[idx % len(domains)]
                lang = dom["primaryLanguages"][idx % len(dom["primaryLanguages"])]
                topics = dom["topics"][:2]
                row = {
                    "kind": "repository",
                    "schemaVersion": "1.0.0",
                    "repoId": str(500000 + idx),
                    "fullName": f"real-org-{idx % 10}/repo-{idx:03d}",
                    "ownerLogin": f"real-org-{idx % 10}",
                    "name": f"repo-{idx:03d}",
                    "visibility": "public",
                    "sourceKind": "github_public",
                    "primaryLanguage": lang,
                    "topics": topics,
                    "starCount": 12000 if idx % 3 == 0 else (1500 if idx % 3 == 1 else 120),
                    "forkCount": 80,
                    "description": f"Real public {lang} repo for {topics[0]}",
                    "readmeText": f"# repo-{idx:03d}\nReal collected README body for {topics[0]}.",
                    "updatedAt": 1794000000000 - idx * 1000,
                    "observedAt": 1794000000000,
                }
                if idx <= 150:
                    batch1.append(row)
                else:
                    batch2.append(row)
            # Duplicate repoId 500001 with newer observation & updated stars in batch2
            newer = dict(batch1[0])
            newer["starCount"] = 99999
            newer["observedAt"] = 1794050000000
            batch2.append(newer)

            (catalog_dir / "batch-01.jsonl").write_text(
                "\n".join(json.dumps(r) for r in batch1) + "\n", encoding="utf-8"
            )
            (catalog_dir / "batch-02.jsonl").write_text(
                "\n".join(json.dumps(r) for r in batch2) + "\n", encoding="utf-8"
            )

            out_dir = Path(tmp) / "pilot-real"
            manifest = build_dataset(
                scale="pilot",
                catalog_mode="real",
                output_dir=out_dir,
                datasets_root=self.datasets_root,
                repo_catalog_paths=[catalog_dir],
                behavior_source_mode="llm_synthesized",
            )
            self.assertEqual(manifest["status"], "ready_for_formal_experiment")
            self.assertEqual(manifest["behaviorSourceMode"], "llm_synthesized")
            self.assertEqual(manifest["catalogIngestion"]["rawRowCount"], 261)
            self.assertEqual(manifest["catalogIngestion"]["duplicateRowCount"], 1)
            self.assertEqual(manifest["catalogIngestion"]["deduplicatedRepositoryCount"], 260)
            self.assertEqual(manifest["counts"]["repositories"], 240)
            self.assertEqual(manifest["counts"]["syntheticFixtureRepositoriesIncluded"], 0)
            report = validate_dataset(out_dir, strict_real=True)
            self.assertTrue(report["valid"], report["errors"])
            repos_written = [
                json.loads(l)
                for l in (out_dir / "canonical" / "repositories.jsonl").read_text(encoding="utf-8").splitlines()
                if l.strip()
            ]
            by_id = {r["repoId"]: r for r in repos_written}
            if "500001" in by_id:
                self.assertEqual(by_id["500001"]["starCount"], 99999)


if __name__ == "__main__":
    unittest.main()
