# HappyGit 独立兴趣画像对比与实验运行器 (`tools/experiments`)

本目录提供文件型兴趣画像评测与多方法对比运行器，用于对齐：
1. **规则加权/本地基线**（`baseline_local_v1`）；
2. **成员甲学习型模型**（`learned_model`，通过结果文件或命令行适配器接入）；
3. **独立通用大模型对照**（`llm_reference`，仅读取公开 `evidence-views` 与 `taxonomy.json`，严格禁止输入 `generator-truth`、`control-cases` 或算法输出）。

---

## 目录文件说明

- `taxonomy_aliases.json`：冻结的语言与主题别名映射表（与 `tools/datasets/taxonomy.json` 同源）。
- `metrics.py`：核心指标与分组统计计算模块（Top-8 标签 P/R/F1/Jaccard/nDCG、语言与主题分布 Cosine / `1-JSD`、证据引用真实性与幻觉计数、无证据空画像诚实率，以及按场景 `byScenario`、数据源 `bySourceKind`、稀疏度 `bySparsity` 聚合）。
- `prompt_builder.py`：大模型提示词构建与输入防泄漏校验（逐条核对 `evidenceHash` 并拒绝包含任何真值/算法字段）。
- `run_experiment.py`：端到端文件型评测 CLI，支持 `--baseline-cmd`、`--learned-cmd`、`--blind-review-count`，产出 `run-manifest.json`、`llm-prompts.jsonl`、`predictions/*.jsonl`、`report.json`、`report.md` 及多方法匿名盲评抽查包（`blind-review-sample.jsonl` 与 `blind-review-key.json`）。
- `test_experiment_runner.py`：防泄漏、空画像/幻觉审计、外部 CLI 适配器、匿名盲评导出与端到端报告生成单元测试。

---

## 常用命令

### 1. 运行实验运行器自检单元测试
```powershell
python tools/experiments/test_experiment_runner.py -v
```

### 2. 第二轮准备与验证运行（冻结大模型提示包并生成基线报告，暂不调用外部大模型 API）
```powershell
python tools/experiments/run_experiment.py `
  --dataset-dir tools/datasets/generated/pilot-synthetic-fixture `
  --split test `
  --output-dir tools/experiments/generated/pilot-round2-preview
```

### 3. 接入成员甲学习型模型结果文件进行对比
```powershell
python tools/experiments/run_experiment.py `
  --dataset-dir <path/to/dataset> `
  --split test `
  --learned-predictions <path/to/learned_predictions.jsonl> `
  --output-dir <path/to/output>
```

成员甲的实际文件推断命令为 `learning-infer-file --file <请求JSON> --output <新输出目录>`。请求包含冻结的 `manifest` 和模型 `model` 描述符；命令返回 `profiles` 目录，目录中的 `part-*` 为每用户一行的结果，已携带实际 `modelVersion`、`featureSpaceVersion` 和证据引用。将这些分片合并为 JSONL 后传给上面的 `--learned-predictions`。HDFS 输出可以用 `hdfs dfs -getmerge <profiles目录> <本地结果.jsonl>` 导出。

运行器的 `--learned-cmd` 支持自定义包装命令；包装器负责把上述目录导出到 `{output}` 指定的 JSONL 文件。数据平台没有名为 `infer-file` 的命令，也不直接接受运行器的 `--dataset`、`--split` 参数。训练及推断请求格式见[画像训练与回流交接](../../docs/implementation/画像训练与回流交接.md)。

### 4. 第三轮正式外部大模型对比与重复抽样波动评估
```powershell
$env:HAPPYGIT_LLM_API_URL="https://api.example.com/v1"
$env:HAPPYGIT_LLM_API_KEY="***"
$env:HAPPYGIT_LLM_MODEL="model-id"

python tools/experiments/run_experiment.py `
  --dataset-dir <path/to/frozen-standard-dataset> `
  --split test `
  --learned-predictions <path/to/learned_predictions.jsonl> `
  --run-llm-api `
  --subset-repeats 3 `
  --output-dir <path/to/round3-official-report>
```
