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

## 四、学习任务精确取消与重试实测（ZooKeeper 实机验证）

在隔离命名空间 `experiment-cancel-check-20261120` 对真实 ZooKeeper 执行 `learning-submit` → `learning-task --action show` → `--action cancel --attempt 0` → `--action retry --attempt 0` 全流程实测（证据：`output/two-host-20261120-212158/task-cancel-retry-evidence.json`）：
- 原任务 `51b1fc9a5f22e8aae79be4d344055aa5362bce8a267eed0579238ce67d654c72` 由 `queued` 精确迁移至 `cancelled`（记录 `cancelReason` 与 `finishedAt`）；
- `--action retry` 创建关联原任务的新任务 `66405b7630876f041e3cf9a026c50cb6ed383bce52df9189bcdd7877c572794f`（保留 `retryOfTask` 与 `retryReason`，不覆盖原取消记录），验证后已清理为 `cancelled`。

---

## 五、剩余待办项（明确边界）

1. **外部通用大模型对照与人工盲评**：配置外部大模型 API 凭据后，直接针对 `output/two-host-20261120-212158/server-export-fixed` 执行 100 test + 20×3 重复波动调用，并完成 15 例匿名盲评工作表标注与解盲回写。
2. **生产端上真实回流、换版与双端联网真机验收**：注入正式公开 HTTPS 域名与 GitHub OAuth 凭据重构建双端安装包，完成真机联网登录、30s 去重上传、指定测试仓库 Star 及恢复、真实回流再训练换版与演示彩排。
3. **可选扩展与最终发版**：若需三节点 HA 证明需另行准备三台独立主机执行多数派/fencing/切换演练；全部验收闭环完成后再按指令将 `develop` 合并至 `main`。
