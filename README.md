# Happy Git (开源项目个性化推荐与沉浸式展示系统)

基于开发者兴趣画像的开源项目发现与类短视频卡片流展示系统，结合 **Hadoop MapReduce 离线计算与回流学习**、**Spring Boot `/api/v2` 在线服务** 以及 **Windows (Electron) / Android (Capacitor) 双端原生客户端**。

> 📌 **总交付导航**：完整的项目架构、数据规范、实验报告、双端构建与验收记录、部署入口、演示指南及各模块最终状态总表，请直接查阅 **[最终交付索引 (`docs/delivery/README.md`)](docs/delivery/README.md)**。

---

## 🧭 快速导航

| 主题 | 入口文档 | 说明 |
| :--- | :--- | :--- |
| **总交付索引与模块状态** | [docs/delivery/README.md](docs/delivery/README.md) | 全项目可导航交付总表（区分已完成与待外部条件项） |
| **端到端演示指南** | [docs/delivery/演示指南.md](docs/delivery/演示指南.md) | 按“数据与首版模型 → 客户端行为 → 离线画像与搜索 → 回流再训练”四段式组织 |
| **独立画像对比实验报告** | [docs/experiments/第三轮画像对比实验报告.md](docs/experiments/第三轮画像对比实验报告.md) | 冻结协议、100 用户基线实测与 SVG 图表、20×3 波动抽样与 4 类匿名盲评 |
| **双端构建与真机验收** | [docs/delivery/双端构建与真机验收记录.md](docs/delivery/双端构建与真机验收记录.md) | `v1.2.0` 构建链、公开地址预置、升级保留与原生验收清单 |
| **双端登录与公开配置** | [docs/github-login.md](docs/github-login.md) | 本地 GitHub 网页会话 + 可选云端 `/api/v2` 应用会话架构与零用户配置规范 |
| **数据集规范与工具链** | [数据集生成要求.md](数据集生成要求.md) / [tools/datasets/README.md](tools/datasets/README.md) | 多批真实目录接入去重、8 项红线校验与 `evidence-views` 生成 |
| **独立评测运行器** | [tools/experiments/README.md](tools/experiments/README.md) | 对齐本地基线、服务端固定基线、学习模型与独立大模型 |
| **服务端与数据平台** | [data-platform/README.md](data-platform/README.md) / [deploy/ubuntu/README.md](deploy/ubuntu/README.md) | Java MapReduce、HDFS/YARN/ZK 部署与 [画像训练与回流交接](docs/implementation/画像训练与回流交接.md) |
| **架构设计与历史验证** | [docs/design/v1/README.md](docs/design/v1/README.md) / [第二轮集中验收](docs/validation/2026-11-17-round-two-integration.md) | 函数级设计文档、SDD 与各轮实测验收日志 |

---

## 📲 客户端构建与安装（v1.2.0）

| 平台 | 构建入口 | 说明 |
| :--- | :--- | :--- |
| **Android 手机端 (`.apk`)** | GitHub Actions [`.github/workflows/build-apk.yml`](.github/workflows/build-apk.yml) 或 `cd client && npm run build:release && npx cap sync android && cd android && ./gradlew assembleDebug` | `versionName="1.2.0"`、`versionCode=3`，覆盖旧版升级保留 SQLite 历史与缓存，附 `.sha256` 与 `release-manifest-android.json` |
| **Windows 电脑端 (`.exe` / `.zip`)** | `cd client && npm run build:win`（运行打包产物或双击 `启动HappyGit桌面端.bat`） | 打包为 `HappyGit-v1.2.0-win-x64.zip`，内置预置公开地址配置与 `.sha256` 校验清单 |

> 服务地址由维护者通过 `client/public-config.json` 或仓库变量 `HAPPYGIT_API_BASE_URL` 在构建期预置，普通用户无需手动填写 API 地址或应用密钥。详细构建与校验流程见 [双端构建与真机验收记录](docs/delivery/双端构建与真机验收记录.md)。

---

## 🎯 系统核心能力

- **开发者兴趣画像与持续回流学习**：基于 Hadoop MapReduce 离线拟合 8192 维同构特征空间与球面兴趣中心，支持独立模型推断、回流样本重建、版本验证、原子发布与回退。
- **云端画像驱动有界搜索与本机接续排序**：客户端校验特征空间 SHA-256 摘要，以单轮最多 4 查询 / 8 页有界搜索发现训练目录之外的真实 GitHub 项目，并严格区分 `acceptedThrough` 与 `processedThrough` 接续未处理近期行为与 24h 已看降权。
- **类短视频项目证据卡片与群体分析**：项目卡片突出用途线索、README 安装片段、许可证与维护时间，Star 明确标注为“关注度 ⭐”而非质量评分；个人空间区分真实状态并提供 `<10` 抑制的独立群体分布视图。
- **可复现的独立画像评测体系**：支持本地基线、服务端固定基线、学习模型（含初版与回流版）及独立通用大模型的同证据哈希对比、20 用户×3 次独立重复波动评估、SVG 图表与 4 类匿名盲评核查。

---

## 📁 目录结构

```text
happy-git/
├── .github/workflows/   # GitHub Actions CI/CD (双端 Windows/Android 打包与 SHA-256 摘要生成)
├── client/              # 跨平台客户端 (Vue 3 + Electron + Capacitor Android + SQLite + Worker)
│   ├── android/         # Android 原生工程 (SQLite v4 / 原生桥接 / Gradle 工程)
│   ├── electron/        # Windows 桌面主进程 (SQLite v3+R2 / 云端同步与画像缓存 / 安全存储)
│   ├── scripts/         # 公开配置预置、页面脚本生成、打包与发布摘要脚本
│   ├── shared/          # 双端共享契约、GitHub 页面解析规范化、8192 维同构特征与重排算法
│   ├── src/             # Vue 3 + Pinia 发现流、个人画像、群体分布与设置管理界面
│   └── tests/           # Node 契约与核心逻辑测试集
├── server/              # Spring Boot 业务后端 (`/api/v2` 会话、事件接收、画像/搜索计划/群体接口)
├── data-platform/       # Java 采集器、HDFS/ZK 租约、MapReduce 训练/推断/导出流水线与管理台
├── deploy/ubuntu/       # 2—4 节点 Ubuntu 集群配置、systemd 定时器与发布脚本
├── tools/
│   ├── datasets/        # 实验数据集构建（含多批真实目录去重）、evidence-views 与 8 项校验器
│   └── experiments/     # 独立画像对比运行器、指标、防泄漏提示词、SVG 图表与匿名盲评工具
├── docs/                # 交付总索引、架构设计、实验报告、验收记录与演示指南
├── 启动HappyGit桌面端.bat # Windows 桌面端本地启动脚本
└── README.md
```

---

## 🌿 分支开发规范 (Git Flow)

- `main`：稳定发布分支，仅接收通过集中集成与发布验收的版本；
- `develop`：主开发集成分支，各轮功能分支与缺陷修复分支的汇聚点；
- `feature/*` / `bugfix/*`：按轮次功能与独立缺陷创建的开发分支，不将沟通用临时编号写入代码、提交、PR 或文档正文。
