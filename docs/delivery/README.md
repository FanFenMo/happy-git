# HappyGit 最终交付索引与模块状态总表

本文档作为 HappyGit 项目的可导航交付总入口，汇总代码与版本、数据与规范、模型与回流、独立画像对比实验、服务端部署入口、双端构建与真机验收以及端到端演示指南。

A、B 的第三轮交付已合入 `develop`。首版构建、数据冻结、自动化回归及外部环境待验项见 [2026-11-19 首版集成验收记录](../validation/2026-11-19-first-release.md)。下表保留各模块的验收范围。

---

## 一、交付文档导航

### 1. 项目方案、架构设计与契约
- [项目根目录总览 (README)](../../README.md)
- 三轮实施方案与分工契约：[项目实施方案](../implementation/项目方案.md) / [接口与模型契约](../implementation/接口与模型契约.md) / [功能模块任务表](../implementation/功能模块任务表.md) / [三轮协作与验收](../implementation/三轮协作与验收.md)
- [第一版函数级设计文档总览](../design/v1/README.md)
  - [服务端详细设计](../design/v1/服务端详细设计.md)
  - [Hadoop 计算实现详解](../design/v1/Hadoop计算实现详解.md)
  - [客户端详细设计](../design/v1/客户端详细设计.md)
  - [接口与数据契约](../design/v1/接口与数据契约.md)
- 四份系统设计文档（SDD）：[前端 SDD](../sdd/前端SDD.md) / [后端 SDD](../sdd/后端SDD.md) / [数据库 SDD](../sdd/数据库SDD.md) / [Hadoop SDD](../sdd/HadoopSDD.md)
- [双端登录、可选云端应用会话与公开配置说明](../github-login.md)
- 历史基线快照（保留原日期与核对记录）：[2026-11-03 完成情况清单](../roadmap/2026-11-03-完成情况清单.md)、[下一代应用迭代方案](../roadmap/2026-11-03-下一代应用迭代方案.md)

### 2. 数据规范与数据集工具链
- [实验数据集规范 (`数据集生成要求.md`)](../../数据集生成要求.md) / [服务端数据接入规范 (`数据集生成要求-服务端版.md`)](../../数据集生成要求-服务端版.md)
- [数据集工具链使用说明 (`tools/datasets/README.md`)](../../tools/datasets/README.md)
- 真实公开目录缺口诊断样例：[pilot-real-gap/real-catalog-gap-report.json](../../tools/datasets/generated/pilot-real-gap/real-catalog-gap-report.json)
- `pilot` 格式与流水线验证包（显式 `synthetic_fixture`）：[pilot-synthetic-fixture/dataset-manifest.json](../../tools/datasets/generated/pilot-synthetic-fixture/dataset-manifest.json)

### 3. 独立画像对比实验与报告
- [第三轮画像对比实验报告](../experiments/第三轮画像对比实验报告.md)
- [独立实验运行器使用说明 (`tools/experiments/README.md`)](../../tools/experiments/README.md)
- 实测与预览产物及 SVG 图表：
  - **真实公开目录 `standard-real` 三方实测**（10,000 真实仓库、100 test 用户）：[standard-real-round3-local/report.md](../../tools/experiments/generated/standard-real-round3-local/report.md)
  - 历史合成夹具预览：`pilot`（5 test 用户）[pilot-round3-preview/report.md](../../tools/experiments/generated/pilot-round3-preview/report.md) / `standard`（100 test 用户）[standard-round3-baseline-preview/report.md](../../tools/experiments/generated/standard-round3-baseline-preview/report.md)

### 4. 服务端、数据平台与集群部署（成员甲维护入口）
- [数据平台运行说明 (`data-platform/README.md`)](../../data-platform/README.md)
- [Ubuntu 多机部署指南 (`deploy/ubuntu/README.md`)](../../deploy/ubuntu/README.md)
- [云端接入接口](../implementation/云端接入接口.md)
- [第一轮服务端数据接入交接](../implementation/服务端数据接入交接.md)
- [第二轮画像训练与回流交接](../implementation/画像训练与回流交接.md)
- [集群版本部署、固定模型导出与运行验收](../implementation/集群模型交付与验收.md)

### 5. 双端客户端、验收记录与演示指南
- [第一轮客户端与数据工具交接](../implementation/客户端与数据工具交接.md)
- [第二轮客户端画像搜索与评测交接](../implementation/客户端画像搜索与评测交接.md)
- [第三轮客户端与实验交付交接](../implementation/第三轮客户端与实验交付交接.md)
- [第一轮 A/B 集成验证记录 (2026-11-16)](../validation/2026-11-16-round-one-integration.md)
- [第二轮 A/B 集成验证记录 (2026-11-17)](../validation/2026-11-17-round-two-integration.md)
- [第三轮双端构建与真机验收记录](双端构建与真机验收记录.md)
- [端到端项目演示指南](演示指南.md)

---

## 二、功能模块最终状态总表

状态口径说明：
- **已完成并集成验证**：实现已合入 `develop` 且具备对应实测验收日志；
- **代码与单测完成，待集中/外部实测**：代码、工具链与单元测试已就绪，尚缺真实集群作业、大模型 API 凭据、Android 真机或指定测试仓库等外部条件。

| 功能模块 | 主责 | 当前状态 | 已有证据与剩余外部条件 |
| :--- | :---: | :--- | :--- |
| 公共契约与版本对齐 | A 主责 / B 审阅 | 已完成并集成验证 | 第一、二轮集成验证（`2026-11-16` / `2026-11-17`），含 `server-portrait-contract.test.mjs` |
| 现有推荐链路修正 | B | 已完成并集成验证 | `bugfix/recommendation-contract` 合入，客户端推荐回归测试全通过 |
| 广范围公开采集 | A | 已完成首轮采集（含缺口记录） | 第二轮审计确认 51 批导出、75,129 去重公开仓库（73,631 有非空 README），7 项失败缺口待补采 |
| 数据集与共同证据工具 | B | 标准规模冻结包已通过校验 | 51 批目录去重后得到 75,129 个项目，冻结包含 10,000 个公开项目与 200,000 条规则生成浏览事件，严格校验 8 项通过 |
| 云端身份与业务存储 | A | 已完成并集成验证 | MySQL `V1/V2` 迁移、应用会话与设备注册在独立 MySQL 集成测试通过 |
| 客户端逐次行为与上传 | B | 已完成并集成验证 | 双端 SQLite 升级、30 秒去重、`discard` 墓碑、同构 SHA-256、`client_mutation_outbox` 单测与第二轮集成通过 |
| 服务端接收与 HDFS 归档 | A | 已完成并集成验证 | 批量幂等 ACK、三水位分离与归档导出在第二轮集成通过 |
| 初始训练与模型制品 | A | 标准规模本地训练通过 | 10,000 个真实公开项目及模拟行为用于本地 MapReduce 训练，验证通过的模型为 `portrait-171b14f41dd3b349e93fbcad`，待多节点 YARN 复验 |
| 个人离线推断与结果发布 | A | 已完成并集成验证 | 固定模型推断、同代发布与客户端对接验证通过 |
| 回流样本与模型再训练 | A | 机制已集成验证，待真实回流规模验证 | 第二轮已走通 `初始模型 → 原生事件回流 → 再训练 portrait-9c1eaf9435bf526334cc56a3`；待真实部署环境端上回流 |
| 云端画像与本地搜索 | B | 已完成并集成验证 | 同代缓存、8192 维 SHA-256 校验、4 查询 / 8 页有界搜索与 DTO 完整保留通过第二轮集成 |
| 本地排序与近期行为接续 | B | 已完成并集成验证 | `acceptedThrough`/`processedThrough` 分离、未处理近期事件增量与 24h 已看降权、隐藏/恢复及快照防漂移通过测试 |
| 个人群体界面与项目证据 | B | 已完成代码与构建，待真机实测 | `ProfileView` / `TrendingView` / `SettingsModal` 接通多状态、`<10` 抑制、项目用途/安装/关注度与已隐藏恢复 |
| 数据与模型管理工作台 | A | 已完成并集成验证 | 管理台支持采集/训练/推断/发布/回退状态展示；第三轮任务取消与重试随 A 分支集成 |
| 独立画像对比与报告 | B | 标准测试集完成基线与学习模型对照 | 100 名固定测试用户的两份 MapReduce 导出均通过摘要校验并进入评测，外部大模型实调与人工盲评待完成 |
| 真实 Ubuntu 部署与运行核对 | A | 部署包已生成，待实际集群验证 | 双节点示例配置和服务端 JAR 已打包并校验摘要，双机 YARN 并行及三节点 HA 演练待执行 |
| 双端安装包与真实使用验收 | B | 双端验收包构建通过 | `v1.2.0` Windows ZIP 和 Android Debug APK 摘要已核验，APK 通过模拟器启动；正式 HTTPS 配置、覆盖升级及指定仓库 Star 待实际环境验证 |
| 项目说明与最终材料整理 | B 主责 / A 配合 | 首版开发交付已整理 | 统一登录说明、实验报告与演示指南，首版验收记录包含实测范围、构建提交及产物位置 |
