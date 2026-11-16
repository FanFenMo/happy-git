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


if __name__ == "__main__":
    unittest.main()
