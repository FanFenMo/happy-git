# Happy Git (开源项目个性化推荐与沉浸式展示系统)

基于开发者画像的开源项目推荐与类短视频卡片流展示系统，结合 Hadoop MapReduce 离线计算与在线实时推荐服务。

---

## 📲 安装包直接下载 (Downloads)

| 平台 | 格式 | 下载与安装说明 |
| :--- | :--- | :--- |
| **Android 手机端** | `.apk` | [👉 前往 GitHub Releases 页面直接下载 HappyGit-v1.0.0.apk](https://github.com/FanFenMo/happy-git/releases)（或在 GitHub Actions 产物 Artifacts 中点击下载） |
| **Windows 电脑端** | `.exe` | 本地已编译生成至 `client/release/HappyGit-win-x64/HappyGit.exe`，也可直接双击根目录的 `启动HappyGit桌面端.bat` 或桌面图标直接运行 |

---

## 🎯 项目愿景与架构
- **开发者画像构建**：分析用户开源项目与浏览行为，多维技术标签建模，与 LLM 生成效果对照评测。
- **智能推荐引擎**：融合技术栈兴趣匹配、协同过滤、项目质量评分与近期爆火趋势。
- **类短视频卡片流展示**：重构传统 README 体验，以极速卡片提取痛点、效果演示与上手门槛。
- **全平台支持**：支持移动端（Android / iOS）与桌面端（Windows / macOS / Linux）。

---

## 🌿 分支开发规范 (Git Flow)

本项目遵循敏捷开发与分支规范，主要分支包括：
- `main`：生产稳定发布分支，所有合入必须经过严格测试。
- `develop`：主开发集成分支，各 feature 分支的汇聚点。
- `feature/*`：功能开发分支（如 `feature/v1-client-ui`）。
- `bugfix/*`：缺陷修复分支。

---

## 📁 目录结构规划

```text
happy-git/
├── .github/workflows/   # GitHub Actions CI/CD (自动化构建与发布 Android APK)
├── client/              # 跨平台客户端 (Vue 3 + Electron + Capacitor Android)
│   ├── android/         # Android 原生工程 (供 Gradle 编译 APK)
│   ├── electron/        # Windows 原生桌面端主进程 (无端口本地独立运行)
│   └── src/             # 类抖音个人主页与热门项目流前端源码
├── server/              # 在线后端服务 (Spring Boot / API)
├── mapreduce/           # Hadoop 离线批处理计算任务 (特征工程/推荐计算)
├── docs/                # 项目架构与设计文档
├── 启动HappyGit桌面端.bat # Windows 桌面端极速启动入口
└── README.md
```
