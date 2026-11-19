# HappyGit 服务端画像与推荐实验数据集工具链 (`tools/datasets`)

本目录包含符合根目录 `数据集生成要求.md` 与 `数据集生成要求-服务端版.md` 的确定性数据集生成、共享证据视图构建与结构化校验工具链（纯 Python 标准库实现）。

## 1. 目录结构

- `taxonomy.json`：冻结的公开技术领域分类体系（10 种主流编程语言、8 个公开技术方向、标准主题词表与同义词映射）。
- `sources/repositories-real.jsonl`：已验证的真实 GitHub 公开仓库快照种子（当前包含仓库历史已采集验证的 4 个公开仓库：`apache/hadoop`、`vuejs/core`、`spring-projects/spring-boot`、`apache/spark`）。
- `sources/user-collections-real.jsonl`：真实公开用户 Star / 自有仓库集合快照输入（可选，缺省为空并在 `provenance.jsonl` 中显式标记 `available: false`）。
- `build_dataset.py`：确定性数据集构建器，支持 `--scale pilot|standard` 与 `--catalog-mode real|synthetic_fixture`。
- `build_evidence_views.py`：从 `canonical/` 与 `splits/` 构建 MapReduce 与 LLM 共享的 `evidence-views/{train,validation,test}.jsonl` 并计算规范化 `evidenceHash`。
- `validate_dataset.py`：执行 8 项核心契约校验（文件摘要、规模配额、仓库可见性、31 秒同仓浏览去重间隔、集合唯一性、切分隔离、运行时防泄漏、`evidenceHash` 重算）并输出 `validation-report.json`。
- `generated/pilot-real-gap/`：针对当前真实采集 catalog 缺口生成的结构化缺口报告（`real-catalog-gap-report.json`、`dataset-manifest.json`、`validation-report.json`）。
- `generated/pilot-synthetic-fixture/`：使用 `sourceKind="synthetic_fixture"` 生成并通过全部 8 项契约校验的完整 `pilot` 规模格式与流水线验证包。

## 2. 真实 Catalog 缺口检查 vs 格式演示包 (`synthetic_fixture`)

1. **真实采集多批目录接入与缺口检查（`--catalog-mode real`）**：
   - 支持通过 `--repo-catalog <文件或导出目录>`（可重复指定）直接读取成员甲采集导出的多批 JSONL（例如 51 批采集导出目录），按 `repoId` 保留较新 `observedAt` 去重、统计非空 README 并按领域与热度分层冻结至 `pilot`（240 仓库）或 `standard`（10,000 仓库）规模；
   - 支持 `--behavior-source-mode deterministic_rules|llm_synthesized|real_observed` 显式区分确定性规则生成、外部大模型素材生成与真实观察来源；
   - 当真实公开仓库数量不足目标规模时，构建器**绝不复制已有仓库或伪造 `github_public` README**，而是输出结构化的 `real-catalog-gap-report.json` 与 `dataset-manifest.json`（`status: "blocked_missing_real_catalog"`）。
   ```powershell
   # 接入成员甲真实采集目录生成正式冻结数据集
   python tools/datasets/build_dataset.py `
     --scale standard `
     --catalog-mode real `
     --repo-catalog <path/to/collected-batches-dir> `
     --behavior-source-mode deterministic_rules `
     --output-dir <path/to/frozen-standard-real>
   python tools/datasets/validate_dataset.py --dataset-dir <path/to/frozen-standard-real> --strict-real
   ```

2. **完整格式与流水线演示包（`--catalog-mode synthetic_fixture`）**：
   - 显式使用 `sourceKind="synthetic_fixture"` 合成测试仓库补齐 240（`pilot`）或 10,000（`standard`）规模，生成完整 `canonical/`、`splits/`、`runtime/{train,validation,test}/part-*.jsonl`、`evidence-views/` 与 `evaluation-only/`，供 MapReduce `J01-J12`、证据视图与校验脚本做端到端契约验证。
   ```powershell
   python tools/datasets/build_dataset.py --scale pilot --catalog-mode synthetic_fixture --output-dir tools/datasets/generated/pilot-synthetic-fixture
   python tools/datasets/validate_dataset.py --dataset-dir tools/datasets/generated/pilot-synthetic-fixture
   ```
