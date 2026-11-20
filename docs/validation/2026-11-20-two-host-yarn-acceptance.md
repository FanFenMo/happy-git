# HappyGit 双主机 YARN 分布式训练、跨节点并行取证与导出验收记录（2026-11-20）

本记录汇总在真实双物理机局域网集群（主机 A `hg-1` + 主机 B `hg-2`，Ubuntu 22.04 WSL2 镜像网络）上完成的 10,000 真实公开项目标准规模 YARN 分布式训练、固定测试集导出、跨节点 TaskAttempt 时间重叠取证与学习任务取消/重试验收。完整运行日志、模型制品与取证文件保存在验证机 `output/two-host-20261120-212158/`。

---

## 一、双主机真实集群拓扑与前置状态

- **部署模式**：`two-host-limited`（明确记录：双主机模式保留 `hg-1` 控制面单点，不宣称具备三节点 HA 自动故障切换）。
- **节点清单**（验证机 `output/local-acceptance-20261120/inventory.two-host.actual.json`）：
  - `hg-1`（`10.122.223.71`）：NameNode、DataNode、ResourceManager、NodeManager（2048 MB / 2 vCores）、HistoryServer、ZooKeeper、Console（`8090`）、Business API（`8080`，JDK 17 + MySQL 8.0 端口 `3307`）
  - `hg-2`（`10.122.238.183`）：DataNode、NodeManager（2048 MB / 2 vCores）
- **前置连通核对**：Windows + Hyper-V 防火墙双向放行对端实际 IP 后，HDFS 两个 DataNode 均 `In Service`（总块 `239,424`，**`missingBlocks = 0`**，非 Safemode），YARN 两个 NodeManager 均 `RUNNING`（集群总容量 `4096 MB / 4 vCores`）。

---

## 二、双主机 YARN 分布式训练与 92 作业跨节点并行取证

- **输入数据集**：51 批真实公开采集目录分层冻结的 `hg-standard-real-20261103`（10,000 真实公开仓库、800 train / 100 validation / 100 test、200,000 规则浏览、2,000 集合记录），通过 `learning-prepare` 写入 HDFS `hdfs://hg-1:8020/happygit/experiments/two-host-20261120-205358/dataset`（`dataset.json` SHA-256 `af51e0fc7d8a61f964115a80cbbf6820a3a98025d67ec8856cc0b9c68ad61911`）。
- **WLAN 瞬断重试加固**：针对 Wi-Fi 环境下跨主机长链路偶发 `Connection reset by peer` 导致 AM 写 `.jhist` 中断及双节点 HDFS 写入镜像管线报错的问题，通过作业配置覆盖层启用 `dfs.client.retry.policy.enabled=true`（`1000,15,5000,15`）、`ipc.client.connect.max.retries=20` 与双节点写入容错 `dfs.client.block.write.replace-datanode-on-failure.policy=NEVER`（随 `job.xml` 同步分发到 `hg-1` 与 `hg-2`）。
- **训练结果**（`framework=yarn`，`state=validated`，总耗时 `3,326.4s`）：
  - **产出模型版本**：`portrait-a43992293a479d9c8b70d9a7`
  - **制品 SHA-256**：`fe20584983730fc782d8ade1e260a2508ab33aa10526a66edabe1f6a60aadd98`
  - **特征空间 SHA-256**：`fb6cd68c9ff3229f29d3e0ca62c5b9b5671835988b69a4524e329a924c328f69`
  - **多行为网格验证选参**（84 名时间留出验证用户，12 组候选，`testUsed=false`）：选中 `browseHalfLifeDays=60, starWeight=2, ownedWeight=1.5`、`centerCount=4`、`directionBlend=0.0`，验证留出余弦 **`0.709545`**（优于固定基线 `30d/3/1.5` 的 `0.708490`）。
- **跨节点并行取证**（`collect_model_run.py --require-parallel`，证据：`output/two-host-20261120-212158/yarn-evidence-training/run-evidence.json`）：
  - `state = "complete"`、`allJobsSucceeded = true`、**`parallelExecution = "proven"`**
  - 总 YARN 作业数：**92 个**，其中 **84 个作业存在真实跨节点成功 TaskAttempt 时间重叠**（最大重叠 **`13,519 ms`**，位于 `job_1795176983630_0058` `J03-terms`）
  - 节点负载均衡：成功 TaskAttempt 分布为 **`hg-1: 274`、`hg-2: 253`**；总资源消耗 **`4,259,551 memorySeconds` / `8,023 vcoreSeconds`**。

---

## 三、`ModelExport` 缺陷拦截修复与 21 作业固定测试集导出取证

- **实测发现并修复的隐蔽缺陷（`develop@e8e6709`）**：
  - 首次对 `portrait-a43992293a479d9c8b70d9a7`（选中 `60d/2/1.5`）运行 `learning-export` 时，审计数发现独立基线分支产出的 `baseline_mr_fixed_v1` 空画像用户由 3 人异常升至 9 人（6 位 `star_only` 用户丢失 Star 集合）。
  - 定位为 `ModelExport.java` 第 71 行在模型行为参数不同于固定基线 `(30, 3, 1.5)` 而走独立基线归一化分支时，遗漏设置 `baseline.setLong("hg.referenceTime", ...)`，导致 `LearningJobs.InputMap` 以 `now=0` 过滤掉全部 `collection`。
  - 修复该行并在 `LearningLoopIntegrationTest` 新增 `modelExportBaselinePreservesCollectionsWhenBehaviorDiffersFromFixedRules` 回归测试（已通过并提交 `e8e6709`），重编 `happygit-data-platform-1.0.0.jar` 后在双主机 YARN 上重新完成 `learning-export`。
- **修复版导出与并行取证**（证据：`output/two-host-20261120-212158/yarn-evidence-export-fixed/run-evidence.json`）：
  - `state = "complete"`、`allJobsSucceeded = true`、**`parallelExecution = "proven"`**
  - 总 YARN 作业数：**21 个**，其中 **20 个作业存在真实跨节点时间重叠**（最大重叠 **`19,278 ms`**，位于 `job_1795176983630_0178` `L00-canonical`）
  - 节点负载均衡：成功 TaskAttempt 分布为 **`hg-1: 59`、`hg-2: 63`**；总资源消耗 **`817,357 memorySeconds` / `1,523 vcoreSeconds`**。
  - `baseline.jsonl` 与 `learned.jsonl` 均准确导出 100 位测试用户，空画像严格为 3 位 `no_evidence` 用户（0 幻觉引用、100% 证据有效率），完整对比指标已同步至 [第三轮画像对比实验报告](../experiments/第三轮画像对比实验报告.md) 与 [standard-real-round3-yarn/report.md](../../tools/experiments/generated/standard-real-round3-yarn/report.md)。

---

## 四、真实客户端事件回流 → 双主机 YARN 再训练 → live API 换版/回退全闭环

基于升级至 `happygit-v1.2.0-two-host-r2`（`develop@5694818`，SHA-256 `725bbfd307415dbd4bf3c3358372fba7cfef59fb8fa0441cae1896a19f03ad5e`，主机 A 零中断热升级后 `api`/`console` 均返回 `r2` 代际且双机 HDFS/YARN 未断连）的环境，完整实测了回流再训练与模型换版/回退（完整证据位于验证机 `output/two-host-retrain-20261120/`）：

1. **原生客户端回流输入准备**：
   - 驱动真实 Electron `database-worker.cjs` 对 10,000 真实目录中的 8 个仓库记录 9 次浏览（含 1 次 10 秒内重复打开，实测被 30s 去重拦截），生成 **8 条**带真实 SHA-256 `payloadHash` 的 `client_authenticated` 规范事件（`subjectId = client_native_feedback_001`），并单独保存指向首版模型 `portrait-a43992293a479d9c8b70d9a7` 的 `derived-profiles.jsonl` 血缘记录（不充当监督真值）。
   - 组装新训练快照 `hg-standard-real-20261103-retrain-r1`（`dataset-0ba16bed6d17ceb34a3ad71c`）：`train` 由 800 人增至 **801 人**（`client_authenticated_subject=1`、`client_authenticated_event=8`），原 100 名 `validation` 与 100 名 `test` 用户保持严格冻结不变。
2. **双主机 YARN 回流再训练与导出并行取证**：
   - **回流再训练（41 个 YARN 作业，耗时 `1,009.1s`）**：产出新模型 **`portrait-101f749d459768596fbb3275`**（制品 SHA-256 `72f951dec2d5bf02630c895c2330b56d7d82c556cd11e09cc2df76dcaf6c2905`），聚类中心成员由首版 `[273, 153, 337, 13]` 真实演化为 **`[255, 153, 357, 12]`**；`collect_model_run.py --require-parallel` 返回 `state=complete`、`allJobsSucceeded=true`、**`parallelExecution=proven`**（**38/41** 作业有跨节点重叠，最大重叠 **`86,970 ms`**，`hg-2: 140` / `hg-1: 106`，`1,373,375 memorySeconds` / `2,546 vcoreSeconds`）。
   - **回流版固定测试集导出（11 个 YARN 作业）**：`state=complete`、`allJobsSucceeded=true`、**`parallelExecution=proven`**（**10/11** 作业有跨节点重叠，最大重叠 **`11,891 ms`**，`hg-1: 27` / `hg-2: 36`，`290,394 memorySeconds` / `525 vcoreSeconds`）。
   - **固定测试集回归验证**：接入 `run_experiment.py --extra-model learned_retrained=...` 完成四方对照（`baseline_local_v1`、`baseline_mr_fixed_v1`、`learned_model`、`learned_retrained`），小样本原生回流（1 人 / 8 事件）下新版本在 100 位冻结测试用户上保持无退化（`nDCG@8=0.4463`、`语言余弦=0.9981`、`主题余弦=0.9157`、`0` 幻觉引用，如实记录小样本规模、不夸大效果提升）。
3. **live `happygit-api`（MySQL `3307`）模型登记、发布、换版与回退全事务实测**（证据：`output/two-host-retrain-20261120/model-lifecycle-verification.json`，隔离实验命名空间 `experiment-two-host-20261120-205358`）：
   - 依次执行 `register(首版)` → `publish(首版, rev=1)` → `register(回流版)` → `publish(回流版, rev=2)` → `rollback(首版, rev=3)` → `publish(回流版, rev=4)`，全部返回 HTTP `200`，MySQL `learning_model_events` 完整留存 4 条不可变审计事件记录。

---

## 五、学习任务精确取消与重试实测（ZooKeeper 实机验证）

在隔离命名空间 `experiment-cancel-check-20261120` 对真实 ZooKeeper 执行 `learning-submit` → `learning-task --action show` → `--action cancel --attempt 0` → `--action retry --attempt 0` 全流程实测（证据：`output/two-host-20261120-212158/task-cancel-retry-evidence.json`）：
- 原任务 `51b1fc9a5f22e8aae79be4d344055aa5362bce8a267eed0579238ce67d654c72` 由 `queued` 精确迁移至 `cancelled`（记录 `cancelReason` 与 `finishedAt`）；
- `--action retry` 创建关联原任务的新任务 `66405b7630876f041e3cf9a026c50cb6ed383bce52df9189bcdd7877c572794f`（保留 `retryOfTask` 与 `retryReason`，不覆盖原取消记录），验证后已清理为 `cancelled`。

---

## 六、剩余待办项（明确边界）

1. **外部通用大模型对照与人工盲评**：配置外部大模型 API 凭据后，直接针对 `output/two-host-20261120-212158/server-export-fixed` 与 `output/two-host-retrain-20261120/server-export-retrained/learned.jsonl` 执行 100 test + 20×3 重复波动调用，并完成 15 例匿名盲评工作表标注与解盲回写。
2. **正式公开 HTTPS 域名 + GitHub OAuth 生产构建与真机联网验收**：注入正式公开 HTTPS 域名与 GitHub OAuth 凭据重构建双端安装包，完成真机联网登录、30s 去重上传、指定测试仓库 Star 及恢复与演示彩排。
3. **可选扩展与最终发版**：若需三节点 HA 证明需另行准备三台独立主机执行多数派/fencing/切换演练；全部验收闭环完成后再按指令将 `develop` 合并至 `main`。
