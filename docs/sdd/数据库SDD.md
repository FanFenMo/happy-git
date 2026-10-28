# HappyGit 数据库软件设计说明书

版本：2.0，2026-10-28。源码核对基线：`develop@74bf0d0`。状态：待实现设计。本文定义服务端 MySQL、HDFS 和客户端 SQLite 的数据职责及一致性；调用契约见[后端 SDD](后端SDD.md)，计算口径见[Hadoop SDD](HadoopSDD.md)，客户端使用方式见[前端 SDD](前端SDD.md)。文中的新增表和迁移均尚未执行。

## 1. 现有数据与目标分层

当前 Windows 使用 `client/electron/database-worker.cjs` 中的 `node:sqlite`，在 worker 线程持有连接；Android 使用 `HappyGitDbHelper.java` 和原生仓储。两端已定义 SQLite schema v2，包含账号、偏好、聚合历史、公开集合缓存、版本记录、公共项目目录、网页操作、画像和推荐批次等表。服务端 `pom.xml` 尚无持久化依赖，也没有中心画像或 Hadoop 结果表。

现有 `browse_history` 以 `(account_id,repo_id)` 保存聚合访问次数和首末时间，不是逐次日志。仅凭该表无法推导每次访问时间、设备序号或 eventId，因此迁移保留本机数据，但不生成假日志上传。当前 `interest_profiles`、`recommendation_batches` 的 content-v1 数据也不能改一个版本号就成为 Hadoop 结果。

| 存储层 | 数据职责 | 访问方式 |
| --- | --- | --- |
| MySQL 8.4 / InnoDB | 身份、设备与授权、短期可靠接收、任务状态、已发布画像和候选 | API 和后台进程按主键/索引读写 |
| HDFS 3.4.2 | 不可变公开数据、授权事件归档、计算快照、中间结果、最终计算制品 | 采集/归档进程写，MapReduce 批量读写 |
| SQLite v3 | 本机历史、待上传事件、服务器结果缓存、近期微调及固定展示批次 | 原生层事务访问，Vue 不直接执行 SQL |

MySQL 中暂存事件是可靠接入队列，不承担替代 MapReduce 的历史扫描和画像生成。HDFS 是计算事实与重放数据来源，MySQL 在线结果是由 HDFS 产物导入的服务副本。首版不添加 HBase、Hive 或独立向量库，以便课程系统能在有限资源中完整运行。

## 2. 标识、时间与版本

服务端 `user_id` 使用 UUID，对外账号 ID 使用 GitHub 数字 ID 字符串；HDFS 的 subjectId 对应 user_id，映射仅在受控服务端保存。`repo_id` 同样使用 GitHub 数字 ID 字符串，owner/name 只作当前名称和别名。真实项目进入推荐前必须有确定的 repo_id，不能把名称字符串与数字 ID 混用。

MySQL 字符数据采用 utf8mb4，业务 ID 列采用区分大小写的二进制比较规则；索引和外键列类型、长度、排序规则一致。所有网络时间为 UTC 毫秒，数据库时间列采用 BIGINT 保存同一值，页面再转换为北京时间。deviceSeq、revision 必须在 JavaScript 安全整数范围内，超过范围时升级协议而非静默舍入；UUID、GitHub ID 和哈希始终是字符串。

| 版本字段 | 含义及所有者 |
| --- | --- |
| schemaVersion | 单条事件或制品的结构版本，由契约定义 |
| modelVersion | 算法规则版本，本轮为 `mr-content-v2` |
| featureSpaceVersion | 8192 维坐标、IDF、分词和权重制品的 SHA-256 摘要 |
| catalogSnapshotId | 本轮冻结的公开项目语料版本 |
| generationId | 一次正式发布的画像、群像及候选集合版本 |
| batchId / clientBatchId | 服务端某用户候选批次 / 本机最终排序批次 |
| privacyRevision / analysisEpoch | 隐私状态修订 / 云端分析数据重置代次 |
| preferenceRevision / feedbackRevision | 手选兴趣和隐藏反馈的并发修订 |
| streamEpoch / deviceSeq | 设备上传流代次 / 此流的连续事件序号 |

相同生成时间不等于相同版本。仓库向量主键同时包含 catalogSnapshotId、featureSpaceVersion 和 repoId；只有同版向量可以计算相似度。旧版原始项目文本可以重新投影，新旧向量不能直接复用。

## 3. MySQL 逻辑模型

以下表为目标模型，不是当前已经建好的数据库。普通业务 JSON 使用 camelCase，数据库列用 snake_case；映射由 Repository 层统一处理。

| 表 | 主键和关键字段 | 约束与用途 |
| --- | --- | --- |
| `app_users` | user_id；github_account_id、login、state、cloud_sync_enabled、analysis_epoch、privacy_revision、feedback_revision | GitHub ID 唯一；用户状态为访问控制依据；feedback_revision 为该用户全局反馈修订 |
| `user_preferences` | user_id；manual_tags_json、preference_revision、updated_at | 一人一行，带 expectedRevision 更新 |
| `user_repo_feedback` | user_id + repo_id；hidden、mutation_id、feedback_revision | 同一意图幂等；当前隐藏集合参与即时过滤和批次快照 |
| `app_sessions` | session_id；user_id、device_id、access_hash、refresh_hash、expires_at、revoked_at | token 摘要唯一；不存明文应用凭据 |
| `devices` | user_id + device_id；platform、registered_at、revoked_at | 设备绑定属于账号，不凭设备 ID 获得身份 |
| `device_streams` | user_id + device_id + stream_epoch；analysis_epoch、accepted_through_seq、exported_through_seq、state | 连续接收与归档水位；processed 水位不在此覆盖保存 |
| `ingest_events` | user_id + device_id + stream_epoch + device_seq；event_id、record_kind、payload_hash、payload_json、archive_batch_id、received_at | `(user_id,event_id)` 唯一；接收事务与水位共提交；归档后可只留回执元数据 |
| `archive_batches` / `archive_batch_streams` | archive_batch_id；HDFS 路径、摘要、状态；子表记录各流的 first_seq/last_seq | 归档幂等，只有完整文件可推进导出水位 |
| `repositories` / `repository_aliases` | repo_id；当前公开项目 DTO、可见性、fetched_at；别名指向 repo_id | 当前状态用于展示校正；冻结计算不直接扫描此可变表 |
| `crawl_tasks` | task_id；kind、target、cursor、etag、next_run_at、lease_until、state | 可续采集；同类同对象的活动任务去重 |
| `collection_snapshots` / `collection_members` | collection_id；user_id、kind、completion、generation、HDFS 路径；成员主键为 collection_id + repo_id | 只有完整集合可切 active；保留分页完成状态 |
| `catalog_snapshots` | catalog_snapshot_id；source_kind、manifest_path、count、created_at | 冻结公开语料，计数从真实文件导出 |
| `feature_spaces` | feature_space_version；artifact_path、dimension、sha256、created_at | dimension=8192，制品内容不可覆盖 |
| `pipeline_runs` / `job_runs` | run_id；Manifest、状态、配置摘要；子表 job/application ID、计数与耗时 | 记录调度和实际集群证据 |
| `published_generations` | generation_id；run_id、catalog_snapshot_id、feature_space_version、model_version、dataset_kind、state、cohort_invalidated_at | 同一批次的所有结果关联此行；dataset_kind 区分 real/synthetic；隐私变化立即屏蔽旧群体统计 |
| `publication_channels` | channel；active_generation_id | 生产与 synthetic 通道分开，事务切换可见版本 |
| `repository_vectors` | catalog_snapshot_id + feature_space_version + repo_id；vector_json、display_json、quality/freshness | 同版项目向量与冻结卡片快照 |
| `user_portraits` | generation_id + user_id；vector_json、summary_json、privacy_revision、analysis_epoch、输入修订 | 正式基础画像，只由发布器写入 |
| `portrait_watermarks` | generation_id + user_id + device_id + stream_epoch；processed_through_seq | 与画像绑定，不用全局时间替代 |
| `recommendation_batches` | batch_id；generation_id、user_id、mode、coverage、created_at、expires_at | `(generation_id,user_id)` 唯一 |
| `recommendation_items` | batch_id + position；repo_id、server_similarity、recall_source、reasons_json | `(batch_id,repo_id)` 唯一，不存任意重复补足条目 |
| `cohort_portraits` | generation_id + cohort_id；member_count、valid_counts_json、distribution_json、centroid_json | 群体统计只暴露聚合，保留有效分母 |
| `privacy_requests` / `analysis_tombstones` | request_id；user_id、kind、新隐私版本、逻辑/重算/物理清理状态 | 可追溯撤回和重写，不伪装即时物理擦除 |

`sourceCoverage` 固定记录 windowStart、windowEnd、browseEventCount、usableEvidenceRepoCount、missingFeatureEventCount、starsComplete、ownedComplete、activityObservedFrom 和 activityObservedTo。GitHub 活动覆盖区间只是本系统实际观测范围，不另设一个无法证实的“完整历史”标志。群体 `validCounts` 分别统计可计算语言、topic 和向量的成员数。

`repository_vectors.display_json` 保留 repoId、canonicalKey、owner、name、fullName、htmlUrl、description、primaryLanguage、topics、公开可见性、Star/Fork 数及精度、更新时间和 licenseSpdx。候选包可以不携带完整 README，详情另取，但不能像当前特征对象那样只剩向量和少量指标而丢失卡片身份字段。

对用户读取候选的常用路径建立 `recommendation_batches(user_id,created_at)`、`recommendation_items(batch_id,position)` 索引；接入归档使用设备流主键范围及 `archive_batches(state,created_at)`；调度使用 `crawl_tasks(state,next_run_at)` 和 `pipeline_runs(state,created_at)`。JSON 内部临时字段不逐个建索引，避免为没有实际查询需求的列增加维护成本。

## 4. 核心约束与事务设计

下面是实施时必须保持的核心 DDL 约束片段，省略审计列和已在上表定义的配套表，不作为可以直接运行的完整迁移脚本。项目实现应据此编写正式版本迁移。字段级约束和事务内锁定读取分别参考 [MySQL CHECK Constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html) 与 [InnoDB Locking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)。

```sql
CREATE TABLE device_streams (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stream_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  analysis_epoch BIGINT UNSIGNED NOT NULL,
  accepted_through_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  exported_through_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  state VARCHAR(16) NOT NULL,
  PRIMARY KEY (user_id, device_id, stream_epoch),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id),
  CHECK (exported_through_seq <= accepted_through_seq)
) ENGINE=InnoDB;

CREATE TABLE ingest_events (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stream_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_seq BIGINT UNSIGNED NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  record_kind VARCHAR(16) NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NULL,
  effective_at BIGINT NULL,
  archive_batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  received_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id, stream_epoch, device_seq),
  UNIQUE KEY uq_user_event (user_id, event_id),
  FOREIGN KEY (user_id, device_id, stream_epoch)
    REFERENCES device_streams(user_id, device_id, stream_epoch),
  CHECK (device_seq > 0),
  CHECK (record_kind IN ('open', 'discard')),
  CHECK ((record_kind = 'open' AND (payload_json IS NOT NULL OR archive_batch_id IS NOT NULL))
      OR (record_kind = 'discard' AND payload_json IS NULL))
) ENGINE=InnoDB;

CREATE TABLE portrait_watermarks (
  generation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stream_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  processed_through_seq BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (generation_id, user_id, device_id, stream_epoch),
  FOREIGN KEY (generation_id, user_id)
    REFERENCES user_portraits(generation_id, user_id)
) ENGINE=InnoDB;

CREATE TABLE recommendation_items (
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  repo_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  server_similarity DOUBLE NULL,
  recall_source VARCHAR(16) NOT NULL,
  reasons_json JSON NOT NULL,
  PRIMARY KEY (batch_id, position),
  UNIQUE KEY uq_batch_repo (batch_id, repo_id),
  FOREIGN KEY (batch_id) REFERENCES recommendation_batches(batch_id),
  FOREIGN KEY (repo_id) REFERENCES repositories(repo_id),
  CHECK (position BETWEEN 1 AND 300),
  CHECK (recall_source IN ('similarity', 'popular')),
  CHECK (server_similarity IS NULL
      OR (server_similarity >= 0 AND server_similarity <= 1))
) ENGINE=InnoDB;
```

每个普通有效打开的 payloadHash 根据固定字段顺序的 UTF-8 紧凑序列化计算，字段为 schemaVersion、eventId、streamEpoch、deviceSeq、analysisEpoch、repoId、occurredAt、source；不用各语言默认对象顺序。服务端重算并验证摘要。接收时锁设备流，校验重叠前缀、插入新连续后缀、推进 acceptedThroughSeq，在同一事务提交；唯一索引是并发幂等的最后约束。

本机清空历史时，已分配序号但未发送的记录不能直接删除并留下永久序号缺口。客户端把相应 outbox 项改成 `recordKind=discard` 的最小占位记录，只留下原 eventId、序号和原 payloadHash，不再上传 repoId 或时间等内容。服务端若尚未收到此序号就登记 discard；若此前已收到且摘要一致，只确认原接收结果，不把本地清空擅自解释为云端删除。正常事件晚于 discard 到达时仅返回该序号已终结的状态，不恢复其内容。discard 同样进入归档并被作业明确忽略。

HDFS 归档使用 batchId 和文件摘要保证幂等，不企图在 MySQL 与 HDFS 间执行不存在的跨系统原子事务。先在 MySQL 建立待导出范围，再写临时文件并关闭、提交路径，最后登记 Manifest 和新水位；重启时按 batchId 检查已提交文件，只有完整连续范围才能推进 exportedThroughSeq。

发布事务锁定 channel 指针及隐私修订，校验 staging 结果后一次切换 active_generation_id。`recommendation_batches` 通过 `(generation_id,user_id)` 外键关联同版个人画像，项目向量由 generation 中的 catalog_snapshot_id 和 feature_space_version 唯一定位；发布器检查每条候选引用均存在。读取事务固定 generationId，避免新画像配上旧候选。

在没有数据重置的同一设备流内，应满足 `processedThroughSeq ≤ exportedThroughSeq ≤ acceptedThroughSeq`。processed 值只随已发布画像变更，不能因接收成功直接修改；如果多个历史 generation 并存，它们各有自己的覆盖边界。

## 5. HDFS 分区与文件格式

HDFS 根目录按环境和来源隔离，生产使用 `/happygit/prod`，合成实验使用 `/happygit/experiments/{datasetId}`。目录中的日期采用 UTC，业务调度时间仍可用 Asia/Shanghai。subjectId 不作为原始日志的分区目录，避免一人一小文件。

```text
/happygit/prod/
  raw/github/repositories/dt=YYYY-MM-DD/batchId/part-*.jsonl
  raw/github/collections/dt=YYYY-MM-DD/batchId/part-*.jsonl
  raw/github/events/dt=YYYY-MM-DD/batchId/part-*.jsonl
  raw/app/events/dt=YYYY-MM-DD/hour=HH/batchId/part-*.jsonl
  control/privacy/snapshotId/part-*.jsonl
  manifests/runId/input-manifest.json
  clean/runId/events/part-*.seq
  clean/runId/user-repository-evidence/part-*.seq
  catalog/catalogSnapshotId/part-*.seq
  features/featureSpaceVersion/feature-space.json
  vectors/catalogSnapshotId/featureSpaceVersion/part-*.seq
  runs/runId/jobName/attemptId/part-*.seq
  results/generationId/portraits/part-*.seq
  results/generationId/cohorts/part-*.seq
  results/generationId/candidates/part-*.seq
  results/generationId/result-manifest.json
```

接入文件为 UTF-8 JSONL，单行一条原始记录，先以 `.inprogress` 名写入，关闭后提交正式路径，Manifest 不引用进行中文件。初版原始 JSONL 不使用不可切分的整文件 gzip；清洗和计算数据使用 block-compressed SequenceFile，键和值有明确 schemaVersion。JSONL 便于抽查，SequenceFile 用于可切分、可重放的批量计算，其键值及块压缩格式参考 [SequenceFile API](https://hadoop.apache.org/docs/r3.4.2/api/org/apache/hadoop/io/SequenceFile.html)。

单批按 64 MiB 或最多 5 分钟关闭，低流量必然有小文件，后续 compaction 合并到目标 64—128 MiB；合并任务更新输入清单后再清理旧分片，不能让同一逻辑事件被新旧清单同时计入。小规模实验可以按两个以上实际项目分片产生并行输入，但不能复制记录伪造数据规模。

InputManifest 至少包含文件路径、字节数、行数或记录数、SHA-256、sourceKind、schemaVersion、时间窗口、固定 referenceTime、catalogSnapshotId、隐私/偏好快照和各流导出上界。ResultManifest 包含 runId、各作业 ID、模型/词表版本、输出路径/摘要、真实计数、忽略原因分类和候选统计。摘要与数量必须从实际文件计算，不能写设计值冒充测量值。

HDFS 只使用内部 subjectId，不归档应用 access/refresh token、GitHub Cookie、密码、验证码或私有项目内容。公开 README 与用户行为目录使用不同访问权限；学生演示可以读取脱敏样本，不向普通客户端开放任意 HDFS 下载入口。

## 6. 客户端 SQLite v3

迁移继续使用现有数据库文件和单连接事务模型。保留 accounts、account_preferences、browse_history、repository_cache、sync_state、app_settings、repository_catalog、repository_aliases、star_state、website_operations 和 account_revisions；现有账号与历史 ID 不重建，账号外键仍开启。新增表负责云端接续，旧 content-v1 缓存标为旧模型并从新链路失效，不改写成新模型数据。

| 新表或变更 | 主键及内容 | 使用边界 |
| --- | --- | --- |
| `cloud_account_state` | account_id；固定服务来源、cloud_sync_enabled、analysis_epoch、privacy_revision、已核验绑定 | 不保存 token 明文，初次迁移 cloud_sync_enabled=0 |
| `local_activity_events` | event_id；account_id、local_seq、repo_id、occurred_at、effective_at、record_kind、可空 device_seq/stream_epoch | 原生端有效打开明细；未授权上传时 device_seq 为空；时间修正不改变原始摘要 |
| `event_outbox` | event_id；device_id、stream_epoch、device_seq、payload_hash、payload_json、state、next_attempt_at | 仅保存允许上传的序列；序号分配与事件写入同事务 |
| `local_sync_state` | account_id + device_id + stream_epoch；next_seq、accepted_through_seq、exported_through_seq | 不把 ACK 写成画像覆盖水位 |
| `feature_space_cache` | feature_space_version；artifact_json、sha256、created_at | 制品只读，同 hash 同内容 |
| `repository_vector_cache` | catalog_snapshot_id + feature_space_version + repo_id；vector_json、metadata_revision | 正式候选使用冻结语料对应的向量；本机新文本投影另用 local metadata 摘要作快照键 |
| `server_portrait_cache` | generation_id + account_id；vector_json、summary_json、processed_through_json、隐私/输入修订 | 只缓存服务器正式画像，不被本机微调覆盖 |
| `server_candidate_batches` / `server_candidate_items` | batch_id；账号、generation、词表、有效期；项目位置和完整卡片 | 一个账号可暂存当前和待切换两批，最多 300 项/批 |
| `local_rank_snapshots` / `local_rank_items` | client_batch_id；server_batch_id、delta_revision、local_vector_json、生成时间；最终项目顺序 | 显示页固定读取此批，最多 100 项，每页 20 项 |

`deviceId` 使用安装时生成的随机 UUID，不采用硬件序列号。用户 A 与 B 可以处于同一安装设备，但分别拥有账号作用域的数据和流。网页会话 contextId 仍用于取消旧请求，服务端 generationId 和本机 deltaRevision 另用于约束计算结果，三者不可相互替代。

有效打开的本机事务先更新 browse_history，再追加 local_activity_events；只有符合上传条件才分配连续 deviceSeq 并写 outbox。上传 ACK 仅更新发送状态，事件明细仍保留给本机微调。选择增量的条件为：当前账号、允许使用的最近 7 天、未被本地删除，且 deviceSeq 为空或大于对应服务器 processed 水位；不是简单查询 outbox 中 pending 的行。

若用户在本机清空或删除历史，同时删除相应微调输入，尚未确认的 outbox 按前述 discard 协议留下最小序号占位；已接收服务器的数据仍需独立的云端清除请求。这样既不把已删内容继续上传，也不会留下阻塞后续同步的缺口。云端 analysisEpoch 重置则废弃整条旧上传流，新的 streamEpoch 从 1 开始。

获取新候选包后，原生层先保存其词表制品、基础画像、候选及水位，再以同一事务切换本机 active bundle。Worker 结果提交时必须再次比较 accountId、contextId、serverBatchId、featureSpaceVersion、privacyRevision 和 deltaRevision；任一变化时丢弃旧结果，按最新快照重新计算一次。旧账号的迟到结果不能进入新账号数据库或页面。

当前本机历史仍按 90 天、每账号最多 5000 个聚合仓库行管理。新逐次事件也最多保留 90 天，已被画像覆盖且超过本地 7 天微调窗口的记录可提前回收；未归档/未确认的上传数据先完成接续或明确终结，不能按展示列表的 5000 行限制误删。长时间未联网而已超过 90 天的 outbox 记录改为 discard 占位，不再发送原始过期内容。

## 7. 数据保留、撤回和备份

以下为课程部署的初始保留参数，可由维护者调整并记录；客户端界面不要求用户理解 HDFS 分区。所有清理任务都先核对引用和接续条件，不能用定期清空数据库文件代替迁移。

| 数据 | 初始保留策略 |
| --- | --- |
| MySQL 接收事件正文 | 归档提交后再保留 7 天；未成功归档的不按年龄直接丢弃 |
| 事件身份/序号/摘要回执 | 自接收起 180 天，服务于重复请求核对；正文可先置为归档引用 |
| HDFS 原始行为与清洗事实 | 90 天计算窗口外加 7 天接续余量，隐私撤回优先 |
| HDFS 公共项目/词表 | 当前及被保留结果引用的版本；未被引用版本保留 30 天后回收 |
| 在线 generation | 当前版本及最近两版；不延长任何隐私失效版本的服务期 |
| HDFS 结果和运行证据 | 普通结果 30 天，课程实验只保留已明确脱敏或合成的数据 |
| MySQL 备份 | 每日一次、保留 7 天；恢复后必须先重放撤回记录再开放读取 |

正文归档后仍在原 `ingest_events` 行保留唯一身份、原 payloadHash、终结状态及 archive_batch_id，只将 payload_json 置空。这样去重约束始终在同一张表上生效，不另建难以跨表保证唯一性的冷回执表。只有 archive_batch_id 对应文件已经提交时才能清正文。回执过期的旧批次返回 `SYNC_WINDOW_EXPIRED`，客户端查询权威水位后结束重试，服务端不把它当新事件再次插入。

保留期不能破坏尚未完成的画像水位接续。未被任何已发布画像覆盖的新增序号范围，至少保留其终结记录直到一次发布明确处理；超出行为窗口的正文可以按规则忽略，但必须留下确定处置。数据量达到容量上限时暂停新接收，不提前确认再静默清除。

每次作业读取已冻结的撤回快照。隐私操作首先使在线个人/群体结果失效，再在 HDFS 中登记 tombstone，下一代计算过滤后重新发布。受影响原始分区由重写任务生成不含目标数据的新文件，切换 Manifest 后清理旧文件、旧结果和备份到期副本；状态分开记录逻辑屏蔽与物理清理。

具体访问门禁为：个人结果的 privacy_revision 必须等于 app_users 当前值；含被撤回账号的 generation 立即设置 cohort_invalidated_at，群体接口拒绝返回其旧聚合。重新生成的新 generation 才能恢复群体访问，不影响其他账号仍合法的个人结果。

本部署的 HDFS 两副本只保证在设计范围内的数据冗余，不是备份替代品。课程环境至少保存 NameNode 元数据和 MySQL 备份，并保留制品摘要；恢复演练使用副本环境，不以删除正在使用的数据验证恢复。

## 8. 迁移与一致性验收

SQLite 从 v2 到 v3 在一个迁移事务中建表、初始化新状态和版本；失败保留原库，不删除重建。迁移前复制原库作恢复备份，完成后保留真实历史时间、30 秒计数规则和账号分区。Windows 与 Android 按相同逻辑 schema 迁移，但各自验证平台 SQL 支持，不复制数据库文件来冒充跨端同步。

服务端 MySQL 使用版本化迁移新增表，启动时不自动重置已有数据。首次只有 schema，没有画像；必须等完整 MapReduce 产物发布后才有正式结果。旧项目说明文档和数据生成要求可以作为对比基线保存，不能批量写入生产表制造“已经有 1000 名真实用户”的效果。

数据库联调在相关 feature 分支合入 develop 后集中进行。必要验证包括重复上传唯一性、ACK 与事件共提交、HDFS 写成功但登记失败后的恢复、同版发布读取、本机历史删除的序号接续、换账号隔离以及隐私 epoch 重置后的迟到请求。只验证这些真实业务约束，不为每次文档变更编写测试脚本。

验收时保存迁移前后账号/历史数量、实际约束、同一 eventId 的全链路引用和 generation 的输入/输出摘要。任何节点上的本地 SQLite、HDFS 或 MySQL 检查都不能单独证明整个客户端—集群链路已经完成。本次未启动数据库、未执行迁移，也未修改用户实际业务数据。
