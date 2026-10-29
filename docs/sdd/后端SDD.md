# HappyGit 后端软件设计说明书

函数级实施设计补充（2026-10-29）：[服务端详细设计](../design/v1/服务端详细设计.md)展开 API、事务、采集归档、调度与发布；新增一次性授权领取、公共批次和幂等回执等实现字段见[统一契约](../design/v1/接口与数据契约.md)。

版本：2.0，2026-10-28。源码核对基线：`develop@74bf0d0`。状态：待实现设计。本文负责在线 API、身份、采集、日志接入、批次发布和服务部署；算法以[Hadoop SDD](HadoopSDD.md)为准，持久化结构见[数据库 SDD](数据库SDD.md)，客户端交互见[前端 SDD](前端SDD.md)。四份文件共同替代原方案中“正常使用不需要服务端”的架构边界。

## 1. 现状与重构范围

当前 `server/pom.xml` 使用 Spring Boot 3.3.4 和 Java 17，主要依赖为 Web、Cache、Jackson 与测试依赖，没有服务端数据库访问层。`ProjectController.java:18` 下只有公开热门查询入口，`GitHubTrendingService.java:67` 通过 GitHub Search 拉取项目并在进程内缓存。`GitHubOAuthService.java` 有授权码交换与轮询机制，但当前轮询成功会返回 GitHub tokens，不是本设计需要的 HappyGit 服务端身份体系。

客户端当前通过原生网页会话采集，画像和推荐由本机 JavaScript Worker 计算，`client/public-config.json` 的 API 地址为空。现有 `deploy/compose.yaml` 只有 API 和 Caddy，不能据此声称已有 Hadoop 集群或在线画像数据库。

本次保留 Spring Boot 作为 HTTPS 业务入口，新增中心化身份与设备绑定、授权日志接入、公开数据采集、批处理编排、结果发布及群像查询。在线服务不实现另一套个人画像算法；没有成功的 Hadoop 结果时返回明确状态或公共热门，不用请求线程计算一个结果冒充集群产物。

## 2. 服务构成与职责

课程规模采用模块化服务，不拆成大量微服务。`server/` 运行在线 API；拟新增 `collector/` 运行采集、HDFS 归档和结果导入，使用 JDK 11；拟新增 `mapreduce/` 承载独立 Java 作业及 Driver，按 Hadoop SDD 的运行版本部署。任务状态与短期接收队列持久化到 MySQL 8.4，HDFS 保存批处理事实数据和产物；首版不依赖 Kafka、Redis、HBase 或单独的向量数据库。

| 模块 | 核心职责 | 明确输出 |
| --- | --- | --- |
| Auth / Session | OAuth 核验 GitHub 身份、签发本服务会话、撤销设备凭据 | 账号、设备绑定、应用会话 |
| Account / Preference | 公开资料、手动兴趣、隐藏项、云端分析状态 | 带 revision 的账号配置与输入快照 |
| EventIngestion | 接收连续事件序列、幂等校验、持久 ACK | 接收事件和 acceptedThroughSeq |
| PublicCollector | 公开项目、用户公开集合与活动采集 | 带来源和完成状态的采集批次 |
| HdfsArchiver | 将已接收事件分片归档、关闭文件、提交 Manifest | exportedThroughSeq、HDFS 输入路径 |
| PipelineCoordinator | 冻结输入、提交固定作业 DAG、记录运行状态 | runId、job/application 关联与状态 |
| ResultPublisher | 校验 Hadoop 产物、导入 staging、事务切换 generation | 可查询的统一结果版本 |
| Portrait / Recommendation / Cohort | 按登录身份读取已发布画像、候选和群像 | 稳定响应 DTO，不现场训练 |

Spring Boot 进程使用 Java 17，HDFS 客户端及 Hadoop 提交工具留在 JDK 11 的后台进程中，避免把两套运行环境强行放入同一 classpath。在线服务通过 MySQL 中的任务记录交给后台进程执行，固定任务类型和参数；HTTP 请求不得提交任意 shell 命令、JAR 路径或 HDFS 路径。

## 3. 身份与客户端接入

新增的服务端账号必须通过 GitHub OAuth 回调后调用 GitHub 当前用户接口核验，使用 GitHub 数字账号 ID 的字符串形式绑定 `app_users.github_account_id`。用户名可以变化，不作为稳定主键。内部 `user_id` 同时作为 Hadoop 的 `subjectId`；客户端延续使用 `accountId` 表示 GitHub ID，两者通过服务端绑定关系转换。

现有本机 GitHub 网页 Cookie 不能作为服务端认证依据，客户端上报一个 login 或 accountId 也不能完成登录。原有“使用 GitHub 登录”入口改为完成服务端身份接入，浏览器由系统或原生层打开，用户凭据只提交给 GitHub。服务端使用 state 和 PKCE 绑定授权流程，轮询凭证只可消费一次；细节遵循 [GitHub OAuth 授权流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

OAuth 只请求身份核验需要的最小范围，不沿用现有默认的 `public_repo` 写权限。上游 token 在核验身份后不交给 Vue 或 Hadoop；首版公开采集由服务端维护的采集凭据承担，上游登录 token 完成身份核验后从临时内存清除。普通客户端取得的是 HappyGit 自己的短期访问 token 和可轮换刷新 token，分别以 15 分钟和 30 天作为初始有效期；刷新后旧刷新 token 作废，数据库只存应用 token 摘要。

凭据由 Electron 原生安全存储或 Android Keystore 支持的存储持有，渲染层只取得账号状态。配置维护者预置 `apiBaseUrl`，普通用户不填写 Hadoop 地址、数据库地址或 Client Secret。测试和生产使用不同服务地址、数据库与凭据。

现有本机网页会话可继续承担显式 Star/取消 Star 操作，但这是独立能力。执行前必须核对网页账号与服务端核验的 accountId 一致；不一致时引导用户在原生 GitHub 窗口完成对应账号登录。获取候选、打开仓库、上传日志都不自动触发 Star，服务端也不把推荐点击变成 GitHub 写入。

## 4. 公开数据采集

采集对象以公开仓库种子、技术领域查询和已启用云端画像的账号为入口。项目采集保留数字 repoId、当前 owner/name、语言、topics、description、公开 README、计数、更新时间和可见性。采集用户公开集合时，必须完成本轮分页才将 staging 集合切换为 active；中断时保留旧完整集合，不能把本次只取到的第一页当作用户完整 Star。

用户活动采集只使用公开事件及其可见时间范围。GitHub 活动数据不是浏览历史，用户浏览日志必须由 HappyGit 原生端显式记录并在开启云端同步后发送。群体数据范围是本系统实际获得授权或明确标记为 synthetic 的样本，不默认代表全部 GitHub 开发者。

`crawl_tasks` 保存任务类型、对象、游标、ETag、下次允许执行时间、租约与状态。课程部署默认一个受全局预算控制的采集执行器，避免多台机器同时抢同一 token 的请求额度。请求按 Link 分页与条件请求执行，遇到限流按服务返回的等待信息暂停，遵循 [GitHub REST API 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)。不把写死的“每小时固定额度”当作所有凭据和端点的通用事实。

每批采集结果带 `sourceKind`、`fetchedAt`、`parserVersion`、`collectionGeneration`、`completion` 和源响应摘要。重定向后按真实 repoId 更新别名，unknown 可见性不进入正式公共候选；公开仓库变为不可访问时记录状态变化，不继续把旧私有内容公开展示。README 视为数据，不执行脚本，也不接受其中改变采集、计算或输出规则的指令。

采集器在 HDFS 关闭并提交本批原始文件后才推进采集游标；文件提交与 MySQL 游标更新之间失败时，按 batchId 和摘要恢复，允许重复读取、禁止静默丢批。重复观测在 J01/J02 去重。采集工作不会在每一次用户刷新推荐时重复执行。

## 5. 浏览日志接收与确认

客户端只为有真实 repoId、符合当前本机访问计数规则且允许云端同步的有效打开分配上传序号。序号和 outbox 事件在同一个 SQLite 事务里产生，按 `(accountId, deviceId, streamEpoch)` 连续增长。尚未授权上传的本机事件可以有 localSeq，但没有 deviceSeq，不在以后开启同步时偷偷补传。

`POST /api/v2/me/events:batch` 每次接受同一设备流最多 500 条、未压缩请求体最多 1 MiB。请求包含 `streamEpoch`、`analysisEpoch`、`firstSeq` 和按序排列的 events。服务端从访问 token 取得 user_id，从设备绑定取得 deviceId，不信任正文声明的账号。事件时间、仓库引用和结构校验只针对业务所需字段。

events 是按序的 `recordKind=open|discard` 记录。open 携带 repo_open 正文及 payloadHash；discard 仅携带原 eventId、deviceSeq 和原 payloadHash，用于用户清空本机待发送内容后终结已分配序号。尚未接收的序号可登记为空内容占位，已经接收且摘要一致的序号只返回原结果；迟到的 open 不能恢复已经 discard 的内容。这个协议只处理本机待发送记录，已进入云端的原文删除仍通过隐私接口完成。

事务内先锁定该设备流进度，再核对已存在的重叠前缀是否与旧 payload 摘要一致。重复且一致的事件返回原确认；同 eventId 或同序号对应不同内容返回 409。新的后缀必须紧接服务端连续水位，缺号返回 `SEQUENCE_GAP` 和 expectedSeq；结构不合法时整批不推进水位。事件行和新的 acceptedThroughSeq 成功提交后才返回 ACK。

```json
{
  "requestId": "request-example",
  "data": {
    "deviceId": "device-example",
    "streamEpoch": "stream-example",
    "acceptedThroughSeq": 105,
    "exportedThroughSeq": 100,
    "serverTime": 1793116800000
  }
}
```

上例仅说明响应结构和水位差异，不是实际用户或运行结果。`serverTime` 只用于客户端时间校正与展示，不能替代设备序号去重。单条事件时间超过收到时间 5 分钟以上时保留原始时间但以 receivedAt 作为计算时间并标记时钟修正；早于 90 天窗口的事件可以接收后在计算中明确忽略。这样网络重试和时钟偏差不会造成客户端无限等待一条永远无法确认的正常序列。

发生时间修正时，响应额外携带 `timeAdjustments:[{eventId,effectiveAt}]`；重复请求返回相同修正。原生层保存 effectiveAt 供后续本机衰减使用，原始 occurredAt 与 payloadHash 不改写。没有修正时该数组为空。

HdfsArchiver 从已提交事件读取连续范围，按 batchId 写临时文件，关闭后在同一 HDFS 命名空间提交为不可变文件，再登记导出 Manifest 和 exportedThroughSeq。若只写成功文件而数据库尚未确认，重试先核对既有 batchId；不重新生成另一份逻辑事件。在线 ACK 后即使集群临时不可用，持久接收记录仍可继续归档。

队列达到配置容量时，新批次返回 503 和可重试等待信息，客户端继续保留本机 outbox。不会先确认成功再丢弃事件。接收进度、HDFS 归档进度和画像处理进度是三种不同状态，API 和页面不能混用。

## 6. 在线接口与结果契约

新接口统一以 `/api/v2` 为前缀，HTTP 状态码表达请求状态；正常业务响应为 `{requestId,data}`，错误为 `{requestId,error:{code,message,retryAfterMs?}}`。错误不返回内部堆栈、SQL、Cookie 或上游 token。旧 `/api/projects/trending` 和 `/api/auth/github/*` 保留迁移兼容范围，不能把新响应直接塞给依赖旧形态的客户端。

| 接口 | 语义及主要字段 |
| --- | --- |
| `POST /auth/github/begin` | 创建 state/PKCE 授权任务，返回 challengeId、authorizationUrl、轮询间隔 |
| `GET /auth/github/callback` | GitHub 回调；核验身份后登记待领取的 HappyGit 会话 |
| `POST /auth/github/poll` | 持轮询证明领取一次应用会话，返回 accountId 和原生层凭据 |
| `POST /auth/refresh`、`POST /auth/logout` | 轮换或撤销当前应用会话 |
| `POST /me/devices` | 幂等注册本设备并绑定 streamEpoch、analysisEpoch |
| `GET /me/account` | 公开资料、当前偏好、云端分析状态、相关 revision |
| `GET /me/repositories?kind=owned\|stars&cursor=...` | 读取固定完整集合快照的成员，返回 collectionId 和 nextCursor，支撑原个人页两个项目列表 |
| `PUT /me/preferences` | 以 expectedRevision 更新手动兴趣、云端分析开关 |
| `PUT /me/feedback/{repoId}` | 以 mutationId 幂等设置 hidden，立即影响候选读取和下一轮画像 |
| `POST /me/events:batch` | 接收上述连续行为批次并返回持久 ACK |
| `GET /me/sync-state` | 返回本设备的接收/导出进度、当前已发布处理水位及隐私版本 |
| `GET /me/recommendation-bundle` | 原子选定 generation，返回基础画像、候选、处理水位和版本 |
| `GET /me/portrait?generationId=...` | 读取指定已发布 generation 的个人画像，用于画像面板 |
| `GET /cohorts/summary?generationId=...` | 同版群体人数、分布、覆盖率、更新时间及数据来源 |
| `GET /feature-spaces/{version}` | 下载对应不可变词表、IDF、规则及摘要，支持 ETag |
| `GET /projects/{repoId}` | 读取已采集的公开项目详情；无缓存时返回待采集状态 |
| `GET /projects/popular` | 读取 J12 发布的公共候选包及公开向量，不承诺是 GitHub 官方 Trending |
| `POST /me/privacy-requests` | 请求清除云端浏览或删除云端账号，返回处理状态和新的隐私版本 |
| `GET /me/privacy-requests/{requestId}` | 查询逻辑屏蔽、重算和物理清理进度 |

表中路径均相对于 `/api/v2`。画像刷新可以通过一个幂等的待更新标记加入下一轮批次，但普通接口不得直接上传任意模型或启动任意 Hadoop 作业。运维查询 run/job 的接口只对管理员可用，不作为普通客户端设置项。

候选包采用以下字段契约，定义中的名称是跨端约定，不表示当前代码已经存在这些类型。

```ts
type SparseVector = {
  dimension: 8192;
  indices: number[];             // 严格递增，无重复
  values: number[];              // 与 indices 等长，有限数
};

type RecommendationBundle = {
  accountId: string;
  generationId: string;
  batchId: string;
  mode: 'personalized' | 'cold_start';
  datasetKind: 'real' | 'synthetic';
  modelVersion: 'mr-content-v2';
  featureSpaceVersion: string;
  catalogSnapshotId: string;
  generatedAt: number;
  expiresAt: number;
  privacyRevision: number;
  analysisEpoch: number;
  preferenceRevision: number;
  feedbackRevision: number;
  processedThrough: Array<{
    deviceId: string; streamEpoch: string; processedThroughSeq: number;
  }>;
  profile: {
    vector: SparseVector;
    languages: Record<string, number>;
    topics: Record<string, number>;
    topInterests: Array<{tag: string; score: number; evidenceRepos: string[]}>;
    evidenceCount: number;
    sourceCoverage: {
      windowStart: number; windowEnd: number;
      browseEventCount: number; usableEvidenceRepoCount: number;
      missingFeatureEventCount: number;
      starsComplete: boolean; ownedComplete: boolean;
      activityObservedFrom: number | null; activityObservedTo: number | null;
    };
  };
  candidates: Array<{
    repoId: string;
    repository: object;           // 兼容现有 Repository DTO 的完整卡片字段
    vector: SparseVector;
    serverSimilarity: number | null;
    qualityScore: number | null;
    freshnessScore: number | null;
    recallSource: 'similarity' | 'popular';
    reasons: Array<{kind: string; tag?: string; evidenceRepoIds?: string[]}>;
  }>;
  coverage: 'complete' | 'partial';
};
```

`batchId` 指服务器该用户的候选批次，客户端最终展示批次另用 `clientBatchId`，不能覆盖它。推荐包默认最多 300 个去重项目、24 小时有效，FeatureSpace 制品按版本缓存。API 可以即时剔除新隐藏、失去公开可见性或已撤回授权的项，结果因此少于 300 时标记 partial，不在线重算补齐。

基础画像、候选、词表版本和 processedThrough 来自同一 generation。查询开始时确定 generationId，在同一只读事务或同一固定版本参数下读取全部关联行；读取中途 active_generation 切换不影响这次响应。客户端分开读取画像面板与群像时也传入这个 generationId，避免把不同时间的统计拼成一个结果。

`GET /projects/popular` 返回公共包，保留 generationId、batchId、datasetKind、catalogSnapshotId、featureSpaceVersion、时间与 candidates 字段，mode 为 public，不包含 accountId、profile 或设备水位。这样尚无正式画像或未开启云端分析的客户端也能取得同版项目向量，使用空基础加本机增量重排；界面来源仍明确是公共候选。公共包的 batchId 位于公共批次命名空间，不伪装成用户个人批次。

群体响应为 `{generationId,datasetKind,generatedAt,windowStart,windowEnd,totalEligibleUsers,insufficientEvidenceUsers,groups}`。每个 group 包含 cohortId、memberCount、validCounts、languages、topics、topInterests、representativeRepositories 和 suppressed；被抑制的小群体只返回标识与 suppressed=true，不返回细分分布或成员身份。无对应已发布群体结果时返回 pending，不让前端自行用本机数据估算。

首版真实数据通道只开放完整统计窗口，不提供任意用户筛选或反复缩小群体的交叉查询。小样本抑制减少明细暴露，但不能称为数学匿名性保证；不开放成员列表和逐人画像导出。

没有任何已发布版本返回 202，data 中给出 `state=pending`、下次建议刷新时间和是否可读公共热门；不返回空数组却标记“画像成功”。存在未过期旧版本时允许返回它并说明实际 generatedAt；网络离线、版本过期和隐私失效分别由客户端按前端 SDD 处理。

## 7. 计算编排与发布事务

Coordinator 在固定调度点冻结仓库、用户配置、有效数据源、事件导出边界及隐私版本，写入 InputManifest 后建立唯一 runId。用户反复点击刷新只合并更新需求，不创建同输入的无限任务。调度器持有数据库租约，进程重启后根据 job/application 记录恢复状态，避免重复启动整条作业链。

run 状态依次为 `queued → running → validating → publishing → published`，失败进入 failed，主动取消进入 cancelled。Hadoop 成功只表示作业产物可用；校验和在线导入完成之前不能显示 published。作业启动参数由固定配置与 Manifest 生成，客户端不选择 Reducer 数量或任务类。

Publisher 校验输出 schema、各输入摘要、模型和词表版本、用户/项目引用、统计守恒与候选数量。然后把仓库向量、个人画像、水位、群体报告和候选写入相同 generation 的 staging 行。每张表按 generation 与主键幂等写入，重复导入不产生另一套候选。

切换前，在事务中锁定当前发布指针和本次涉及账号的隐私状态，确认从冻结到现在没有撤回或 epoch 变化。若发生变化，该 run 不得成为新 active generation，重新冻结后重算；当前 API 已按最新隐私状态屏蔽被影响用户。其余数据可保留为未发布产物供排查，不通过过滤几行候选就宣称群体统计也已正确扣除。

事务提交后才将生成状态标记 published 并更新可查询的 processedThrough。发布中断时客户端继续读取旧完整版本；若旧版本因隐私操作已失效，则只提供公共结果。不得只先切个人画像、过几分钟再切候选和水位。

## 8. 同步授权、撤回与数据删除

本机记录开关和云端同步开关分别呈现。迁移用户默认不开启云端同步，保留其已有本机历史；用户主动开启后才创建上传流并纳入云端分析。未开启云端画像时可以读取公共推荐并使用允许的本机近期调整，不把历史记录或完整本地向量隐式发送出去。群体报告仅纳入已启用云端分析的真实账号或单独实验通道的合成用户。

“清空本机历史”仅删除当前设备的历史和微调输入，不表示服务器已经删除以前上传的数据，界面必须保留这个范围说明。停止本机记录不自动删除既有云端记录；停止云端分析和清空云端浏览有单独的明确操作，原有“删除本账号本机数据”仍按本机范围执行。

关闭云端分析、清空云端浏览或删除云端账号时，服务端先增加 privacyRevision，使当前个人画像与含该用户的旧群体版本失效，并将撤回标记送入下一轮输入。清空云端浏览还增加 analysisEpoch，客户端废弃旧上传流、清理被清空范围的本机增量，再从新流 seq=1 开始。迟到的旧 epoch 请求返回 `ANALYSIS_RESET`，不能重新灌回已清除的数据。

HDFS 不能按数据库单行 DELETE 修改历史文件，因此先逻辑过滤，再由受影响分区重写任务完成物理清理。接口分别报告 logicalBlocked、recomputed、purged 状态；旧输出、归档和备份也受保留期约束，不把“界面不显示”声称为“所有副本立即擦除”。此处只定义数据实际生命周期，不做额外合规认证声明。

## 9. 部署、运行状态与迁移

原部署入口继续由 Caddy 终止 HTTPS。扩展部署需加入 MySQL 的持久卷、collector/archiver/publisher 后台进程与 Hadoop 三节点配置，数据库与集群端口不对客户端开放。API 启动只检查自身所需配置和数据库连接；Hadoop 暂不可用时可读取已有结果和接受未超容量的持久队列，不要求每次请求遍历所有环境组件。

网络读取、事件接收、采集分页和任务提交有针对性的超时；幂等请求按响应等待后重试。唯一性冲突、缺号、会话切换、词表不兼容和隐私失效各返回明确业务码。只记录 requestId、任务 ID、摘要、数量及耗时，不输出敏感 token、Cookie 或整份用户行为到普通日志。

现有 GitHub 登录和公共热门实现可作为迁移参考，但新接口使用独立 `/api/v2`；客户端通过预置配置连接新服务。旧本地 content-v1 结果仅在迁移前使用，完成新模式接入后从正式个人画像链路退出。项目 DTO 继续兼容现有卡片，服务端不能只返回向量而丢掉名称、链接、语言和公开可见性。

开发建议先在 `feature/server-cloud-contract` 完成身份与契约，再接入日志和发布模块。只将本次相关改动合入 develop 后集中验证；发现缺陷从 develop 开 bugfix 分支。不得为迁移删除用户原库，也不得自动提交已有未跟踪实验材料。

## 10. 后端验收标准

验收以冻结数据和真实请求为证据：另一账号不能读取本人的画像；相同批次重复接收不新增事件，序号缺口不会错误确认；ACK 之后重启服务仍可归档；Hadoop 失败不会发布半批结果；新 generation 的画像、候选和水位能够完整追溯到相同 InputManifest。

联调还需覆盖旧 epoch 迟到请求、隐藏项立即剔除、公开集合分页中断、FeatureSpace 更换和两个设备同时上传。这里验证具体业务边界，不新增与业务无关的异常扫描。缓存候选包接口 P95 1 秒、500 条事件批次 P95 2 秒为初始目标，必须附实际硬件和负载后报告结果。

本次仅完成 SDD。服务端 API、MySQL 接入、采集器、身份迁移和任务发布仍未实现，没有执行真实 GitHub 授权、上传或 Hadoop 发布验收。
