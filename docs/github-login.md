# GitHub 网页登录、可选云端应用会话与公开配置说明

本文档对齐 HappyGit `v1.2.0`（双端画像协同版）的真实实现，阐明**本机 GitHub 网页会话**与**可选云端应用会话（`/api/v2`）**的职责边界、公开服务地址预置方式与安全约束。

---

## 一、双会话架构定位

HappyGit 区分两层相互隔离的身份会话，避免混淆本机网页登录与云端画像协同：

1. **本机 GitHub 网页会话（Local Web Session，默认离线可用）**：
   - 登录过程由应用管理的真实 GitHub 网页窗口承载（官方登录页、密码、2FA、Passkey/安全校验均在 GitHub 原页完成）；
   - 应用绝不制作替代登录表单，不收集或上传用户的 GitHub Cookie、密码或私有仓库内容；
   - 仅在本地驱动当前账号的公开资料、自有公开仓库、公开 Star 同步、显式 Star/取消 Star、本地浏览历史与本地基线推荐。
2. **可选云端应用会话（Cloud App Session，`/api/v2/auth/github/*`）**：
   - 仅当用户主动开启“参与云端兴趣画像分析并上传行为”并点击“绑定云端会话”时触发；
   - 由预置公开服务地址的 HappyGit 业务服务完成 GitHub 身份核验，签发仅限应用使用的 `accessToken / refreshToken` 并经原生安全存储加密持久化（Windows `safeStorage` / Android Keystore `AES/GCM`）；
   - 每次上传或读取云端画像前强制核对 `cloudAccountId === localAccountId`，不一致时阻断上传并标记 `CLOUD_ACCOUNT_MISMATCH`。

---

## 二、公开服务地址预置（普通用户零配置）

普通用户在桌面端或移动端安装后**无需手动填写任何 API 地址、OAuth Client Secret 或访问密钥**：

- 维护者在打包前通过 [client/public-config.json](../client/public-config.json) 或 CI 环境变量 `VITE_API_BASE_URL`（GitHub Actions 仓库变量 `HAPPYGIT_API_BASE_URL`）提供单一公开 HTTPS 业务地址；
- `client/scripts/prepare-config.mjs` 在构建时校验正式发布地址合法性（拒绝空地址、`localhost`/`127.0.0.1`/`10.0.2.2`、非 HTTPS、内嵌凭据、查询参数与 hash），严格过滤敏感字段后生成：
  - Windows：`client/electron/config.generated.json`（由 `client/electron/cloud-service.cjs` 自动读取）与 `client/electron/release-metadata.json`；
  - Android：`client/android/app/src/main/res/values/happygit_config.xml`（由 `CloudService.java` 读取 `happygit_api_base_url`）与 `client/android/app/src/main/assets/happygit/release-metadata.json`；
- 未预置云端地址或云端不可达时，本机 GitHub 网页登录、本地历史与本地基线推荐仍可完整运行，云端功能清晰呈现 `unbound` / `offline` 状态。

---

## 三、双端网页容器与凭据隔离

### 1. Windows 端（Electron）
- **专用持久分区**：主进程使用 `persist:happygit-github` 隔离 GitHub 网页会话，不污染系统浏览器；
- **安全登录窗口（`github-browser.cjs`）**：禁用 Node 集成，开启 `contextIsolation`、`sandbox`、`webSecurity`，原生标题栏显示真实访问地址；
- **云端凭据存储（`cloud-service.cjs`）**：优先使用 Electron `safeStorage` 加密存储应用会话令牌，不支持系统凭据库时退回本地独立 AES-256-GCM 密钥。

### 2. Android 端（Capacitor）
- **独立登录 Activity（`GitHubLoginActivity.java`）**：使用原生普通 WebView 承载 GitHub 登录，不注入 Capacitor Bridge 或自定义 `JavascriptInterface`；
- **会话共享与隔离（`GitHubWebViewHost.java`）**：仅登录页与受控后台工作页共享应用内 `CookieManager`，主界面 Capacitor WebView 仅加载本地静态资源；
- **云端凭据存储（`CredentialStore.java` / `CloudService.java`）**：使用 Android Keystore 加密存储应用会话令牌，与本地 SQLite v4 数据库（含账号、历史、事件队列与画像缓存）隔离管理。

---

## 四、会话与数据控制生命周期

```text
guest --GitHub网页登录--> opening / waiting / verifying --> authenticated
应用重启 --> restoring --> authenticated / offline / reauth_required / guest
authenticated --可选绑定云端--> cloudBound (核对 cloudAccountId == localAccountId)
authenticated --退出当前账号--> logging_out --> guest (清理网页会话，保留本地历史)
authenticated --删除本账号本地数据--> 撤销云端本地凭据 + 级联清除该账号 SQLite 全部记录 --> guest
```

设置弹窗严格拆分三类控制边界：
1. **本地浏览历史开关**：控制是否记录本机浏览历史（30 秒同仓去重）；
2. **云端兴趣分析与行为上传开关**：关闭后立即停止事件上传、同步更新云端偏好并将本地云端画像状态置为 `analysis_disabled`；
3. **数据清除范围分离**：
   - **仅清空本地浏览历史**：删除本机历史并将未确认的待上传事件转为 `discard` 墓碑以保持设备序号连续，不重置云端 `analysisEpoch`；
   - **重置云端分析（`analysisEpoch` 递增）**：使旧周期云端事件、集合快照与旧画像失效，同时保留本机浏览历史；
   - **删除本账号本地数据并退出**：登出并级联清除本机该账号全部缓存、历史与凭据。
