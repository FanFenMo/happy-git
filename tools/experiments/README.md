# HappyGit 独立兴趣画像对比与实验运行器 (`tools/experiments`)

本目录提供文件型兴趣画像评测与多方法对比运行器，用于对齐：
1. **规则加权/本地基线**（`baseline_local_v1`）；
2. **成员甲学习型模型**（`learned_model`，通过结果文件或命令行适配器接入）；
3. **独立通用大模型对照**（`llm_reference`，仅读取公开 `evidence-views` 与 `taxonomy.json`，严格禁止输入 `generator-truth`、`control-cases` 或算法输出）。

---

## 目录文件说明

- `taxonomy_aliases.json`：冻结的语言与主题别名映射表（与 `tools/datasets/taxonomy.json` 同源）。
- `metrics.py`：核心指标与分组统计计算模块（Top-8 标签 P/R/F1/Jaccard/nDCG、非空语言/主题分布 Cosine 与 `1-JSD`、空分布单独评分不补均匀向量、证据引用真实性与幻觉计数、按 `byScenario`/`bySourceKind`/`bySparsity` 统计样本数与失败数、改进/退化/不确定样本统计，以及 4 类匿名盲评汇总）。
- `prompt_builder.py`：大模型提示词构建与输入防泄漏校验（逐条核对 `evidenceHash` 并拒绝包含任何真值/算法字段）。
- `render_charts.py`：零依赖 SVG 图表渲染器，直接由 `report.json` 输出整体指标、分场景与分稀疏度对比图。
- `run_experiment.py`：端到端文件型评测 CLI，支持接入成员甲 `learning-export` 输出目录（`--server-export-dir` 并校验 `run-manifest.json` 摘要）、`--baseline-cmd`、`--learned-cmd`、多版本模型对比（`--extra-model`）、固定 20 用户×总计 3 次独立大模型重复抽样波动评估（`--repeat-subset-size 20 --subset-repeats 3`）及 4 类匿名盲评工作表与解盲统计（`--blind-audit-file`）。
- `test_experiment_runner.py`：防泄漏、空分布/空画像/幻觉审计、外部导出校验、3 次重复抽样波动、匿名盲评解盲与 SVG 图表渲染单元测试。

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

### 4. 第三轮正式多方法对比（接入成员甲 `learning-export` + 回流版模型 + 独立通用大模型 20×3 抽样波动）
```powershell
$env:HAPPYGIT_LLM_API_URL="https://api.example.com/v1"
$env:HAPPYGIT_LLM_API_KEY="***"
$env:HAPPYGIT_LLM_MODEL="model-id"
$env:HAPPYGIT_LLM_PROVIDER="provider-name"

python tools/experiments/run_experiment.py `
  --dataset-dir <path/to/frozen-standard-dataset> `
  --split test `
  --server-export-dir <path/to/initial-learning-export> `
  --extra-model learned_retrained=<path/to/retrained-learning-export/learned.jsonl> `
  --run-llm-api `
  --repeat-subset-size 20 `
  --subset-repeats 3 `
  --blind-review-count 15 `
  --output-dir <path/to/round3-official-report>
```

### 5. 完成人工匿名盲评后解盲回写主报告
1. 审阅 `<output-dir>/blind-review-worksheet.md` 并在 `<output-dir>/blind-review-audit-template.jsonl` 填写四选一分类：`grounded` / `over_inferred` / `nonexistent_citation` / `insufficient_evidence`；
2. 重新运行上述命令并附加 `--blind-audit-file <path/to/filled-audit.jsonl>` 即可自动解盲并将分方法核查结果写入 `report.json` 与 `report.md`。
