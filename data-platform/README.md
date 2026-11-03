# HappyGit 数据采集与 Hadoop 处理

本模块实现公开项目/README/公开集合采集、HDFS 不可变归档、ZooKeeper 任务领取与版本隔离、12 阶段 Java MapReduce 以及管理端和客户端目录的新界面。用户应用身份、云端行为授权上传、MySQL 在线推荐表和现有 Electron/Android 页面切换尚不属于这个模块的已完成能力。

## 运行边界

生产使用 JDK 11、Hadoop 3.4.2 的 HDFS/YARN 和 ZooKeeper。通过 `HADOOP_CONF_DIR` 加载集群配置，不在程序中写死主机 IP。2—4 台 Ubuntu 的配置生成与部署步骤见[Ubuntu 部署](../deploy/ubuntu/README.md)。本机验证和真正多物理主机故障接管分别记录，不将本机多个 Java 进程冒充多台主机。

任务记录持久保存在 ZK，worker 在线注册和执行租约是临时节点。领取通过同一事务创建租约、递增版本与尝试次数、设置新的随机 token；提交同时核对任务版本和 token。worker 丢失 session 后，其他 worker 可重新执行同一逻辑任务；旧进程产生的孤立尝试文件不能成为已提交输入或已发布结果。

失败的处理尝试可能从冻结输入重算，不能宣称从任意指令断点继续；已经运行的旧 YARN application 也可能在原 worker 故障后继续计算，但没有当前 token 就不能发布。所有输出目录带 taskId/attemptToken，不覆盖已有结果。该设计保证提交权限和可重放，不保证网络请求或计算恰好执行一次。

此阶段控制队列不依赖尚未实现的业务 MySQL；用户业务层仍按后续 SDD 接入。公开集合导入不等于用户同意上传本机浏览日志。CLI import 只供受信任维护者导入已授权或明确标记为合成的输入。

## 编译与操作

```bash
mvn -f data-platform/pom.xml -DskipTests package
export JAVA_HOME=/path/to/jdk11
export HADOOP_HOME=/path/to/hadoop-3.4.2
export HADOOP_CONF_DIR=/path/to/cluster-config
export HG_PLATFORM_JAR="$PWD/data-platform/target/happygit-data-platform-1.0.0.jar"
export HG_ZK_CONNECT=hg-1:2181,hg-2:2181,hg-3:2181
# 生产环境还需所有进程共用 HG_ZK_AUTH；不要将值提交到仓库
bash data-platform/bin/data-platform enqueue --type repository --target apache/hadoop --namespace public --request example-hadoop
bash data-platform/bin/data-platform worker --id hg-1
bash data-platform/bin/data-platform status
bash data-platform/bin/data-platform process --namespace public --dataset-kind real
bash data-platform/bin/data-platform serve --bind 127.0.0.1 --port 8090
```

`--request` 为调用幂等身份；同 namespace/type/target/request 重试不会创建重复任务，同身份不同 input 拒绝。worker 常驻处理，`--once true` 仅执行一个任务用于受控操作。GitHub 凭据从 `GITHUB_TOKEN` 读取，不写入任务、HDFS 或界面。请求限时、限大小，遇限流调度到 retryAt；公开集合最多采20页，达到上限标记 incomplete，不能当完整集合使用。

维护者输入 JSONL 可以包含：

```json
{"kind":"subject","subjectId":"demo-a","manualTags":["database"],"hiddenRepoIds":[]}
{"kind":"event","eventId":"demo-event-1","subjectId":"demo-a","repoId":"123","occurredAt":1700000000000,"source":"browse"}
```

以上 ID/时间为结构例子，不能当作实际 GitHub 身份。事件必须指向同一 namespace 中实际存在的项目特征，source 支持 browse/repo_open、允许的公开 Push/Issues/PullRequest 活动。每个参与个人画像的 subject 都需一条种子；无事件的种子仍输出空画像。90 天窗口和衰减由 process 的固定 referenceTime 决定。先用 import 归档，再 process 冻结摘要清单；合成输入使用独立 namespace 与 `--dataset-kind synthetic`。

## 输出和算法

输出依次为 J01 项目最新公开状态、J02 事件去重与窗口清洗、J03 词频、J04 DF、J05 词表、J06 项目向量、J07 用户项目证据、J08 按项目关联、J09 个人画像、J10 群体统计、J11 精确 Top-300、J12 公共 Top-1000 池。结果为 JSONL，Manifest 保存输入摘要、模型、特征空间摘要、各作业 ID、计数及时间。成功的 HDFS 输出加上持有租约的 ZK 提交才成为可见结果。

模型实际标识为 `mr-content-v2-data1`，8192 维包含语言128/topic1024/文本7040，项目最多256非零、画像512非零，文本使用固定技术词/NFKC/中文二元词规则。它是当前数据平台算法，不冒充原 SDD 尚未完成的完整跨端 FeatureSpace 制品或 V3 多因素模型。

当前作业以独立阶段的 JSONL 和稳定键编排，J06 也保留标准 Reduce 输出，尚未做 SequenceFile/map-only 优化。J11 首版缓存上限1000用户/32MiB，超限明确失败，后续需用户分块；不宣称无限扩展。公开群体人数少于10时抑制细分报告，合成通道显示来源。公共关注度命名 popularityScore，不称为项目质量。

当前版本不输出客户端上传 processedThrough 水位，因为设备上传接入尚未实现；不能把 process 完成等同于客户端日志接续完成。业务 API 后续需把同版画像、候选、向量和水位组装成正式包；本模块的结果 Manifest 是该步骤的输入。

## UI 新设计

管理端 `/` 为真实任务查询表格、3—4核心指标、在线采集进程和创建采集任务表单；客户端新设计预览 `/client` 显示实际已采集公开目录、主题、维护时间和项目证据。两个界面均采用已安装 b-end-design-system 的语义色、轻边框、唯一主操作、表格对齐和五态。未完成的质量/画像明确标注，不产生随机指标。原生 `<details>` 提供轻量同页展开，未引入自制阻断浮层。

客户端预览尚未替换现有 Electron/Android 应用入口，也没有将公开目录标成个性化结果。五态包括连接中、实际列表、空输入、请求失败、无凭据受限；两主机模式始终显示控制面限制。管理凭据只存当前页面内存，默认只绑定回环地址。

## 验证与后续接入

按项目约定功能合入 develop 后执行目标测试；测试覆盖受控 worker 进程被杀后的租约转移、旧 token 无法发布、输入幂等冲突和完整12阶段固定输入。真正 3—4 台 Ubuntu 的节点分配、YARN attempt 迁移、NameNode/RM active切换与 fencing 仍须在指定主机上保存独立证据。具体本轮运行结果写入验证记录，不在这里预填通过。
