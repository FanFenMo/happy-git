# HappyGit 本机就绪验收与双主机训练准备记录（2026-11-20）

本记录汇总在**单台本机（Windows 桌面 + WSL2 `Ubuntu-22.04` 主机 A `hg-1`）**上于开启主机 B（`hg-2`）之前已实际完成并实测通过的验收项、代码修复、部署代际与本地产物位置。代码基线为 `develop@3d3b26b01f1b0ca3a1d863f37e1f0503f7e79ebd`，完整日志与证据保存在验证机 `output/local-acceptance-20261120/`。

---

## 一、本机完成的代码修正、文档补齐与回归验证

1. **评测运行器修正与真实目录报告同步**：
   - 修正 `tools/experiments/run_experiment.py` 在跨 Windows/WSL 挂载路径下 `current_git_commit()` 返回 `unknown` 的问题，并修正 `report.md` 第 7 节重复 `## 7.` 编号。
   - 重新运行 `tools/datasets/test_dataset_pipeline.py`（**3/3 通过**）、`tools/experiments/test_experiment_runner.py`（**5/5 通过**）及客户端全部 Node 契约与核心单测（**18/18 通过**，含 `server-portrait-contract.test.mjs`）。
   - 基于 2026-11-19 冻结的真实目录标准集 `hg-standard-real-20261103`（10,000 真实公开仓库、100 test 用户）与 `server-export`（`portrait-171b14f41dd3b349e93fbcad`）复跑评测并更新 [第三轮画像对比实验报告](../experiments/第三轮画像对比实验报告.md) 与仓库内 SVG 图表目录 `tools/experiments/generated/standard-real-round3-local/`。
2. **核心方案文档纳入 `develop` 交付体系**：
   - 将 [项目方案.md](../implementation/项目方案.md)、[功能模块任务表.md](../implementation/功能模块任务表.md)、[三轮协作与验收.md](../implementation/三轮协作与验收.md)、[接口与模型契约.md](../implementation/接口与模型契约.md)、`数据集生成要求-服务端版.md` 与 `tools/run_collection_batches.py` 纳入 `develop` 并在 [交付总索引](../delivery/README.md) 补齐导航，所有相对链接校验 0 断链。
3. **Electron 隔离用户目录支持**：
   - 在 `client/electron/main.cjs` 增加可选环境变量 `HAPPYGIT_USER_DATA_DIR`（普通用户默认仍指向系统 `AppData/HappyGit`，不受影响），便于安全执行桌面端全新安装与旧库覆盖升级验收而不污染本机正式数据。

---

## 二、双端原生全新启动与旧版无损覆盖升级实测

### 1. Windows 桌面端（Electron `v1.2.0`）
- **全新安装独立启动**：使用 `HAPPYGIT_USER_DATA_DIR` 隔离目录直接启动 Electron 桌面端，无报错正常初始化 `happygit.db`（`user_version=3`，26 张表）并拉取访客热门缓存（`feed_cache=1`），证据位于 `output/local-acceptance-20261120/win-fresh-launch.log`。
- **真实旧版（`v1.0.0`）SQLite 无损覆盖升级**：复制本机已有 `v1.0.0` 真实数据库（`user_version=2`，17 张表，含 `accounts=1`、`repository_cache=14`、`sync_state=2`、`interest_profiles=1`、`account_preferences=1`、`account_revisions=1`、`recommendation_batches=1`）至隔离目录并启动 `v1.2.0` Electron 桌面端。升级后库自动迁移至 `user_version=3`、26 张表，**全部既有数据 100% 完整保留**，同时自动初始化 `cloud_account_state=1`、`local_sync_state=1`、`recommendation_snapshots=1`（见 `win-upgrade-before.json` / `win-upgrade-after.json`）。

### 2. Android 移动端（API 37 只读模拟器）
- **旧版 `v1.0.0 (versionCode=2)` → `v1.2.0 (versionCode=3)` 原地覆盖升级**：先在 `Medium_Phone_API_37.0` 模拟器安装并启动旧版 `v1.0.0 (versionCode=2)` APK 生成 `happygit.db`，强停后使用 `adb install -r` 原地覆盖安装 `HappyGit-v1.2.0.apk (versionCode=3)` 并启动 `MainActivity`。
- **实测结果**：成功渲染 **23 个** HappyGit 界面节点，**0 次 `AndroidRuntime` 崩溃**；拉出应用沙箱数据库验证已无损升级至 **`user_version=4`、27 张表**（含全部云端画像、事件队列与反馈表，见 `android-upgrade-smoke.log` 与 `android-upgraded-happygit.db`）。

---

## 三、主机 A（`hg-1`）升级至 `v1.2.0`、MySQL + 业务 API 联调与主机 B 升级包准备

1. **打包双主机正式发布包 `happygit-v1.2.0-two-host`**：
   - 基于 `develop@3d3b26b01f1b0ca3a1d863f37e1f0503f7e79ebd` 在 JDK 11 / JDK 17 下重新编译 `happygit-data-platform-1.0.0.jar` 与 `happygit-server-1.0.0-SNAPSHOT.jar`，结合两主机清单（`hg-1=10.122.223.71` 含 `api` + `learningCoordinator`，`hg-2=10.122.209.97`）打包并校验：
     - `happygit-v1.2.0-two-host.tar.gz` SHA-256：`e6c8de1e065316bf516021003fa76ffb56b4b1d60408f0b8162f2ac5851eb4af`
     - `hg-1` `nodeConfigSha256`：`9f5a026650bcf581aa611b808029778a8c1de3a529e1152c0ad5649079c340c0`
2. **主机 A（`hg-1`）无损安装、切换与全栈实测通过**：
   - 使用 `install-release.sh` 与 `activate-release.sh` 完成 `/opt/happygit/current` 切换，**未格式化 HDFS**，原有 239,424 个 HDFS 数据块、`/opt/happygit/conf/platform.env` 及 ZooKeeper `myid` 完整保留。
   - 因 WSL2 镜像网络下宿主机 Windows 已占用 `3306`/`33060`，WSL 内 MySQL 8.0 通过 `/etc/mysql/mysql.conf.d/happygit-port.cnf` 独立监听 `127.0.0.1:3307` 并关闭 `mysqlx`，创建 `happygit` 库与专用账号，凭据私有保存于 `/etc/happygit/cloud.env`（`0640 root:happygit`）。
   - 全部 9 个核心单元（`mysql`、`zookeeper`、`namenode`、`datanode`、`resourcemanager`、`nodemanager`、`historyserver`、`console`、`api`）实测均为 `active`：
     - `happygit-api`（JDK `17.0.20.1`，端口 `8080`）自动执行 Flyway `V1`、`V2` 迁移均成功；未登录请求 `/api/v2/cohorts` 返回 `401 SESSION_REQUIRED`；管理接口 `/api/v2/internal/learning/status` 返回 `200` 且正确回报 `releaseId` / `sourceCommit` / `nodeConfigSha256`；
     - `happygit-console`（端口 `8090`）首页返回 `200`，经 `/api/platform/learning/status` 联调 `happygit-api` 返回 `200`；`data-platform learning-model --action status --namespace production` CLI 返回 `exit 0`；`server_release.py service --action status` 返回 `exit 0`；
     - 实测发现运维注意点：在既有 83,478 条历史采集任务留在 ZooKeeper 的情况下，控制台 `/api/platform/status` 因全量拉取任务列表较慢，学习与模型运维建议优先使用即时响应的 `/api/platform/learning/status` 及 `data-platform learning-*` CLI。
   - 全部验证结果保存在 `output/local-acceptance-20261120/hg1-live-verification.json`，并已优雅停服同步落盘。
3. **主机 B 加入与双机 YARN 训练一键准备就绪**：
   - 已将冻结的 10,000 真实项目数据集预置至主机 A 的 `/var/lib/happygit/datasets/standard-real-frozen`（并链接至 `/var/lib/happygit/datasets/current`）。
   - 已准备好：
     - 主机 A 一键启停脚本：`output/local-acceptance-20261120/启动主机A服务_v1.2.0.cmd` / `停止主机A服务_v1.2.0.cmd`
     - 主机 B 升级包与操作说明：`output/local-acceptance-20261120/B升级包/`（含 `happygit-v1.2.0-two-host.tar.gz`、`.sha256`、`B升级与启动说明.md`）
     - 双主机 YARN 正式训练、分块导出、跨节点并行取证（`--require-parallel`）与独立评测一键脚本：`output/local-acceptance-20261120/run-two-host-yarn-training.sh`

---

## 四、剩余需开启主机 B 或外部条件后完成的事项

1. **双主机 YARN 分布式训练、跨节点并行取证与故障接续**（待开启主机 B `hg-2` 并按 `B升级与启动说明.md` 加入集群后，在主机 A 运行 `run-two-host-yarn-training.sh`）。
2. **外部通用大模型 API 对照（100 test + 20×3 重复波动）与 15 例匿名人工盲评**（待配置 `HAPPYGIT_LLM_API_URL` / `HAPPYGIT_LLM_API_KEY` / `HAPPYGIT_LLM_MODEL` 后运行并回写报告）。
3. **正式公开 HTTPS 域名 + GitHub OAuth 凭据注入、双端正式包重构建及真机联网 11 项业务验收**（含真实账号云端会话绑定、30s 去重上传、指定测试仓库 Star 及恢复初态、真实端上回流再训练换版）。
4. **端到端四段式演示彩排与最终 `develop → main` 合并发布**（按用户后续指令执行）。
