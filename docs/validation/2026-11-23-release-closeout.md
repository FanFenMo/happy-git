# HappyGit 首版六方评测与收尾记录（2026-11-23）

100 名冻结测试用户的六方评测已完成。使用 `hg-standard-real-20261103` 的 test 划分、`hg-taxonomy-2026-11-v1` 和 `develop@abc0e447a8065f77b61412e64d76b3d9354e5e35` 的运行器。数据中的仓库为真实公开项目，用户行为与参考标签由冻结规则生成。

| 方法 | Top-8 F1 | nDCG@8 | 主题分布余弦 |
| --- | ---: | ---: | ---: |
| 本地规则 | 0.3048 | 0.4432 | 0.9737 |
| MapReduce 规则 | 0.3059 | 0.4410 | 0.9013 |
| 双机 YARN 首版模型 | 0.3052 | 0.4463 | 0.9157 |
| 双机 YARN 回流版模型 | 0.3052 | 0.4463 | 0.9157 |
| Codex 6.2 sol xhigh | 0.4744 | 0.6234 | 0.6626 |
| Gemini Neon xhigh | 0.4784 | 0.6430 | 0.6815 |

六方各有 100 条主测结果，仓库越界引用为 0。Gemini 首轮由两批 61/39 条合成，再对固定 20 人独立重复两轮，合计 140 条有效预测。原始日志保留 144 次尝试，含 4 次后来重试成功的失败。固定子集三轮的平均 Top-8 标签 Jaccard 为 Gemini 0.8946、Codex 0.8973。Gemini 的两批运行记录使用同一模型标识，账号及工作流记录不同。

验证机的交付目录为 `output/final-acceptance-20261123/`。其中 `README.md` 是交付入口，`portrait-evaluation-6way/` 包含完整报告、图表、运行清单、预测与已完成解盲的盲评审计文件，`predictions-intake-audit.json` 记录合并校验和文件摘要。15 人的匿名盲评（90 条候选）已完成核查并通过 `--blind-audit-file` 解盲回写（`unmatched=0`、`invalid=0`）：`llm_codex_sol_xhigh` 15/15 `grounded`、`llm_reference` 14/15 `grounded`（1 条极稀疏证据不足）、`learned_model` 与 `learned_retrained` 各 13/15 `grounded`（各 2 条极稀疏证据不足、0 过度推断）、`baseline_local_v1` 与 `baseline_mr_fixed_v1` 各 12/15 `grounded`（各 1 条单 Star 过度推断、2 条极稀疏证据不足）；六方均 0 条越界引用。上述六方评测、盲评统计与新 SVG 图表已同步至 [第三轮画像对比实验报告](../experiments/第三轮画像对比实验报告.md) 及仓库内 [standard-real-round3-yarn/report.md](../../tools/experiments/generated/standard-real-round3-yarn/report.md)。

[双主机验收记录](2026-11-20-two-host-yarn-acceptance.md)已覆盖 YARN 初训、回流再训练、服务端发布和回退。[本机就绪记录](2026-11-20-local-readiness.md)已覆盖 Windows 本机与 Android 模拟器的启动和覆盖升级。现有 v1.2.0 双端包的摘要已复核，构建清单中的业务 API 地址为空。正式版仍需配置公开 HTTPS 入口与服务端 OAuth，并按[双端验收记录](../delivery/双端构建与真机验收记录.md)补齐真实账号、真机联网和指定仓库操作的验收。
