# HappyGit 账号接入与本地浏览历史实施方案

编写日期：2026-10-18。设计基线：本地 `develop` 分支，提交 `7c1c0c8`。本轮交付范围为 Windows 桌面端与 Android 手机端的 GitHub 账号授权、个人数据同步、本地浏览历史和小幅视觉调整。本文约定接口、函数职责、数据结构、调用顺序与验收条件，作为后续开发依据。

## 一、现状与本轮边界

当前两端共用 `client/src` 下的 Vue 3、Pinia 与 Tailwind 界面。Windows 通过 `client/electron/main.cjs` 加载本地构建资源，Android 使用 Capacitor 8 原生工程。仓库虽有其他平台的介绍和脚本，但本轮只对 Windows 与 Android 建立完整交付链路，不将其他平台计入已完成范围。

本地 `client/release/HappyGit-win-x64/resources/app` 内的主进程、页面入口及其引用的 JavaScript、CSS 与现有本地构建资源一致。这只能说明打包目录与本地构建目录对应，不能代替真实授权、手机安装或功能验收。本轮设计期间未执行应用业务测试，也未修改应用代码。

现有账号入口不能证明账号归属。`client/src/stores/user.js` 的 `loginWithGitHub(username)` 只请求公开的 `/users/{username}`，即使请求失败也会填入固定资料，最后将 `isLoggedIn` 设为 `true`。该函数还初始化了写死的仓库、Star 和技术标签。`server/.../controller/AuthController.java` 同样只是根据用户名拼装数据，没有真正的认证过程。

浏览历史目前保存在 Pinia 数组中，重启后丢失；`recordBrowse()` 保存“刚刚”这样的展示文本，没有真实时间戳和仓库链接。热门页的收藏按钮只显示成功提示，没有调用 GitHub。个人页的历史、Star 和仓库列表也缺少统一的访问入口。`LoginModal.vue` 中 `await emit('login', ...)` 不能等待父组件异步登录完成，需要一并调整加载状态的归属。

设置页的 Hadoop 集群状态、画像来源和部分隐私文案没有运行依据，本轮应随相关页面一起改为准确描述。公开仓库是否声明许可证也不能用于判断仓库是否私有：公开性依据 `private` 字段，许可证单独展示。

“完整接入个人账号数据”在本轮具体指：已授权账号的真实基本资料、关注与被关注数量、本人全部公开仓库、全部公开 Star、真实 Star 与取消 Star 操作，以及由这些公开数据归纳的技术兴趣。私有仓库、邮箱、组织内部数据、GitHub 资料写入、贡献日历、Hadoop 推荐任务和历史云同步不在本轮范围内。资料缺失时保留空值或显示“未填写”，不得补入虚构职业、地区、数量和技术标签。

浏览历史沿用现有的明确访问语义：用户点击项目标题、查看源码或个人页项目入口时记录一次本机访问。只滚动经过卡片、刷新列表和切换标签不产生历史。本轮不实现停留时长采集，因此同步删除“有效停留”“实时反馈优化”等尚未落地的文案。

## 二、技术选择与模块关系

采用“客户端完成 GitHub 授权和个人数据访问，原生层保管凭据，本机 SQLite 保存历史及缓存”的结构。Vue 负责页面与业务编排；Electron 主进程和 Android 原生插件分别处理授权、带凭据的网络请求、数据库和系统浏览器调用。Spring Boot 保留公开热门项目服务，不接收用户的访问令牌，也不新增一套业务登录会话。

另外两条路径不作为本轮实现：继续使用用户名查询虽然改动少，但只能查看公开资料；由 Spring Boot 全面托管认证则需要增加可用的公网服务、服务器会话及凭据保存，与现有本地独立运行的客户端不匹配。当前选择可以让两个安装包在未启动本地后端时完成账号接入，同时避免在两端分别定义业务规则。

授权使用 GitHub App 的 Device Flow，应用注册时只启用所需的用户权限。与传统 OAuth App 的宽泛仓库权限相比，GitHub App 可以直接按 Star 能力授权。Device Flow 的授权和后续刷新流程不要求将 `client_secret` 放入安装包。授权码流程及轮询约束依据 [GitHub Device Flow 文档](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)。

两端本地数据统一使用 SQLite，不采用 `localStorage` 保存历史。已核对本地 Electron 为 `44.9.0`，内置 Node 为 `24.22.0`，`require('node:sqlite').DatabaseSync` 可用；Windows 不需要增加 `better-sqlite3` 及二进制重编译。Android 使用系统 `SQLiteOpenHelper`。两种实现共用本文表结构和数据契约；跨端共享指代码和规则一致，不表示两台设备自动互传历史。SQLite 接口参考 [Node SQLite](https://nodejs.org/download/release/v24.8.0/docs/api/sqlite.html) 与 [Android SQLiteOpenHelper](https://developer.android.com/reference/android/database/sqlite/SQLiteOpenHelper)。

调用方向固定为：页面 → Pinia action → 前端 service → 平台 adapter → 原生能力。组件不直接调用 `fetch`，不拼接 SQL，不读写凭据。平台 adapter 只转换 Electron IPC 与 Capacitor 插件的调用形式，不复制账号同步、标签计算和界面状态逻辑。

建议增加以下文件。路径代表职责边界，已有同责文件时可合并复用，不为单个表达式拆出工具文件。

```text
client/src/
  platform/index.js                 统一平台能力入口
  platform/electron.js              preload 适配
  platform/android.js               Capacitor 插件适配
  services/auth.js                  登录编排、恢复、切换和退出
  services/account.js               资料、仓库、Star 同步与兴趣计算
  services/history.js               历史访问、查询、删除和清空
  services/projects.js              项目访问与公开热门列表
  models/github.js                 GitHub 原始对象标准化
  stores/user.js                   账号与个人列表的页面状态
  stores/history.js                历史分页、搜索和删除状态
  utils/time.js                    时间戳展示

client/electron/
  main.cjs                         窗口、初始化和 IPC 注册
  preload.cjs                      受限原生接口
  auth.cjs                         Device Flow、刷新、凭据读写
  github.cjs                       固定资源请求与网络状态归一化
  database.cjs                     数据库 worker 的请求代理
  database-worker.cjs              SQLite 连接、事务和领域操作

client/android/app/src/main/java/com/happygit/app/
  MainActivity.java                注册本地插件
  nativebridge/HappyGitPlugin.java Capacitor 方法入口
  nativebridge/GitHubAuth.java     授权、刷新与当前账号
  nativebridge/GitHubClient.java   GitHub 请求
  nativebridge/CredentialStore.java Android Keystore 凭据加密
  nativebridge/HappyGitDbHelper.java 数据库创建与迁移
  nativebridge/LocalRepository.java 本地数据领域操作
```

继续使用现有 JavaScript 和 Java，不在本轮迁移 TypeScript 或 Kotlin。下文类型描述用于明确契约，可通过 JSDoc 表达，不要求新增类型编译链路。

## 三、统一数据结构与原生接口

客户端统一使用 camelCase。GitHub 的 snake_case 只出现在原始响应和 `models/github.js` 的转换函数中。GitHub 用户 ID 与仓库 ID 均转为字符串，作为持久标识；用户名和 `owner/name` 用于展示与请求路径，不作为账号或仓库的数据库主键。

```ts
type AccountProfile = {
  accountId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  bio: string | null;
  location: string | null;
  company: string | null;
  publicRepoCount: number;
  followerCount: number;
  followingCount: number;
  fetchedAt: number;
};

type Repository = {
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  primaryLanguage: string | null;
  topics: string[];
  starCount: number;
  forkCount: number;
  isFork: boolean;
  isArchived: boolean;
  isPrivate: boolean;
  licenseSpdx: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  starredAt: number | null;
  fetchedAt: number;
};

type Session = {
  status: 'guest' | 'authenticated' | 'offline' | 'reauthRequired';
  accountId: string | null;
  contextId: string | null;
  profile: AccountProfile | null;
  verifiedAt: number | null;
};

type PageResult<T> = {
  items: T[];
  nextPage: number | null;
  loadedCount: number;
  complete: boolean;
};

type HistoryEntry = {
  accountId: string;
  repoId: string;
  repository: Repository;
  firstViewedAt: number;
  lastViewedAt: number;
  lastCountedAt: number;
  visitCount: number;
  lastSource: 'trending' | 'stars' | 'projects' | 'history';
};
```

全部本地时间使用 Unix 毫秒时间戳。GitHub ISO 时间在标准化时转换，不将“刚刚”“两天前”存入数据库。仓库主语言缺失时显示“未标注”，不把所有缺失语言改成 Markdown。没有许可证、许可证为 `NOASSERTION` 或未识别时显示“未声明许可证”。`isPrivate` 为真的仓库不进入本轮个人列表和历史快照。

`normalizeProfile(raw, fetchedAt)` 从 `/user` 响应提取上述资料，`displayName` 允许回退到真实 `login`，其余简介、公司和地区保持空值。`normalizeRepository(raw, fetchedAt, starredAt = null)` 处理字段转换，不读取当前登录状态。`normalizeStarredRepository(raw, fetchedAt)` 接受包含 `starred_at` 与 `repo` 的响应对象，复用前一个函数。`normalizeTrendingRepository(raw, source)` 兼容当前 Spring Boot 热门 DTO 与 GitHub 搜索结果，但最终只输出同一种 `Repository`。

所有原生调用返回以下封装，adapter 将失败转换为带 `code` 的业务错误。页面只在实际操作入口显示一次提示，不逐层重复 toast。

```ts
type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: {
      code: string;
      message: string;
      retryAt?: number;
      httpStatus?: number;
    }};

interface NativeBridge {
  invoke(operation: string, payload?: object,
         contextId?: string | null): Promise<BridgeResult<unknown>>;
}
```

Electron preload 只暴露 `window.happyGit.invoke(operation, payload, contextId)`。Android 通过 `registerPlugin('HappyGit')` 调用 `HappyGitPlugin.invoke()`；`platform/index.js` 返回两者统一的 Promise 接口。contextId 由 adapter 从当前会话附加，组件不自行构造。平台识别优先检查 preload 接口，再检查 `Capacitor.isNativePlatform()`。普通浏览器开发环境可以显示公开页面，但账号入口明确显示“请使用桌面端或 Android 客户端”，不在浏览器中制造一套弱化登录流程。

`invoke` 只能接受下表的固定操作名。不得暴露原始 `ipcRenderer`、任意文件路径、SQL 字符串、任意请求地址或读取明文令牌的接口。

| 操作名 | 主要入参 | 返回数据与约束 |
| --- | --- | --- |
| `app.initialize` | 无 | 建库、迁移、恢复用户选择后返回会话和全局设置 |
| `auth.begin` | 无 | `{ challengeId, userCode, verificationUri, expiresAt, intervalMs }` |
| `auth.poll` | `{ challengeId }` | `{ state, nextPollAt, session? }`；令牌不出原生层 |
| `auth.cancel` | `{ challengeId }` | 取消本次原生授权上下文 |
| `auth.restore` | 无 | 在线验证或返回已验证账号的离线会话 |
| `auth.logout` | 无 | 清除凭据及活动账号选择，返回游客会话 |
| `github.request` | `{ resource, args }` | 固定 GitHub 资源的 `{ status, body, headers }` |
| `account.saveProfile` | `{ profile }` | 当前账号资料落库 |
| `account.readSnapshot` | 无 | 当前账号缓存资料、同步状态和兴趣设置 |
| `account.savePreferences` | `{ manualTags, historyEnabled }` | 当前账号偏好 |
| `account.forgetLocalData` | 无 | 删除当前账号全部本地数据并退出 |
| `sync.begin` | `{ kind }` | `{ generationId }`，kind 只允许 repos 或 stars |
| `sync.writePage` | `{ kind, generationId, page, items, nextPage }` | 保存本次同步的一页 |
| `sync.finish` | `{ kind, generationId }` | 原子切换完整缓存并返回总数 |
| `sync.abort` | `{ kind, generationId, errorCode? }` | 丢弃本轮临时缓存，保留上轮完整缓存 |
| `repositories.list` | `{ kind, offset, limit }` | 当前账号活动版本的列表和完整性 |
| `stars.applyConfirmed` | `{ repository, starred }` | 将 GitHub 已确认的 Star 结果写入活动缓存 |
| `history.record` | `{ repository, source, viewedAt }` | 事务写入后返回最新历史条目 |
| `history.list` | `{ cursor, limit, keyword }` | `{ items, nextCursor, total }` |
| `history.delete` | `{ repoId }` | 删除当前账号单个仓库的历史 |
| `history.clear` | 无 | 清空当前账号全部历史 |
| `history.count` | 无 | 当前账号当前保留历史条数 |
| `feed.fetchRemote` | 无 | 请求构建配置中的公开热门后端，不带个人令牌 |
| `feed.read` / `feed.save` | 缓存 key、真实项目列表与抓取时间 | 公开热门快照 |
| `settings.save` | `{ mode }` | mode 为 guest 或 account；不包含凭据 |
| `external.open` | `{ url }` | 系统浏览器打开通过校验的 HTTPS 地址 |

账号相关操作的 `accountId` 由原生当前会话注入，前端不能通过修改入参读取别人的分区。内部数据库函数仍显式接收 `accountId`，便于事务实现和验证；这个参数不是开放给组件任意指定的权限字段。前端调用携带当前 `sessionEpoch` 对应的上下文，原生在账号变更后拒绝旧上下文的写入。

contextId 是原生生成的随机会话版本标识，不是 GitHub 凭据。初次恢复和每次成功切换账号时生成新值；同一运行期间刷新 GitHub access token 不改变它。前端 sessionEpoch 则是只用于丢弃页面异步结果的递增整数。退出、切换和删除账号时，先暂停接收该上下文的新个人操作，取消旧网络结果的后续落库，等待已受理的本地事务完成，再完成会话切换。不要在原生接到调用时检查一次账号后，就允许队列中的迟到网络任务无条件写入。

以下补充结构供函数返回值使用，空值和完整性含义不得自行省略。

```ts
type AuthorizationChallenge = {
  challengeId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
};
type AuthorizationProgress = {
  state: 'pending' | 'slowDown' | 'authenticated' |
         'denied' | 'expired' | 'cancelled';
  nextPollAt: number | null;
  session?: Session;
};
type SyncSummary = {
  kind: 'repos' | 'stars';
  count: number;
  complete: boolean;
  syncedAt: number | null;
};
type CollectionSyncState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  loadedCount: number;
  complete: boolean;
  lastSyncedAt: number | null;
  errorCode: string | null;
  retryAt: number | null;
};
type AccountPreferences = { historyEnabled: boolean; manualTags: string[] };
type AccountSnapshot = {
  profile: AccountProfile;
  preferences: AccountPreferences;
  repoSync: CollectionSyncState;
  starSync: CollectionSyncState;
};
type RepositoryPage = {
  items: Repository[];
  total: number | null;       // 未完成全量同步时为 null
  loadedCount: number;
  complete: boolean;
  nextOffset: number | null;
};
type HistoryCursor = { lastViewedAt: number; repoId: string };
type HistoryQuery = {
  cursor?: HistoryCursor | null;
  limit?: number;
  keyword?: string;
};
type HistoryPage = {
  items: HistoryEntry[];
  nextCursor: HistoryCursor | null;
  total: number;
};
type StarMutationResult = {
  repoId: string;
  starred: boolean;
  confirmed: boolean;
  cacheSaved: boolean;
};
type TrendingResult = {
  items: Repository[];
  source: 'server' | 'github' | 'cache' | 'empty';
  fetchedAt: number | null;
};
type OpenResult = { opened: boolean; historySaved: boolean };
type ApplicationBoot = {
  session: Session;
  mode: 'unset' | 'guest' | 'account';
  shouldPromptLogin: boolean;
};
```

`HistorySource` 是 HistoryEntry.lastSource 的四种取值。`SyncProgress` 返回 kind、去重 loadedCount 和 nextPage。`AccountRefreshSummary` 分别返回 profile、repos、stars 的成功结果或业务错误，不将三个结果压成单一布尔值。`AuthorizationProgress.state=authenticated` 时必须有 session，其余状态不能携带新的个人资料。

错误码限定在真实边界需要的范围：`CONFIG_MISSING`、`AUTH_REQUIRED`、`AUTH_EXPIRED`、`NETWORK_UNAVAILABLE`、`RATE_LIMITED`、`FORBIDDEN`、`NOT_FOUND`、`STORAGE_UNAVAILABLE`、`OPEN_FAILED`、`CANCELLED`、`INVALID_ARGUMENT` 与原生边界的 `INTERNAL_ERROR`。取消、会话过期任务和旧 generation 使用 CANCELLED 静默结束。设备码等待状态使用 AuthorizationProgress，不当作异常弹窗。不要为已经标准化的每个字段重复添加检测，也不要在服务层 catch 后返回一个貌似成功的默认对象。

## 四、授权、恢复和凭据管理

开发前注册一个 HappyGit GitHub App，启用 Device Flow，使用过期用户令牌，并配置用户权限 `Starring: Read and write`；公开仓库元数据只读，不申请 Contents 写权限、私有仓库读取或邮箱权限。应用不依赖 webhook，因此不为本轮配置 webhook 接收服务。客户端只打入公开的 Client ID，配置名为 `VITE_GITHUB_CLIENT_ID`。注册与真实账号授权需要使用有效的 GitHub 应用，不能通过占位 Client ID 完成验收。

原生初始化从受控构建配置取得 Client ID。Electron 可以由 Vite 构建步骤另外生成只包含公开配置的 JSON，主进程按固定路径读取；Android 同步阶段将同一公开值写入 `BuildConfig` 或固定资源。不得让前端每次请求时自由传入另一个 Client ID。缺少配置时授权入口显示“账号授权尚未配置”，游客浏览仍然可用。提交 `client/.env.example` 说明公开配置，真实本机配置继续使用已忽略的 `.env.local`，不填写任何 Client Secret。

配置生成具体放在新增的 `client/scripts/prepare-config.mjs`。函数 `readPublicConfig(mode)` 从 client 根目录加载指定模式的环境配置，并让进程环境优先，仅读取 `VITE_GITHUB_CLIENT_ID`、`VITE_API_BASE_URL` 两项；`writeElectronConfig(config)` 写入 `electron/config.generated.json`，`writeAndroidConfig(config)` 写入 `android/app/src/main/res/values/happygit_config.xml` 并正确转义 XML。两个生成文件加入 .gitignore，不能把整份 process.env 序列化进安装包。

`package.json` 增加 prebuild 执行该生成脚本，build 使用相同的 production 模式；`app:run` 与 `cap:sync` 改为先调用 `npm run build`，避免绕过 prebuild。Windows 打包脚本已经调用 npm run build，保持这一入口。CI 从仓库公开变量 `HAPPYGIT_GITHUB_CLIENT_ID` 注入 `VITE_GITHUB_CLIENT_ID`，后端 origin 按需注入；公开 Client ID 无需作为密钥展示给用户。未配置时可以生成游客可用产物，但交付记录必须标记授权尚未配置，不能算作完整账号接入。

`GitHubAuth.beginAuthorization()` 在原生层生成 `challengeId`，向 `https://github.com/login/device/code` 发起 POST，请求体包含 `client_id` 与 `scope=offline_access`，Accept 使用 JSON。保存返回的 `device_code`、过期时间、最早下次轮询时间和授权上下文。前端只得到用户可见的 `userCode`、验证地址和倒计时，不能得到 `device_code`。

`authService.startLogin()` 调用 `auth.begin`，将弹窗状态设为等待授权，显示“复制验证码”“在浏览器中授权”“取消”。复制仅写入用户验证码；按钮打开 GitHub 返回且通过固定域名检查的验证地址。不能自动把设备码或令牌写入剪贴板，也不在应用内嵌入 GitHub 密码输入页面。Android 用 `ACTION_VIEW` 打开默认浏览器，Windows 用 Electron `shell.openExternal()`。

`authService.pollLogin(challengeId)` 使用串行 `setTimeout`，上一次请求返回后再安排下一次；不能使用可能重叠的 `setInterval`。前端使用原生返回的 `nextPollAt` 调度，原生同时执行最小间隔约束。`authorization_pending` 继续等待；`slow_down` 使用服务返回的新间隔；拒绝、过期、取消分别结束本次等待。GitHub 可能以 HTTP 200 返回授权错误，必须解析响应体。用户取消、关闭弹窗或组件销毁时调用 `auth.cancel` 并清除计时器。轮询状态的协议说明见 [GitHub 授权返回状态](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。

`GitHubAuth.pollAuthorization(challengeId)` 调用 `https://github.com/login/oauth/access_token`，请求 `client_id`、`device_code` 与 `grant_type=urn:ietf:params:oauth:grant-type:device_code`。取得令牌后先请求 `/user`；只有真实用户身份获取成功，才保存新账号凭据、资料和活动账号，并返回 `Session`。网络错误、拒绝或错误验证码不能变成登录成功，也不能填入演示用户。

切换账号时，新的授权过程使用临时凭据，原账号保持可见，个人写操作暂停。只有新账号 `/user` 成功且其本地分区初始化完成后才替换活动会话。取消或失败则恢复原账号。前端用递增的 `sessionEpoch` 丢弃旧账号尚未结束的请求结果；原生用自己的会话版本再次挡住旧操作写入。它们分别保护页面状态和持久数据，不以“当前用户名是否相同”判断请求归属。

`commitAuthorizedAccount()` 先保存新账号公开资料和默认偏好，再保存加密凭据与活动选择，全部完成后才返回新 session。候选 `/user` 请求由原生内部 `executeForToken()` 使用临时令牌执行，不能误用旧账号的 ensureAccessToken。两端原生各自实现一个小的 `mapVerifiedUser()`，字段严格对应 AccountProfile；它只做认证身份的机械映射，列表同步与兴趣计算仍在共享前端。提交失败时恢复旧活动选择与凭据，不把新账号半成品显示为成功。重启恢复以加密凭据中经验证的 accountId 和真实 `/user` 为依据，不能仅相信 app_settings 中的最后用户名。

```ts
// services/auth.js
initializeApplication(): Promise<ApplicationBoot>
startLogin(): Promise<AuthorizationChallenge>
pollLogin(challengeId: string): Promise<AuthorizationProgress>
cancelLogin(challengeId: string): Promise<void>
restoreSession(): Promise<Session>
logout(): Promise<void>
forgetCurrentAccount(): Promise<void>

// Electron GitHubAuth；Android 使用同名职责的 Java 方法
beginAuthorization(): Promise<AuthorizationChallenge>
pollAuthorization(challengeId: string): Promise<AuthorizationProgress>
cancelAuthorization(challengeId: string): void
restoreSession(): Promise<Session>
ensureAccessToken(): Promise<string>         // 仅原生内部使用
refreshAccessToken(): Promise<void>          // 仅原生内部使用
commitAuthorizedAccount(credentials, rawUser): Promise<Session>
clearCredentials(): Promise<void>
```

`initializeApplication()` 仅包装一次 `app.initialize`。原生在这个操作内部打开本地数据库、迁移、清理未完成临时版本，再恢复用户选择并按需调用一次 `restoreSession()`，返回 ApplicationBoot，前端不在同一次启动中再次验证身份。如果上次明确选择游客，则直接进入热门页，不再次强制弹出登录。若存在凭据则恢复账号；首次启动 mode 为 unset、shouldPromptLogin 为 true，允许跳过。初始化完成前只显示短暂启动状态，不先渲染游客资料再闪成个人资料。

`settings.save` 只用于未登录时保存显式的游客选择；account 模式与活动账号 ID 由原生成功认证流程更新，不能靠设置接口创建一个已登录状态。原生数据库确实无法打开时保留原文件，返回存储不可用状态；公开热门页面仍可使用，账号与本地历史入口说明暂不可用，不悄悄新建另一份空历史。

`restoreSession()` 的分支固定：在线 `/user` 成功返回 `authenticated`；无法连接 GitHub、但存在原生保存的已验证账号及其缓存，返回 `offline`；令牌经刷新后仍被明确拒绝，返回 `reauthRequired`；没有凭据和活动账号时返回 `guest`。离线会话允许读本机资料和记录本机历史，禁止远程 Star。`reauthRequired` 保留本机缓存供查看，但暂停新增账号操作和历史记录，并显示“授权已失效，请重新登录”。不能把网络超时直接当成账号已退出。

`ensureAccessToken()` 读取原生内存中的凭据。令牌距离过期不足 60 秒时先刷新；同一时刻的多个请求共用一个刷新 Promise，Android 对应共用一个受锁保护的刷新任务，避免重复消耗 refresh token。刷新响应中的 access token、refresh token 和过期时间作为一个整体写回，再替换内存值。一次 401 可以刷新并重新发送原请求一次；刷新失败后不反复重试。刷新机制及 Device Flow 不要求 Client Secret 的条件见 [GitHub 刷新令牌文档](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)。

`refreshAccessToken()` 的请求仍是 POST `https://github.com/login/oauth/access_token`，表单包含固定 client_id、`grant_type=refresh_token` 与原生保存的 refresh_token。过期时间按响应中的 expires_in 与 refresh_token_expires_in 换算，不将文档示例时长写死。成功刷新会使旧 refresh token 失效，因此新凭据落盘失败不能回填旧令牌假装可恢复；应明确保存失败，必要时要求重新授权。刷新任务在 finally 清理进行中标识，但不会在 finally 再发一次请求。

Windows 凭据保存为 `userData/auth/credentials.bin`，内容使用 `safeStorage` 加密，原文只在主进程内存中出现。写入使用同目录临时文件再替换，防止更新令牌时留下半份文件。该保护基于操作系统用户，不能描述为防御同一系统用户下所有进程；能力说明依据 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

Android 在 `AndroidKeyStore` 中生成 AES/GCM 密钥，将随机 IV 与密文保存到应用私有 SharedPreferences。`CredentialStore.save()` 必须确认整份新凭据保存成功后再返回；不得将令牌直接交给普通 Preferences、WebView Storage 或 SQLite。密钥保管方式见 [Android Keystore](https://developer.android.com/privacy-and-security/keystore)。

`logout()` 取消授权和个人同步、结束旧会话上下文、删除凭据，将全局模式设为游客并清空内存个人状态。本地历史和公开资料缓存默认保留，重新授权到同一 GitHub ID 后恢复。退出后游客界面不能继续展示上一个账号的缓存。退出只结束本机登录；用户若要撤销 GitHub 应用授权，可通过设置中的外部链接前往 GitHub 处理。

“删除本账号本地数据”是另一项明确操作：用户确认后删除当前账号的历史、缓存、偏好和凭据，再转为游客；不影响其他账号的本地分区。普通退出与删除本地数据不能合并成一个含糊按钮。

## 五、GitHub 接口、个人列表与 Star 行为

`github.request` 的 `resource` 使用固定枚举，原生层按表构造 URL、方法和请求头。参数中的用户名、owner、repo 分别编码为单个路径片段，不能直接拼入一段任意路径。客户端统一固定 `X-GitHub-Api-Version: 2026-03-10`，避免依赖默认版本；版本用法依据 [GitHub API 版本说明](https://docs.github.com/en/rest/about-the-rest-api/api-versions)。

| resource | 实际请求 | 入参与处理 |
| --- | --- | --- |
| `currentUser` | `GET /user` | 无；必须使用已授权用户令牌 |
| `ownedRepos` | `GET /users/{login}/repos` | `type=owner&sort=updated&direction=desc&per_page=100&page=n` |
| `starredRepos` | `GET /user/starred` | `sort=created&direction=desc&per_page=100&page=n` |
| `starState` | `GET /user/starred/{owner}/{repo}` | 204 表示已 Star，404 表示未 Star |
| `addStar` | `PUT /user/starred/{owner}/{repo}` | 空请求体；204 才确认成功 |
| `removeStar` | `DELETE /user/starred/{owner}/{repo}` | 204 才确认成功 |
| `searchTrending` | `GET /search/repositories` | 固定公开项目查询、Star 降序和每页 20 条 |

REST 请求使用 `Accept: application/vnd.github+json`；Star 列表改用 `application/vnd.github.star+json` 取得真实收藏时间，按其响应中的 `repo` 对象转换。所有请求设置 HappyGit User-Agent。原生返回仅保留分页和限流所需的 `Link`、`Retry-After`、`X-RateLimit-Remaining` 与 `X-RateLimit-Reset`，不返回 Authorization 请求头。204 不调用 JSON 解析。Star 权限、状态码与时间戳格式依据 [GitHub Star 接口](https://docs.github.com/en/rest/activity/starring)。

`GitHubClient.request(resource, args, sessionContext)` 先判断该资源是否要求认证，再构造固定目标地址。个人资源使用当前账号令牌；公开热门搜索允许游客请求。Android 连接超时设为 8 秒、读取超时为 15 秒，Electron 使用 AbortController 设 15 秒整次请求上限；不假设 fetch 自带独立连接超时。取消操作同时标记任务已失效，避免已返回的结果重新写入页面或数据库。

`extractNextPage(linkHeader, expectedResource)` 解析 `rel="next"` 的 URL，核对 HTTPS、`api.github.com` 和当前资源路径后，只取合法的下一页页码；下一次请求仍由原生重建 URL，不直接跟随任意 Link 地址。缺少 next 时本轮分页结束。不要凭第一页数量直接声称“全部同步完成”，也不要将超过 100 条的账号截断为第一页。

个人资料、本人公开仓库和 Star 分别同步。`/user` 先确认身份，再并行启动仓库与 Star 两条串行分页链，总体最多两条列表请求并发。仓库列表保留公开、归属当前账号的仓库，包含 Fork 和未声明许可证的仓库；Fork 使用标签区分。Star 列表只保留本轮支持的公开仓库。每页以 `repoId` 去重，禁止使用仓库名去重。列表顺序使用仓库更新时间、Star 时间及 `repoId` 作为稳定补充排序。

```ts
// services/account.js
syncProfile(): Promise<AccountProfile>
syncOwnedRepositories(options?: { force?: boolean }): Promise<SyncSummary>
syncStarredRepositories(options?: { force?: boolean }): Promise<SyncSummary>
syncRepositoryCollection(kind: 'repos' | 'stars'): Promise<SyncSummary>
cancelCollectionSync(kind: 'repos' | 'stars'): Promise<void>
refreshAccount(): Promise<AccountRefreshSummary>
loadRepositoryPage(kind, offset = 0, limit = 30): Promise<RepositoryPage>
getStarState(repository: Repository): Promise<boolean>
setStar(repository: Repository, starred: boolean): Promise<StarMutationResult>
deriveInterestTags(owned: Repository[], starred: Repository[], manual: string[]): string[]
saveInterestPreferences(manualTags: string[]): Promise<void>
```

`syncProfile()` 请求当前用户、标准化并保存资料，不重置历史和偏好。如果当前用户 ID 与原生会话 ID 不一致，转交账号切换流程，不能覆盖现有账号的分区。它不负责同步全部列表，资料请求成功后可以先显示头像和数量，列表独立加载。

`syncRepositoryCollection(kind)` 先取得本次 `sessionEpoch` 和会话上下文，调用 `sync.begin` 获得临时版本号。随后从第一页开始逐页请求、标准化、筛选和落入临时版本，并更新“已加载 n 项”。读到最后一页后调用 `sync.finish`；只有此时才替换活动版本并更新完整数量。中途失败则 `sync.abort`，保留上次成功的活动版本。第一次同步的部分数据可以在本次页面内展示，但必须标记“同步中”或“本次仅加载 n 项”，不能把部分缓存当作完整结果。

```text
syncRepositoryCollection(kind):
  记录当前 sessionEpoch 和 contextId
  generationId = await local.beginSync(kind)
  page = 1
  loadedCount = 0
  while page != null:
    response = await github.request(resourceFor(kind), { page })
    若会话版本已变化，结束本轮，不更新当前界面
    items = 按 kind 转换并过滤 private 仓库
    nextPage = extractNextPage(response.headers.link, resourceFor(kind))
    await local.writeSyncPage(kind, generationId, page, items, nextPage)
    loadedCount = 临时版本的去重条数
    更新当前账号该列表的进度
    page = nextPage
  summary = await local.finishSync(kind, generationId)
  使用活动版本重新加载页面第一页
  返回 summary

任一正常业务失败:
  撤销本轮临时版本，保留活动版本
  返回该列表失败原因和上次成功时间
  不清空其他列表、不撤销已验证身份
```

`sync.begin` 对同一账号、同一 kind 只保留一个临时版本。旧版本的 `writePage` 或 `finish` 必须因 generation 不匹配而失效。应用重新启动时清理未完成的临时版本，不从某个旧页码继续拼接，因为分页期间远程列表可能已经变化。

`refreshAccount()` 分别收集资料、仓库和 Star 的执行结果，允许一项成功、另一项失败；对应界面分别展示同步状态，不能用一个总成功提示掩盖部分失败。首次登录启动同步；启动恢复或重新进入个人页时，完整缓存不足 5 分钟则直接使用，否则发起一次后台刷新。手动刷新可以绕过本地新鲜度判断，但不能绕过 GitHub 的限流截止时间。应用不添加无期限的后台轮询。

限流需要区分语义。403 或 429 搭配限流响应头时设置 `retryAt`，暂停该同步并显示可重试时间；权限不足的 403 显示“当前授权缺少所需权限”。网络中断保留缓存。仓库详情的 404 显示“仓库暂不可访问”；仅 `starState` 的 404 解释为未收藏。404、限流和超时均不能触发固定资料或固定项目的兜底成功。

“我的 Star”数量以完整公开 Star 同步结果为准。还没得到完整结果时显示“已加载 n 项”，从未成功同步时显示“待同步”，不能拿当前页面 30 条的长度充当账号总数。`publicRepoCount`、关注者和正在关注数量直接来自真实资料，仓库页的已缓存数量另行标注。

`getStarState(repository)` 优先读取完整 Star 缓存；完整缓存中没有该 repoId 才能判定为 false。缓存未完成时状态是 unknown，需要对用户准备操作的仓库请求 `starState`；不能因为分页尚未加载到它就显示未收藏。针对同一仓库的进行中查询共用一个 Promise，不在每次 Vue 渲染时重复发请求。

`setStar(repository, starred)` 按 repoId 锁定操作按钮，并取消、等待当前 Star 全量同步退出，防止旧快照覆盖新操作。随后调用真实 PUT 或 DELETE。成功后更新本地活动版本和页面状态，清除锁，再启动一次 Star 列表刷新以校准完整集合。若还没有完整活动版本，则建立带 `complete=false` 的本机已确认集合，页面仍只显示已加载数量。

Star 请求超时后，服务层可以查询一次该仓库状态来确认结果；无法确认时显示“暂未确认 GitHub 上的操作结果，请刷新”，不直接宣告成功或失败，也不自动反向操作。远程已经确认成功但本机落库失败时，保留本次远程确认结果并提示“GitHub 已更新，本机缓存未保存”，不把真实操作说成失败，更不能为回滚缓存而撤销用户的 Star。

热门页原“收藏”按钮统一改为“Star / 已 Star”，个人页提供取消 Star 的真实入口。游客点击时打开登录入口，不先显示收藏成功。离线状态不能进行远程 Star，也不保存待联网后自动执行的写操作。

`deriveInterestTags()` 是轻量归纳函数，不调用模型或集群。合并去重后的仓库中，本人非 Fork 仓库的主语言记 4 分、每个 topic 记 2 分；本人 Fork 与仅 Star 的仓库分别记主语言 2 分、topic 1 分。同一个 repoId 同时属于本人仓库和 Star 时按本人仓库规则计算一次。标签按去空白、忽略大小写的 key 合并，分数相同时按 key 字典顺序排列。用户手选标签优先，自动标签补齐，总共最多 8 个。完整数据未齐时保留上次计算结果并标记资料同步中，不用固定技术栈补足。

`saveInterestPreferences()` 将用户输入按中英文逗号切分、去空白、忽略大小写去重，每项最多 24 个字符、最多 8 项，保存到账号偏好。`EditProfileModal.vue` 改为“兴趣设置”，仅编辑本机手选技术兴趣；GitHub 昵称、简介、地区等字段只读，可通过“在 GitHub 编辑资料”打开 GitHub 设置页。这样可以避免本机改了资料却被误认为 GitHub 已同步修改。

## 六、本地数据库与函数实现约定

Windows 的应用数据根目录固定为 `path.join(app.getPath('appData'), 'HappyGit')`，在创建窗口前设置为 `userData`，数据库放在 `data/happygit.db`。开发运行和打包应用使用同一个稳定的正式路径；验收数据可以通过显式的开发配置使用独立目录，不得根据窗口 URL 临时改变正式数据位置。重新打包或移动应用文件夹不会清除用户历史。

Android 数据库名为 `happygit.db`，使用 `Context.getDatabasePath()` 对应的应用私有位置。保持 `applicationId=com.happygit.app`，升级采用相同签名和递增 versionCode。覆盖安装保留数据库；卸载、清除应用数据或用户主动删除本地数据后不承诺恢复。历史不写入公共下载目录，不申请文件管理或存储权限。

Android 当前 `allowBackup=true` 应改为禁用本轮个人数据的自动云备份，并提供 Android 12 及以上的 `dataExtractionRules` 与旧版 `fullBackupContent` 排除规则。规则对 database、sharedpref、file 三类私有数据同时排除云备份与设备迁移，覆盖数据库及凭据密文，避免自动跨设备复制导致“只保存在本机”的描述失实。平台差异和规则格式依据 [Android Auto Backup 文档](https://developer.android.com/identity/data/autobackup)。

数据库初始版本为 1，Windows 使用 `PRAGMA user_version`，Android 使用 `SQLiteOpenHelper` 的版本号。两端按以下兼容 SQL 建表；Android 最低 SDK 24，不依赖新 SQLite 才有的 UPSERT、RETURNING、STRICT、窗口函数或 JSON 扩展。

```sql
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY NOT NULL,
  login TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  profile_synced_at INTEGER NOT NULL
);

CREATE TABLE account_preferences (
  account_id TEXT PRIMARY KEY NOT NULL,
  history_enabled INTEGER NOT NULL DEFAULT 1,
  manual_tags_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE browse_history (
  account_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  description TEXT,
  repository_json TEXT NOT NULL,
  first_viewed_at INTEGER NOT NULL,
  last_viewed_at INTEGER NOT NULL,
  last_counted_at INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  last_source TEXT NOT NULL,
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX idx_history_account_time
  ON browse_history(account_id, last_viewed_at DESC, repo_id DESC);

CREATE TABLE repository_cache (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  sort_time INTEGER NOT NULL,
  repository_json TEXT NOT NULL,
  PRIMARY KEY (account_id, kind, generation_id, repo_id),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX idx_repository_collection
  ON repository_cache(account_id, kind, generation_id, sort_time DESC, repo_id DESC);

CREATE TABLE sync_state (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  active_generation TEXT,
  active_complete INTEGER NOT NULL DEFAULT 0,
  active_count INTEGER NOT NULL DEFAULT 0,
  staging_generation TEXT,
  staging_next_page INTEGER,
  staging_count INTEGER NOT NULL DEFAULT 0,
  last_completed_at INTEGER,
  last_error_code TEXT,
  retry_at INTEGER,
  PRIMARY KEY (account_id, kind),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL
);

CREATE TABLE feed_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
```

开启 `PRAGMA foreign_keys=ON`；使用 WAL，写入采用 `synchronous=FULL`，busy timeout 为 5 秒。全局设置只放用户选择的模式和活动账号 ID 等小数据，不保存令牌、完整资料副本或历史数组。仓库详情快照保留重新访问所需的 HTTPS 链接和稳定 repoId，Star 数等标明是最近同步值。

Windows 在 `database-worker.cjs` 中持有唯一 `DatabaseSync` 连接，主进程通过 `database.cjs` 的 `callDatabase(operation, payload)` 排队发送请求。worker 只执行数据库领域操作，不依赖 Electron API。主进程提前计算路径并传入 worker。所有事务同步执行完再回复，事务中不进行网络请求，也不跨 `await` 保持事务。收到关闭信号后等待队列完成并关闭连接。

Android 的 `LocalRepository` 持有一个 `HappyGitDbHelper`，数据库写操作进入独立的单线程 executor；网络请求使用另一个有限线程池，避免正在等待授权响应时挡住本地历史写入。`onConfigure()` 开启外键，`onCreate()` 执行建表，`onUpgrade()` 逐版本执行增量迁移。未来迁移失败时保留原数据库并报告存储错误，不删除数据库重建来掩盖问题。

```ts
// database-worker.cjs 内部领域函数；Java LocalRepository 保持相同语义
openDatabase(dbPath: string): void
migrateDatabase(targetVersion: number): void
withTransaction<T>(work: () => T): T
saveProfile(accountId: string, profile: AccountProfile): void
readAccountSnapshot(accountId: string): AccountSnapshot
savePreferences(accountId: string, preferences: AccountPreferences): void
beginSync(accountId: string, kind: string): { generationId: string }
writeSyncPage(accountId, kind, generationId, page, items, nextPage): SyncProgress
finishSync(accountId, kind, generationId): SyncSummary
abortSync(accountId, kind, generationId, errorCode?): void
listRepositories(accountId, kind, offset, limit): RepositoryPage
applyConfirmedStar(accountId, repository, starred): void
recordBrowse(accountId, repository, source, viewedAt): HistoryEntry
listHistory(accountId, cursor, limit, keyword): HistoryPage
deleteHistory(accountId, repoId): void
clearHistory(accountId): void
countHistory(accountId): number
pruneHistory(accountId, now): void
forgetAccount(accountId): void
```

`withTransaction()` 在 Windows 执行 BEGIN IMMEDIATE、工作函数和 COMMIT，只有工作失败才 ROLLBACK 后继续向上报告；Android 使用 beginTransaction、setTransactionSuccessful 和 endTransaction。事务控制只放在领域操作外层，内部辅助函数不重复开启事务。所有变量值使用预编译参数绑定，不拼接用户名、查询词或仓库名称到 SQL。

`saveProfile()` 在事务中先尝试 INSERT OR IGNORE，再 UPDATE 该 accountId 的资料，同时为不存在的账号创建默认偏好。用户名变化只更新 `login` 与资料，不生成新账号分区。既有浏览历史不会因刷新资料被删除。

`beginSync()` 生成 UUID，将对应 `staging_generation` 指向新值，staging_next_page 初始化为 1，删除该账号该 kind 的旧临时版本。`writeSyncPage()` 核对本次 generation 仍为当前 staging、传入 page 正好等于期待页码后，逐条 INSERT OR IGNORE，再 UPDATE 同一主键的快照及排序时间；更新去重后的 staging_count 和下一页。`finishSync()` 核对至少受理过第一页且下一页为空，事务中将 staging 升为 active、设置 complete、计数与完成时间，再删除该 kind 的其他版本。完整结果为空同样必须提交，从而清除远程已移除的旧项目。

`abortSync()` 只删除匹配 generation 的临时数据，不改变活动版本。失败原因与可重试时间保存到 sync_state。启动清理临时版本时也沿用这个边界。Star 的 `applyConfirmedStar()` 在同步已取消后修改活动集合：添加时写入真实仓库快照，删除时仅移除该 repoId；不存在活动版本时创建一个不完整版本。添加为幂等写入，删除为幂等删除，活动计数重新按去重集合统计，不能每收到一次确认就机械加减 1。完整性为 false 时不要计算完整 Star 总数。

PUT 的 204 不提供 GitHub 的精确 Star 时间，因此添加后的本地 sort_time 可暂用确认时间，Repository.starredAt 保持未知，等待列表刷新得到真实值；仓库全站 Star 数同样等待真实响应更新，不因为本次操作就盲目加 1。外部设备可能同时修改 Star，全量同步代表本次分页取得的结果，不宣称持有 GitHub 原子快照。

`recordBrowse()` 是历史写入的唯一入口。原生先确认会话允许记录且该账号开启历史，再在一个事务内查询 `(accountId, repoId)`。首次访问插入一条，三个时间均取 viewedAt，visit_count 为 1。重复访问更新仓库快照、名称、简介、last_source 和 last_viewed_at；只有距 last_counted_at 至少 30 秒才将 visit_count 加 1 并更新 last_counted_at。这样双击不会产生两条历史，也不会快速增加访问次数。

```text
recordBrowse(accountId, repo, source, viewedAt):
  begin transaction
  old = 查询该账号该 repoId 的历史
  if old 不存在:
    插入新记录，visitCount = 1
  else:
    nextViewedAt = max(old.lastViewedAt, viewedAt)
    shouldCount = viewedAt - old.lastCountedAt >= 30000
    更新快照、来源和 nextViewedAt
    若 shouldCount，visitCount += 1，lastCountedAt = viewedAt
  清理该账号超过保留期限和数量上限的历史
  查询并返回最终条目
  commit
```

`viewedAt` 在原生接收访问请求时取当前时间，组件不能伪造任意历史时间。函数契约中的 viewedAt 用于内部传递和可复现验证。若系统时钟向后调整，使用 max 避免同一条历史的 lastViewedAt 回退，但不建立额外校时服务。

`pruneHistory()` 默认保留最近 90 天、每账号最多 5000 个不同仓库。先删除 last_viewed_at 早于截止时间的记录，再按 `last_viewed_at DESC, repo_id DESC` 删除排名 5000 之后的记录。只在该账号分区初始化和实际写入历史时执行，不额外启动后台清理定时器，也不在每次查询时 VACUUM。

`listHistory()` 默认每页 30 条、最多 100 条，按 `last_viewed_at DESC, repo_id DESC` 排列。使用游标 `{ lastViewedAt, repoId }` 查询下一页，条件为时间更早，或时间相同且 repoId 更小，避免删除或新访问导致 offset 分页重复。关键词只查询 `full_name` 与 `description`，以参数绑定及转义后的 LIKE 匹配；搜索条件变化清空旧游标并从第一页查询。返回的 total 使用同一账号和搜索条件统计，不用页面长度充当总数。

`deleteHistory()` 删除该账号一个 repoId 的聚合记录；`clearHistory()` 删除该账号全部 browse_history，不触及 Star、仓库缓存、GitHub 真实收藏或手选兴趣。两者成功返回后才更新页面数量。清空需要确认“仅删除本机当前账号的浏览历史”；普通单条删除无需再弹确认。

`forgetAccount()` 先终止该账号进行中的任务，事务删除 accounts 对应记录，由外键级联清除其余个人表，再清除活动账号选择与凭据。数据库不存访问令牌；这项操作不会向 GitHub 发送取消 Star 或修改资料请求。

本轮没有既有持久历史可迁移。不得把当前写死的 myProjects、myStars、开发者资料或内存中来源不明的记录导入新数据库。如果开发中临时生成过浏览器存储，只删除 HappyGit 自己明确使用过的键，不清空整个 WebView 或浏览器的存储空间。

## 七、双端原生层落地细节

Electron 的 `main.cjs` 先固定应用数据路径、初始化数据库与授权服务，再创建窗口。增加 `preload`，继续保持 `nodeIntegration=false`、`contextIsolation=true`，将现有 `webSecurity=false` 改回 true。网络请求已经移到原生层，不再通过关闭浏览器安全策略解决跨域。窗口仍加载打包的本地资源，不为账号功能再启动一个本地 Web 服务。

`registerIpcHandlers(services)` 只注册一个受控调用通道，使用操作名到 handler 的固定 Map 分发。handler 核对发送方是当前应用主窗口主 frame，并核对账号上下文，不能接受后来打开的网页调用。`preload.cjs` 用 `contextBridge.exposeInMainWorld()` 暴露 Promise 接口，不转发底层 event 对象，也不提供 `getToken()`。Electron 的相关边界依据 [官方安全建议](https://www.electronjs.org/docs/latest/tutorial/security)。

```ts
// main.cjs
createServices(): Promise<{ auth, github, database }>
registerIpcHandlers(services): void
createWindow(): BrowserWindow
isTrustedSender(event): boolean
handleOperation(operation, payload, contextId): Promise<BridgeResult<unknown>>
openExternalGitHubUrl(url: string): Promise<void>
shutdownServices(): Promise<void>

// database.cjs
startDatabaseWorker(dbPath: string): Promise<void>
callDatabase(operation: string, payload: object): Promise<unknown>
closeDatabaseWorker(): Promise<void>
```

`startDatabaseWorker()` 等待 worker 完成建库后才返回。`callDatabase()` 为请求分配递增 requestId，以 Map 记录 resolve/reject；收到 worker 回复后删除对应项。worker 退出时结束未完成调用并显示本地存储不可用，不切换到仅存内存却声称已保存的模式。窗口关闭时先阻止新调用，再完成已受理的数据库事务，最后关闭 worker。数据库同步 API 放在 worker 内是为了不阻塞 Electron 窗口主进程，不需要再建立多连接数据库池。

`createWindow()` 用 `webContents.setWindowOpenHandler()` 拦截新窗口，符合 GitHub HTTPS 规则的地址交给系统浏览器并返回 deny，防止 GitHub 页面成为携带原生接口的应用窗口。`will-navigate` 同样阻止主窗口跳到外站。`external.open` 只接受准确主机名 `github.com`、HTTPS、默认 HTTPS 端口且不含用户名密码的 URL；设备授权地址、用户资料、GitHub 设置和仓库访问都满足这个范围。不要使用字符串 contains 判断域名。

Android 的 `MainActivity.onCreate()` 在 `super.onCreate()` 前调用 `registerPlugin(HappyGitPlugin.class)`，之后保留 Capacitor 正常初始化。插件使用 `@CapacitorPlugin(name="HappyGit")`，对外只提供 `@PluginMethod invoke(PluginCall call)`。读取 operation、payload、contextId 后使用固定映射分派；返回统一的 BridgeResult。没有对应操作时立即返回参数错误，不借此暴露原始数据库或任意网络调用。

```java
// HappyGitPlugin.java
public void load();
@PluginMethod public void invoke(PluginCall call);
private void dispatch(String operation, JSObject payload, String contextId,
                      PluginCall call);
private void resolveSuccess(PluginCall call, Object data);
private void resolveFailure(PluginCall call, AppException error);
protected void handleOnDestroy();

// GitHubAuth.java
AuthorizationChallenge beginAuthorization();
AuthorizationProgress pollAuthorization(String challengeId);
void cancelAuthorization(String challengeId);
Session restoreSession();
String ensureAccessToken();
void refreshAccessToken();
Session commitAuthorizedAccount(Credentials credentials, JSONObject rawUser);
void logout();

// CredentialStore.java
Credentials read();
void save(Credentials credentials);
void clear();
private SecretKey getOrCreateKey();
private byte[] encrypt(byte[] plaintext, byte[] iv);
private byte[] decrypt(byte[] ciphertext, byte[] iv);

// GitHubClient.java
GitHubResponse request(Resource resource, ResourceArgs args,
                       SessionContext context);
private URL buildUrl(Resource resource, ResourceArgs args);
private GitHubResponse execute(Request request);
private AppException mapFailure(int status, JSONObject body,
                                Map<String, String> headers);
```

`CredentialStore.read()` 只在原生服务初始化时解密，再由原生内存保存当前凭据；普通个人接口不反复访问磁盘。每次加密使用新的随机 IV，密文格式包含版本号、IV 和密文，便于后续迁移。密钥丢失或密文确实无法解密时清除失效凭据、转为重新授权，保留不含凭据的个人资料和历史。日志不输出密文原文、令牌、device_code 或完整授权响应。

网络任务与数据库任务都不能在 Android UI 线程执行。`handleOnDestroy()` 取消尚未完成的授权任务、停止接收新工作并关闭资源；已有数据库事务按串行队列完成。系统杀进程时不能依赖该回调补写历史，因此访问动作必须在调用外部浏览器前已完成事务提交。

`openExternalGitHubUrl()` 在 Android 使用 `Intent(Intent.ACTION_VIEW, Uri.parse(url))`，在主线程发起系统 Activity。没有可处理的浏览器时返回 `OPEN_FAILED` 并显示链接供用户复制，不将地址继续载入应用 WebView。它与 Windows 采用同一地址限制。

服务端 `happygit.github.token` 仅用于服务器公开热门请求的配额，不代表客户端用户身份。若部署需要配置该值，从环境变量读取，不写入仓库。`AuthController` 的现有伪资料接口退出使用；仓库内没有依赖它的客户端调用，可删除该控制器，不再提供“传用户名即登录”的兼容入口。

## 八、页面状态与完整调用链

`stores/user.js` 不再同时维护可互相矛盾的 isGuest 和 isLoggedIn。核心状态改为 session、profile、authStage、authError、loginChallenge、preferences、repos、stars 和两个列表各自的 syncState。登录弹窗的加载状态由 store 控制，组件发出普通意图事件，父层调用并等待 store action，组件自身不再 `await emit()`。

```ts
// user store 的主要 state
session: Session
sessionEpoch: number
bootStatus: 'starting' | 'ready' | 'storageError'
authStage: 'idle' | 'requesting' | 'waiting' | 'verifying'
authError: string | null
loginChallenge: AuthorizationChallenge | null
preferences: { historyEnabled: boolean; manualTags: string[] }
repos: Repository[]
stars: Repository[]
repoSync: CollectionSyncState
starSync: CollectionSyncState
starPendingByRepo: Record<string, boolean>

// getters
hasAccount = session.accountId != null
isGuest = session.status == 'guest'
isOffline = session.status == 'offline'
needsReauth = session.status == 'reauthRequired'
canWriteGitHub = session.status == 'authenticated' && authStage == 'idle'
canRecordHistory = authStage == 'idle' && preferences.historyEnabled &&
                   ['authenticated', 'offline'].includes(session.status)
```

`CollectionSyncState` 至少包含 status（idle、loading、ready、error）、loadedCount、complete、lastSyncedAt、errorCode 和 retryAt。数据是否完整与请求是否正在进行分别表达。`userStore.initialize()` 只运行一次，调用应用初始化、恢复会话、读取个人缓存和历史计数；需要联网更新时再调用 account service。`userStore.startLogin()`、`cancelLogin()`、`logout()` 和 `switchAccount()` 统一控制 authStage 与 sessionEpoch。开始切换前取消旧账号的列表同步；取消切换后恢复旧会话的可操作状态，有需要时重新启动同步。

登录成功的调用顺序为：原生校验 `/user` → 本地账号分区和凭据提交 → user store 替换 session → 读取新账号缓存与偏好 → history store 清除旧游标并加载新账号第一页 → 关闭登录弹窗 → 并行刷新公开仓库和 Star。账号资料先显示，列表使用各自加载状态，不要求全部分页完成才能关闭登录弹窗。

`App.vue` 挂载时等待 `initialize()`，据返回模式决定是否打开登录弹窗，删除 `isLoginModalOpen = ref(true)` 的固定行为。原来的 `handleLogin(username)` 替换为无用户名参数的授权入口；无活动账号时 `handleSkipLogin()` 保存游客模式，已有账号的切换弹窗则只显示取消切换，不用“跳过”偷偷清除原账号。`handleLogout()` 调用真正的退出流程。个人页、设置页与弹窗都读取相同 store，避免各自猜测当前账号。

`ProfileView.vue` 使用 `hasAccount` 决定是否显示本地个人资料，使用 `needsReauth` 显示重新授权入口，使用 `isOffline` 显示“离线资料，更新于……”。这样授权过期时仍能查看本机历史，不会因为简单的 isLoggedIn=false 把本地记录隐藏成游客空页。GitHub 数据全部由标准化模型取值，Pro Dev 等无法证明的身份标签移除。

历史页增加本地搜索、单条删除、清空和分页加载，保留当前页签结构。列表按今天、昨天、更早展示分组，但存储仍只有时间戳。`formatHistoryTime(timestamp, now)` 在当天显示 HH:mm，昨天显示“昨天 HH:mm”，更早显示 YYYY-MM-DD HH:mm；一天的判断按设备本地自然日，不能简单把 24 小时当成“昨天”。分钟级页面计时只用于刷新展示，页面卸载时清除，不写回数据库。

```ts
// stores/history.js
initializeForCurrentAccount(): Promise<void>
loadFirstPage(keyword = ''): Promise<void>
loadMore(): Promise<void>
remove(repoId: string): Promise<void>
clearAll(): Promise<void>
refreshAfterVisit(): Promise<void>
reset(): void

// services/history.js
record(repository: Repository, source: HistorySource): Promise<HistoryEntry | null>
query(options: HistoryQuery): Promise<HistoryPage>
remove(repoId: string): Promise<void>
clear(): Promise<void>
count(): Promise<number>
```

history store 使用 requestSequence 丢弃旧搜索请求结果，并用 loadingMore 防止重复加载同一游标。`remove()` 成功后重新加载当前搜索的第一页，保证 total 和游标一致。`refreshAfterVisit()` 也从第一页刷新，因为最近访问可能让同一仓库移动到列表顶部。退出或切换账号时立即 `reset()`，之前的查询结果即使返回也不能写入新页面。

所有项目访问入口统一调用 `projectService.openRepository(repository, source)`，热门标题和查看源码、我的 Star、我的项目、历史条目都不得再各自 `window.open()`。函数先捕获当前会话上下文，再按能力判断是否记录；可记录时等待本地事务提交，然后调用系统浏览器。

```ts
// services/projects.js
openRepository(repository: Repository, source: HistorySource): Promise<OpenResult>
loadTrending(options?: { force?: boolean }): Promise<TrendingResult>
fetchTrendingFromServer(): Promise<Repository[]>
fetchTrendingFromGitHub(): Promise<Repository[]>
readCachedTrending(): Promise<TrendingResult | null>
```

`openRepository()` 先核对仓库有真实 repoId 和有效 GitHub URL。历史写入成功后通知 history store 刷新计数或顶部记录，再打开外部地址。游客或已关闭历史时直接打开。数据库写入失败仍允许打开仓库，并提示“本次浏览历史未能保存”；外部浏览器调用失败则显示打开失败。历史代表用户发起的源码访问操作，不声称已经观测到外部网页加载完成。

`SettingsModal.vue` 的“隐私与数据存储”增加“记录本机浏览历史”开关，默认对已授权账号开启，说明“仅保存在当前设备，可随时关闭或清空”。关闭后停止新增记录，保留既有历史；再次开启从新的访问开始。设置页还提供清空历史、删除本账号本地数据、手动同步与退出账号，分别绑定明确的 service action。没有 Hadoop 运行状态接口时移除集群已就绪与 HDFS 快照卡片，不另写一个固定成功的健康接口。

`LoginModal.vue` 的游客说明改为“可以浏览公开热门项目；游客模式不保存账号资料和个人浏览历史”。授权说明写清 GitHub 个人资料和公开仓库会被缓存到本机、历史保存在本机，不能笼统承诺“系统不会收集任何个人信息”。个人画像区域统一称“技术兴趣”，说明“根据公开仓库与 Star 归纳”；我的项目显示真实许可证，缺失时不把仓库排除出公开列表。

热门查询维持“近 3 个月创建，按 Star 降序”的现有规则，不在本轮更换推荐算法。文案使用“近 3 个月”而非与日历月不完全一致的“近 90 天”。`loadTrending()` 有配置的后端地址时先请求公开服务，再用原生 GitHub 搜索，最后读取真实本机缓存；三者都没有结果时显示空状态。删除前后端写死仓库的 fallback，不再把虚构 repoId 或创建日期写入历史。

`searchTrending` 明确查询 `is:public created:>{cutoffDate}`，避免已授权请求意外引入可访问的私有结果。cutoffDate 按当前自然日期减 3 个日历月计算，目标月不存在同一日时取该月最后一天，再格式化 YYYY-MM-DD；JavaScript 不直接依赖可能滚动到下一月的 setMonth。前后端使用同一日期口径。

后端地址通过 `VITE_API_BASE_URL` 统一配置。未配置则跳过后端，Android 不再请求手机自己的 `http://localhost:8081`。公开服务请求也通过原生受控网络能力执行，允许的后端 origin 来自构建配置，不能由页面任意填写。发布环境只使用 HTTPS；局域网 HTTP 只作为明确的开发配置，不关闭全局 WebView 安全设置。公开热门请求永远不向后端附带个人 GitHub 令牌。

为支持上述调用，在固定原生操作中增加 `feed.fetchRemote`，只访问构建配置对应的 `/api/projects/trending?limit=20`。已有 `github.request/searchTrending` 只负责 GitHub 直连。`feed.save` 仅保存真实接口取得的标准化数据，缓存读取结果标明 source=cache 与 fetchedAt；无后端且没有网络时不会自动生成精选列表。

服务端 `GitHubTrendingService` 的本轮改动仅限去除写死兜底、准确返回真实缓存状态，以及避免固定假数据流入历史。已有真实缓存时返回缓存及 fetchedAt/source；没有真实缓存且 GitHub 不可用时返回非成功状态。`ProjectController` 在原响应外增加来源和抓取时间，不改变实际排序含义。不同 limit 的缓存返回需截取到本次 limit，避免复用较大列表后忽略调用参数。

服务端函数具体调整为 `getTrendingProjects(int limit): TrendingFetchResult`、`fetchFromGitHub(LocalDate cutoffDate): List<TrendingProject>` 和 `sliceCached(int limit): TrendingFetchResult`。TrendingFetchResult 包含 projects、fetchedAt 和 source（live 或 cache）。抓取时固定最多 30 条公开仓库，返回时把 limit 限制在 1～30 并截取。上游失败且没有真实缓存时抛出一个明确的上游不可用错误，由该控制器返回 HTTP 503；不新增覆盖全项目的异常框架。成功响应继续包含 code、message、total、data，另外增加 source 和 fetchedAt。源码位置及构造字段随上述返回类型一起修改，客户端按同一 envelope 读取。

## 九、配色与界面调整

保留现有深色卡片流、个人主页和底部双页签，仅统一色板、层级与操作反馈。主色沿用暖色方向，收敛成柔和珊瑚色；Star 保留琥珀色语义，状态使用低饱和绿色。移除个人页红、紫、橙同时叠加的背景光晕、主按钮红橙大渐变和常驻闪烁圆点，不增加大面积装饰图或新布局。

在 `client/src/style.css` 中定义统一 CSS 变量，再通过 Tailwind 的主题映射或明确的组件类引用；不要给每个组件分别复制一套色值。

| 变量 | 色值 | 用途 |
| --- | --- | --- |
| `--color-bg` | `#0E1116` | 页面与桌面窗口背景 |
| `--color-surface` | `#161B22` | 卡片和弹窗 |
| `--color-surface-raised` | `#1E252E` | 次级按钮、选中区域 |
| `--color-border` | `#303947` | 卡片边框和分隔线 |
| `--color-text` | `#EEF1F5` | 标题与正文 |
| `--color-text-muted` | `#A5AEBB` | 说明、简介与次要文字 |
| `--color-text-subtle` | `#8793A5` | 时间等辅助信息，不用于关键操作 |
| `--color-primary` | `#F47768` | 主按钮、选中线、关键链接 |
| `--color-primary-hover` | `#FF8B7D` | 主操作悬停 |
| `--color-on-primary` | `#1A1413` | 珊瑚色按钮上的文字 |
| `--color-star` | `#DDB66B` | Star 图标、已收藏状态 |
| `--color-success` | `#67B89A` | 已授权等成功状态 |
| `--color-danger` | `#F09595` | 删除、退出和错误信息 |

主按钮使用纯色与深色文字，不能在较亮的珊瑚色底上沿用小号白字。次级按钮使用 surface-raised 和浅色文字，清空、删除等操作平时使用描边或文字样式，只有确认弹窗突出危险动作。卡片标题用正文色，hover 或键盘 focus 时才使用主色，避免整屏链接都呈红色。

个人页顶部改为 surface 到 bg 的单向轻微明暗过渡，头像边框与页签下划线使用主色。Star 数与已 Star 状态使用 star 色，不再给普通仓库标签分配任意紫、蓝、红。主语言圆点可保留当前语言专属色，因为它承载数据含义；没有语言时使用中性色。

卡片圆角统一 16px，弹窗 24px，普通按钮 10～12px；正文内容和摘要以 13～14px 为主，时间等辅助文字不低于 11px。点击区域至少 44px 高，Android 底部导航加入 `env(safe-area-inset-bottom)`，页面高度采用动态视口，避免系统导航区遮挡。Windows 保留当前窄屏卡片体验，弹窗和长列表必须在最小窗口高度内可滚动，不扩大为仪表盘。

全局 `body { user-select: none }` 改为只作用于导航与装饰控件，账号授权码、仓库名称、错误说明和输入区域允许选择复制。加载只在正在请求的位置使用动画；长期在线状态用静态圆点与文字。图标优先使用已有的 lucide 依赖，减少设置项和状态中的装饰 emoji，不更换图标库。

颜色和排版验收以 Windows 实际窗口与 Android 真机为准。深色弹窗、禁用按钮、错误提示、长仓库名、空列表和离线缓存都需要能读清楚；不能只检查有数据时的一张页面截图。

## 十、开发顺序、合入与验收

从本地最新 develop 创建 `feature/v3-account-history`，该基线已包含 v2 的游客入口、后端框架与热门列表。不要从当前仍停留在旧版的 main 创建后续功能分支，也不要继续修改已合入的 v2 分支。执行前先确认实际分支、工作区和提交，本文中的 `7c1c0c8` 是设计快照，不能用于强行重置后续更新。

已有文件的改动范围如下，新文件职责按前文模块与函数约定实现。完成一个调用链后再处理下一条，避免先替换全部页面却仍依赖旧的虚构 store。

| 已有文件 | 必须完成的改动 |
| --- | --- |
| `client/src/stores/user.js` | 移除用户名伪登录、固定资料和数组；接入 session、同步与真实 Star 状态 |
| `client/src/App.vue` | 增加一次性初始化；按恢复结果控制弹窗；切换账号时重置个人页面状态 |
| `client/src/components/LoginModal.vue` | 移除用户名输入与 await emit；改为设备验证码、浏览器授权及受控加载状态 |
| `client/src/components/ProfileView.vue` | 替换真实字段；接入三类列表的完整性、分页和统一访问函数；修正文案 |
| `client/src/components/EditProfileModal.vue` | 改为本机兴趣设置，GitHub 资料只读并提供外部编辑入口 |
| `client/src/components/SettingsModal.vue` | 历史开关、清空、删除账号数据、同步与退出；删除虚构集群卡片 |
| `client/src/components/TrendingView.vue` | 移除内联网络、假数据与假收藏；调用 projects/account service |
| `client/src/style.css` | 统一语义色板、可选择文本、焦点及基础控件样式 |
| `client/electron/main.cjs` | 固定数据目录、preload、服务初始化、IPC、外链与窗口安全设置 |
| `client/scripts/build-win.mjs` | 保留复制完整 electron 目录；生产版本取自 package 配置，确认新增配置与 worker 被打包 |
| `client/package.json` 与 lockfile | 调整 Capacitor core 依赖位置，接入公开配置生成，脚本统一走 build 入口 |
| `client/android/.../MainActivity.java` | 注册 HappyGit 原生插件，保留正常 Capacitor 生命周期 |
| `client/android/.../AndroidManifest.xml` 与备份规则 | 个人数据备份排除；不增加公共存储权限或全局明文网络许可 |
| `client/android/app/build.gradle` | 读取公开构建配置、递增版本，按交付环境配置固定签名 |
| `server/.../controller/AuthController.java` | 移除伪认证接口 |
| `server/.../service/GitHubTrendingService.java` 与 ProjectController | 返回真实数据或真实缓存，暴露来源与时间，移除固定兜底 |
| `.github/workflows/build-apk.yml` | Node 24、公开 Client ID 注入、对应版本产物和明确的签名构建方式 |
| `.gitignore`、`.env.example` 与 README | 忽略生成配置、记录必需环境与双端实际能力，安装说明与产物一致 |

第一阶段先固定标准化模型、平台接口和数据库。创建两端数据库实现、迁移和受控原生桥，打通一个完整的本地历史 record/list/delete/clear 调用链，再将 App 初始化接入本地持久状态。这一阶段不以假授权开启个人功能，不增加能够伪装已登录的正式入口；边界场景所需数据在 develop 验证时使用隔离夹具准备。

第二阶段接入 Device Flow、凭据保管、刷新、恢复和切换。删除用户名即登录的实现与虚构资料，打通真实 `/user` 到 profile store。登录成功后再接入仓库和 Star 的分页同步，完成活动缓存原子切换及 Star 写入。先解决身份与数据真实性，再调整页面展示。

第三阶段统一所有项目访问入口，完成按账号隔离的本地历史、搜索和删除，并接入设置开关、退出保留、重新登录恢复与删除账号数据。之后替换个人页字段和误导性文案，去除热门假数据，处理 Android 后端地址配置。

第四阶段统一色板、按钮和状态反馈，核对 Windows 打包脚本是否复制 preload、数据库 worker、公开配置及其他新文件。当前脚本会复制整个 electron 目录，继续保持这一行为，避免只拷贝 main.cjs。新增依赖时同步 package-lock；不额外引入 SQLite npm 原生包，也不进行无关框架升级。

Android 的 `@capacitor/core` 是运行时依赖，应从 devDependencies 调整到 dependencies；这不是版本升级。CI 的 Node 20 与当前 Electron 44 的 Node 安装引擎要求不一致，本轮将构建环境统一为 Node 24。Gradle 仍按项目现有 JDK 17 与 SDK 配置运行，不顺带迁移整套 Android 工具链。APK 的 versionCode 应递增，并在持续覆盖安装时使用一致签名。

现有 CI 使用 assembleDebug，不同工作节点的默认 debug keystore 不保证一致，不能据此承诺覆盖升级。正式交付使用固定签名的 release APK，签名文件与密码通过部署环境的密钥管理提供，不进入源码；本地升级验证也必须使用同一把受控签名。若无法提供正式签名，应明确标注调试产物，并只在同一测试签名的两次构建间验证数据库保留。Windows 展示版本、生产 package.json 与 Android versionName 来自一致的发布版本约定，不继续在设置页写死旧的 alpha 文字。

功能分支用于开发，不要求每改一个文件就跑全套测试。功能完成后按项目流程合入 develop，再集中执行实际验证；发现缺陷从当时 develop 新建 `bugfix/*`，修复后回到 develop 复验。main 只接收已经在 develop 验证通过的版本。是否合并 main、推送和发布按实际授权执行，不因文档列出发布流程就提前操作。

develop 的构建检查应包含前端构建、Capacitor Android 同步、Android APK 编译、Windows 完整目录打包，以及涉及后端改动时的 Maven 构建。构建通过只说明产物可生成，以下业务场景仍需真实验证。开发记录要注明使用的提交、构建配置、安装包版本与实际结果，不把模拟响应当作真实 GitHub 授权证据。

| 场景 | 操作 | 通过条件 |
| --- | --- | --- |
| 首次游客启动 | 新数据目录启动，跳过授权，重启 | 保持游客选择；能浏览真实公开项目或明确空状态，不制造个人资料 |
| 授权成功 | 两端分别在系统浏览器完成授权 | 展示 GitHub 真实账号；令牌不出现在页面响应、日志与数据库 |
| 取消与过期 | 取消浏览器授权、等待用户码过期 | 不登录、不填假数据；旧账号切换失败时仍保持原账号 |
| 授权恢复 | 成功登录后完整关闭、重新启动 | 在线恢复同一 GitHub ID，不再次输入用户名或强制授权 |
| 凭据刷新 | 使用可控过期时间触发多个并发个人请求 | 只执行一次刷新；新凭据整体保存；个人请求恢复正常 |
| 分页完整性 | 使用超过 100 个公开仓库或 Star 的账号 | 能继续获取后续页；完整总数不等于页面长度；无重复 repoId |
| 列表中途失败 | 后续页请求失败或被限流 | 不覆盖上一轮完整缓存；显示部分失败及重试状态 |
| 空集合同步 | 在 GitHub 取消全部对应公开 Star 后同步 | 完整空结果替换旧缓存，不残留上轮条目 |
| Star 与取消 | 在两端操作同一公开仓库并在 GitHub 核对 | GitHub 实际状态变化；重新打开或刷新后仍正确 |
| 未安装仓库的 Star | 对未安装 HappyGit 到仓库的普通公开项目操作 | 用户授权能力可完成 Star；不要求给应用全部仓库内容权限 |
| 写入结果不确定 | Star 请求后断网或超时 | 不虚报成功；可查询确认或明确提示未确认 |
| 首次历史 | 点击热门页项目标题或查看源码 | 外部浏览器打开；本机新增带真实 repoId、URL 和时间的历史 |
| 重复历史 | 30 秒内多次点击同一仓库，再等待超过 30 秒访问 | 始终一条聚合记录；快速点击不加次数，后续访问按规则累加 |
| 全入口一致 | 从 Star、我的项目和历史重新访问 | 都走统一访问函数；历史来源和最近访问时间更新 |
| 重启恢复 | 写入后完整退出进程或 Android 强制停止再启动 | 已提交历史仍在；不依赖卸载前回调或页面内存 |
| 双账号隔离 | A 浏览，切换 B 浏览，再授权回 A | 两个 GitHub ID 的历史、偏好、缓存互不混入 |
| 旧请求隔离 | 同步 A 时切换 B，或查询历史时退出 | A 的迟到响应不覆盖 B，也不重新显示退出账号的资料 |
| 普通退出 | 退出后游客浏览，再授权同一账号 | 游客看不到旧资料；重新授权恢复原本机历史 |
| 关闭历史 | 关闭开关后访问多个项目，再开启 | 关闭期间无新增；既有历史保留；重新开启后恢复记录 |
| 清空和删除 | 分别删除一条、清空历史、删除本账号数据 | 三个边界准确；历史清空不触发 GitHub 取消 Star |
| 离线打开 | 已登录且有缓存时断网重启 | 显示缓存时间；历史可读写，远程 Star 不伪成功 |
| 授权撤销 | 在 GitHub 撤销后重新请求个人资源 | 进入需重新授权状态；保留本地历史可读，不套用其他身份 |
| 缓存真实性 | 删除真实热门缓存并断网 | 显示空状态，无写死仓库或假创建时间 |
| 覆盖升级 | 相同 ID 与签名、递增版本覆盖安装 Android；更新 Windows 目录 | 原数据库保留，迁移不删除历史 |
| 本地保留规则 | 准备超过 90 天和超过 5000 条的当前账号数据 | 只清理当前账号超限记录，排序与保留数量正确 |
| 小屏与键盘 | 最小桌面窗口、Android 导航区、软键盘展开 | 主要按钮可触达，授权码可复制，列表和弹窗可滚动 |

超过 100 项、30 秒计数、90 天和 5000 条保留等边界可使用独立数据目录和受控时间准备验证；真实授权、Star 写入、Android 浏览器返回、杀进程恢复和覆盖安装必须在实际运行环境完成。没有合适的大账号时可以分别验证分页编排与真实小账号接入，但须如实记录大账号真实同步尚未验证，不能直接标为全量完成。

交付记录应给出 develop 的实际验证结果、两个安装包或完整 Windows 应用目录的位置，以及仍未完成的场景。Windows 不只交付一个脱离 resources 的 exe；Android 编译成功也不能替代安装运行。界面和发布说明仅描述已经完成的账号接入、本地历史与公开数据同步能力，不沿用当前预发布说明中尚无实现依据的功能承诺。
