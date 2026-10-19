# HappyGit 修复复验记录

## 2026-10-19 授权预置与发布检查更新

当前代码为本地 develop `3b6f273`，未推送。预置地址统一由 `client/public-config.json` 或 CI 仓库变量提供，Windows 与 Android 安装包只输出公开 apiBaseUrl，不包含服务端凭据。发布前需读取实际授权状态接口；地址为空或服务未就绪时构建终止，普通用户不会再被要求自行填写网址。

本轮原有客户端回归 31 项和新增配置测试 5 项通过；后端授权测试 4 项及状态接口测试 2 项通过。开发前端构建和 Capacitor 同步成功，Android `:app:compileDebugJavaWithJavac :app:lintDebug` 通过，结果为 0 errors、12 warnings；本轮未生成新的分发 APK。`npm run build:release` 在当前空配置下按预期返回非零状态，未生成新的可分发安装包。启动真实 Spring Boot 进程后，`/api/auth/github/status` 返回 HTTP 200、`configured:false`，未返回应用凭据，结果保存在 `client/release/preconfigured-login-check/status.json`。

GitHub Actions 与 Compose 文件已通过 YAML 解析，三个官方容器镜像标签查询均返回 200；这不能替代容器运行或 GitHub Actions 实际执行。当前机器没有 Docker 运行环境，尚未完成容器构建、公网部署、证书签发或 GitHub 回调验证。代码检查使用保留的测试域名与隔离响应，未把这些地址写入实际公开配置。

实际部署仍缺项目方的服务器域名/连接方式与 GitHub OAuth 应用信息。因此目前只能确认预置机制就绪，不能确认用户下载后已经可以直接登录。旧安装包保持不变，不应作为完成授权预置的新版本分发。

---

复验日期：2026-10-19。代码基线为本地 develop `550d3b9`，修复提交 `56ca8a4` 和 `550d3b9` 均由 bugfix 分支集成后测试，未推送远端，未合入 main。下文 2026-10-18 内容保留为修复前的历史记录，其失败结论不代表当前版本。

当前登录已改为 GitHub 网页授权，不再要求用户输入设备码。服务端负责 state、PKCE、授权码交换和临时结果交付，客户端通过系统浏览器打开授权页。临时结果只允许原始客户端校验值读取一次，令牌不进入回调唤回链接，不进入 Vue；Windows 使用系统安全存储，Android 使用 Keystore，均不做明文降级。临时请求十分钟后失效，并定时清理；服务重启需重新登录。

`npm test` 在 Electron 44.9.0 内置 Node 24.22.0 下通过 31 项，失败 0。覆盖真实 SQLite 的资料与历史持久化、账号分区、时间去重、清理上限、分页、删除级联、SQL 字符串、同步页序与完整性、旧缓存保留、首次 Star 保存；也覆盖授权取消后的迟到响应、前端接受实际 state 契约、会话上下文、Star 内存隔离、未知状态、204 写入、本地缓存失败、超时确认及旧查询覆盖、兴趣偏好保存与 75 条分页。授权和 GitHub 个人接口使用隔离响应，不能替代真实账号验收。结果位于 `client/release/regression-1792341628879/results.json`。

后端 Maven 测试运行 4 项，失败 0、错误 0、跳过 0，报告位于 `server/target/surefire-reports/com.happygit.server.service.GitHubOAuthServiceTest.txt`。用例覆盖网页授权地址及 scope、双向随机校验、错误 state、一次性交换与读取、拒绝和取消、GitHub App 权限模式与刷新。令牌交换上游为测试进程内的 HTTP 夹具。另启动真实 Spring Boot 路由验证，未配置时 begin 返回 503，无效 callback 返回 400，响应保存在 `client/release/validation-20261019/`。

Windows `npm run build:win` 成功，产物为 `client/release/HappyGit-win-x64/HappyGit.exe`。使用隔离数据目录启动真实 Electron 窗口，GitHub 直连热门能加载，缺少授权服务地址时显示明确提示，游客入口可用；未读取或改动正式账号数据。Vue 页面夹具确认访问后浏览历史立即显示，标题与简介完整，数量显示 Star 75、仓库 120；Star 能从首屏加载到第 75 项，公开仓库后续页入口可用。截图为 `client/release/profile-fixed.png`，内容明确标注模拟数据。

Android 在校验过 SHA-256 的官方 JDK 21 下补齐工程要求的 SDK 36 和 Build-Tools 35，保持 Gradle 8.14.3、minSdk 24、targetSdk 36。`:app:assembleDebug :app:lintDebug` 成功；首次兼容检查发现 readAllBytes 需要 API 33，已改为兼容流读取后复验，最终 0 errors、12 warnings。剩余警告主要为既有资源、依赖版本与适配建议。APK 位于 `client/android/app/build/outputs/apk/debug/app-debug.apk`，属于调试构建。直接编译实际 GitHubClient.java 的 JVM 夹具也确认个人资料对象、仓库数组、Star 数组、204 空响应四项保留正确；这不是 Android 设备上的完整业务验收。

真实授权仍需配置服务端 `GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET、GITHUB_CALLBACK_URL` 和客户端 `VITE_API_BASE_URL`，详情见 `docs/github-login.md`。当前安装包的 apiBaseUrl 为空，未配置前不会跳到有效的 GitHub 应用授权。真实登录、令牌恢复与刷新、GitHub Star/取消 Star、真实双账号切换、Android 安装及同签名覆盖升级尚未完成。ADB 当前没有连接设备，也没有现成 AVD，不将构建通过写作真机通过。

![历史与总数修复后的隔离界面](<E:/happy git/client/release/profile-fixed.png>)

---

## 2026-10-18 修复前记录

# HappyGit v3 功能验证记录

验证日期：2026-10-18。远端最新功能分支为 `feature/v3-account-history`，提交 `f44a157aea260607f5c777fc80d80191449a43cc`，与本地功能分支一致。按项目“合入 develop 后集中测试”的约定，已将该提交快进合入本地 develop；远端 develop、main 均未更新。

当前版本未通过功能验收。前端与 Windows 产物可以生成，后端可以编译和访问真实 GitHub 热门接口，但账号登录、个人列表同步、Star 持久化和部分历史展示仍有阻断问题。本轮仅执行验证、生成隔离夹具和本记录，没有修改应用源代码或修复缺陷。

## 验证方式与结果边界

数据库验证直接调用现有 `database.cjs` 与 `database-worker.cjs`，运行在本地 Electron 自带的 Node 24.22.0 中，使用实际 SQLite 文件。授权与 IPC 验证加载实际业务模块，将网络、操作系统加密接口或已登录账号替换为受控夹具，检查边界行为；这部分不能作为真实 GitHub 授权和真实 Star 写入成功的证据。

前端状态验证加载实际 services、Pinia store 和 Vue 页面。浏览器中的个人资料、75 个 Star 和 120 个公开仓库来自明确标注的隔离夹具，不使用真实个人账号。Android 网络解析验证编译了仓库内实际的 `GitHubClient.java`，使用标准 org.json 与固定 HTTPS 响应，验证其解析逻辑；未将这项验证写成 Android 安装或真机验收通过。

22 项模块检查中，12 项通过、10 项失败；另外进行了 Android 响应解析、浏览器界面和后端真实 HTTP 检查。各层证据单独记录，不将构建、模拟和实际运行合并成一个“全部通过”。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 前端 `npm run build` | 通过 | Vite 8.3.4 生产资源生成成功 |
| Windows `npm run build:win` | 通过 | 完整应用目录已重新生成，含 preload、worker 和公开配置 |
| Capacitor `npx cap sync android` | 通过 | Web 资源与 Android 工程同步成功 |
| 后端 Maven test 生命周期 | 构建通过 | 编译成功；输出 `No tests to run`，仓库没有现成后端测试用例 |
| 后端真实热门接口 | 通过 | limit=2 返回 live/2 条，随后 limit=30 返回 cache/30 条；抓取时间一致 |
| 后端 limit 下限 | 通过 | limit=0 被限制为 1 条 |
| 后端无效参数 | 通过 | limit=abc 返回 HTTP 400 |
| 旧伪认证接口 | 已移除 | `/api/auth/profile?username=fixture` 返回 404 |
| 上游不可用且无缓存 | 通过 | 在受限网络环境返回 HTTP 503、total=0，不返回固定假项目 |
| Android APK 编译 | 环境阻塞 | Gradle 8.14.3 遇到 JDK 25 的 `Unsupported class file major version 69` |
| Android 设备安装 | 未验证 | ADB 可执行，但未连接设备，未配置可运行的 AVD |
| Electron 桌面窗口交互 | 未完成 | 受限启动出现 Chromium 安装目录 ACL 错误；正常权限启动未完成可控窗口验收 |
| 真实个人授权与远程 Star 写入 | 未验证 | 当前生成配置中的 GitHub Client ID 为空，未使用真实账号写操作 |

数据库已通过的功能包含：账号资料保存、首次历史写入、30 秒内去重及后续次数累加、账号数据分区、历史分页与关键词查询、单条删除、重启恢复、90 天清理、5000 条上限、清空不影响其他账号、删除账号后的级联清理。缺少 Client ID 时明确失败、原生模拟授权成功返回格式，以及技术兴趣的权重和手选优先规则也已检查。

上述通过项证明数据库领域函数和部分受控业务逻辑可用，不代表页面已经正确接入它们。

## 主要缺陷

**P1：真实授权结果无法被前端登录状态接受。** `client/electron/auth.cjs:218` 返回 `state: 'authenticated'`，Android 授权实现同样使用 state；`client/src/stores/user.js:205` 却检查 `progress.status === 'success'`，后面的等待、过期、拒绝分支也检查 status。用原生实际返回结构驱动 store 后，session.accountId 仍为 null。用户在浏览器授权后不能正常进入已登录状态。修复时需统一整个授权进度契约，包括成功值、间隔单位、过期、拒绝和取消；不能只改一个 success 字符串。

**P1：Windows 仓库同步和 Star 持久化直接报 SQL 错误。** `client/electron/database-worker.cjs:203` 的 `LIKE "gen_%"`，以及从 341 行开始多处 `kind = "stars"`，在当前内置 SQLite 中被当作列名。实际调用 beginSync 得到 `no such column: "gen_%"`，调用 applyConfirmedStar 得到 `no such column: "stars"`。需要对字符串使用单引号或参数绑定，并覆盖全部同类语句。另经代码复核，beginSync 目前按 gen_ 前缀删除数据，而活动版本同样使用该前缀；修复引号时必须同时改为只清理旧 staging，保留 active，避免语法修好后出现刷新丢缓存。

**P1：Android 仓库与 Star 列表响应被丢弃。** `client/android/app/src/main/java/com/happygit/app/nativebridge/GitHubClient.java:117` 将所有非空响应解析成 JSONObject，Response.body 也只声明为 JSONObject。但 ownedRepos、starredRepos 的正常响应顶层是 JSON 数组，解析异常被吞掉后 body 变为 null。直接运行该源文件的结果为：个人资料对象保留成功，仓库数组保留失败，Star 数组保留失败，204 空响应处理成功。需要让传输模型支持对象、数组和 null，并在 HappyGitPlugin 中按实际类型传回前端。

**P1：取消授权无法挡住已经发出的迟到成功响应。** `client/electron/auth.cjs:121` 在发请求前取得 challenge，`cancelAuthorization()` 只从 Map 删除它；等待中的请求回来后仍使用旧局部变量继续提交账号和凭据。复现步骤为发起 poll、取消 challenge、再让请求返回成功，最终仍得到 authenticated。需要在网络返回后和提交前重新检查 challenge 与会话版本，同时在退出时取消全部旧授权任务。

**P1：原生层没有落实账号上下文隔离。** `client/electron/main.cjs:97` 接收 contextId，却只检查调用 frame；后续数据库操作重新读取当前活动账号。以 B 为当前账号、携带 A 的旧 contextId 调用 history.record，实际将该请求写进了 B 的分区。Android 的 dispatch 同样接收 contextId 但未检查。修复应在个人操作入口验证上下文，捕获请求的账号归属，阻止迟到网络结果继续落库，并在切换或删除账号时完成队列边界处理。

**P2：Star 内存缓存串账号。** `client/src/services/account.js:15` 的 memoryStarCache 与 inflightStarQueries 只按 repoId 索引，退出和切换账号时未清理。模拟 A 已 Star、B 未 Star，先查询 A 再查询 B，同一 repoId 返回了 A 的 true。需按 accountId 或 contextId 分区，切换时清理旧查询结果；不能只修正数据库分区。

**P2：历史写入后没有更新历史 store。** `client/src/services/projects.js` 的 openRepository 完成记录后直接打开外链，没有刷新 history store；`ProfileView.vue` 切入个人页时也没有重新查询。使用序列化后的隔离桥响应，先点击热门项目“查看源码”，再进入我的，页面仍显示历史 0 和空列表；显式重新查询后才出现 1 条。需在记录成功后触发 history store 刷新或更新，并在账号切换时丢弃旧结果。

**P2：已查询到的历史条目缺少仓库名称和简介。** `client/src/components/ProfileView.vue:240` 读取 item.fullName，简介读取 item.description，但数据库与服务返回的字段位于 item.repository。界面实际出现空标题和“暂无描述”，语言及 Star 数却能正常显示。需统一使用 HistoryEntry 契约，完整检查名称、简介、时间、链接和来源，而不是给顶层字段再塞一份临时副本。

**P2：个人列表被首屏 30 条截断，数量仍声称完整。** user store 只加载 repositories.list 的第一页 30 条；个人页没有公开仓库和 Star 的后续加载入口，`ProfileView.vue:464` 又以 stars.length 作为完整总数。夹具明确返回 75 个 Star、120 个仓库和有效 nextOffset，页面实际显示“我的 Star 30”“我的项目 30”“已完整同步（共 30 项）”。需保留 total、nextOffset、complete，提供两类列表分页，并使用全量缓存计数显示总数。技术兴趣目前也只用首屏数组计算，需要改为完整集合或准确声明计算范围。

**P2：安全存储不可用时写明文凭据。** `client/electron/auth.cjs:59` 在 safeStorage 不可用时将 access token 和 refresh token 直接作为 UTF-8 JSON 写入 credentials.bin；读取路径也接受明文。模拟系统加密不可用后，文件中可直接检索测试令牌。需要明确返回存储不可用或采用不持久化会话，不得以明文降级。该条件检查仅使用测试令牌，没有读取用户真实凭据。

**P2：数据库分页完整性缺少约束。** writeSyncPage 接受了期望第 1 页时的第 99 页；finishSync 在 nextPage 仍为 2 时也提交了 complete=true。需要核对预期页码，保证至少处理第一页，且下一页为空才提交；保持每个 generation 的原子边界。

**P3：热门缓存重新标准化会丢失许可证。** `client/src/models/github.js` 的 normalizeRepository 只识别原始 license，没有识别规范化对象的 licenseSpdx。将带 MIT 的 Repository 作为本地缓存重新加载后得到 null。需明确原始 DTO 与规范化缓存的转换边界，避免对已有模型再次进行不完整映射。

## 证据与复现入口

模块验证脚本位于 `client/release/validation-20261018/checks.cjs`，机器可读结果为同目录的 results.json。脚本通过 Electron 的 Run as Node 模式调用项目实际模块，隔离数据库和授权文件位于独立 run 子目录，不访问正式 `%APPDATA%/HappyGit`。该目录被现有 release 忽略规则排除，不进入业务提交。

Android 网络解析夹具为同目录的 AndroidResponseCheck.java，它只替换进程内的 HTTPS 响应，未调用真实个人接口。浏览器界面夹具为 ui-fixture.html，导入实际 Vue 页面；profile-proof.png 保存历史条目空标题和错误数量的界面证据。夹具资料明确带有“模拟”标记。

后端正常网络结果保存在 backend-live.json，受限网络错误路径与旧接口检查保存在 backend-http.json；Android 构建阻塞日志为 android-build.log。前端构建、Windows 打包和 Maven 编译的结果见本轮命令输出。Maven 原有测试为空，因此不会以 BUILD SUCCESS 替代账号和持久化功能验收。

![隔离界面验证：历史缺少标题，75 个 Star 被显示为 30 个](</E:/happy git/client/release/validation-20261018/profile-proof.png>)

## 后续处理范围

当前不具备合入 main 的验证条件。建议从当前 develop 新建 bugfix 分支，优先统一授权协议、修复 SQLite、修正 Android 数组传输和账号上下文，再处理历史刷新、列表分页和缓存字段。修复完成后合回 develop，复验上述失败场景以及已有通过场景。

真实 GitHub 应用注册配置、真实授权后恢复、真实 Star 与取消 Star、双账号切换、Windows 原生窗口交互、Android 安装与同签名覆盖升级仍需单独补齐。APK 构建应使用项目支持的 JDK，并准备匹配 SDK；不能为绕过当前环境问题直接更换项目锁定的 Gradle 后就认定正式构建通过。
