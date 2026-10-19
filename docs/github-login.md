# GitHub 网页登录与会话生命周期说明

本文档依据 2026-10-19 架构规范编写，阐明 HappyGit 的真实 GitHub 网页会话接入机制、双端原生容器架构与会话状态机。

---

## 一、架构定位与设计原则

HappyGit 彻底摆脱对公网独立授权服务器与后端服务的依赖。应用作为安装后直接运行的本地客户端，由用户通过应用管理的真实 GitHub 网页窗口直接登录，产品统一称为 **“GitHub 登录”**。

1. **真实网页会话（Local Web Session）**：
   - 登录过程由 GitHub 官方网页提供界面、密码验证、两步验证（2FA）与安全验证；
   - HappyGit 不制作任何替代登录表单，不收集密码、验证码、恢复码或 WebAuthn 凭据；
   - 严禁要求用户配置服务器地址、注册第三方 OAuth App / GitHub App、获取访问令牌或编辑配置文件。
2. **本地后端与安全隔离**：
   - 前端（Vue 3 / Pinia）仅负责展现与意图提交，不直接接触 Cookie，不执行任意抓取脚本；
   - 网页导航、身份识别探针、Cookie 管理与数据提交完全由两端本地后端受控执行。

---

## 二、双端网页容器与会话隔离

### 1. Windows 端 (Electron)
- **专用持久分区**：主进程使用专用 `persist:happygit-github` partition 隔离 GitHub 会话，所有 Cookie 和缓存持久化保存在应用的 `userData` 目录下，不干扰系统 Chrome / Edge 浏览器；
- **登录窗口 (`github-browser.cjs`)**：
  - 采用无主界面 preload、关闭 Node 集成、开启 contextIsolation、sandbox 与 webSecurity 的安全 BrowserWindow；
  - 顶部由原生窗口栏固定显示真实网址（如 `https://github.com/login`），防范钓鱼与地址欺骗；
- **后台工作页**：单一复用同 partition 的隐藏工作页，仅在需要同步资料、公开仓库与 Star 时调度导航，空闲时不发起无谓请求。

### 2. Android 端 (Capacitor)
- **独立登录 Activity (`GitHubLoginActivity.java`)**：
  - 作为标准原生 Activity 启动，承载专用普通 Android WebView；
  - 严禁注入 Capacitor Bridge 或 JavaScriptInterface，切断对本地原生能力的直接暴露；
  - 顶部原生工具栏清晰展示当前访问域名与关闭按钮；
- **应用内会话共享 (`GitHubWebViewHost.java`)**：
  - 登录 WebView 与后台工作 WebView 运行在同一应用进程内，共享 Android 本应用的 `CookieManager`；
  - 登录完成后后台工作 WebView 自动继承已登录会话，主界面 Capacitor WebView 继续仅加载本地资产，严禁导航到 GitHub。

---

## 三、会话状态机流转

应用维护严格的会话生命周期状态机：

```text
guest --点击登录--> 登录任务 opening / waiting / verifying
登录任务验证成功 --> authenticated
应用重启 --> restoring --> authenticated / offline / reauth_required / guest
authenticated --明确被网站要求登录--> reauth_required
authenticated --仅网络不可用--> offline
offline --复核同一账号成功--> authenticated
任一账号状态 --退出--> logging_out --> guest
```

1. **访客状态 (`guest`)**：
   - 未登录状态，可正常浏览热门项目卡片；
   - 不产生与账号绑定的资料、Star 和私有数据；
2. **登录中 (`opening` / `waiting` / `verifying`)**：
   - 登录任务作为独立任务单例管理，不混入已激活会话；
   - 网页完成加载并通过身份探针识别到当前有效数字账号 ID 时，由原生 `SessionManager.activateIdentity` 事务激活；
3. **已认证 (`authenticated`)**：
   - 拥有有效网页会话与本地账号记录；
   - 允许执行公开集合同步、真实网页 Star 操作、本地历史记录及个性化推荐计算；
4. **离线只读 (`offline`)**：
   - 网络中断时自动降级，保留当前账号本地历史与缓存浏览，禁止向远端发起 Star 写操作；
5. **需要重新验证 (`reauth_required`)**：
   - 网站会话失效或被注销时触发，提示用户重新打开登录窗口完成认证；
6. **登出与清除 (`logging_out` / `guest`)**：
   - **退出登录 (`session.logout`)**：停止后台在途任务，安全清理专用 partition / WebView Cookie，保留本地历史并恢复为 guest 状态；
   - **清除本地数据 (`account.forgetLocalData`)**：在退出登录的基础上，级联删除 SQLite 中该账号的所有资料、集合缓存、浏览记录、偏好与推荐结果。

---

## 四、安全与合规边界

1. **最小权限与范围**：仅读取当前登录用户的公开基本资料、本人公开仓库与公开 Star；私有仓库、组织机密、邮件与 GitHub 内部历史均不纳入采集；
2. **无外传与零云端存储**：所有兴趣画像向量、TF-IDF 特征计算、浏览历史与 MMR 多样性重排均在本地 Web Worker 与 SQLite 中完成，默认绝不上传任何服务器。
