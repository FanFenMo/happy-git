# HappyGit 数据采集与 Hadoop 处理

本模块实现公开项目/README/公开集合采集、HDFS 不可变归档、ZooKeeper 任务领取与版本隔离、12 阶段 Java MapReduce 以及管理端和客户端目录的新界面。本轮增加有预算的批量采集计划、条件请求缓存、关联项目补抓、冻结目录导出，以及对 Spring MySQL 接收服务的云端归档桥接；部署及实现状态见[接入交接](../docs/implementation/服务端数据接入交接.md)。正式 Hadoop 画像发布和客户端接入仍按后续轮次实现。

## 运行边界

生产使用 JDK 11、Hadoop 3.4.2 的 HDFS/YARN 和 ZooKeeper。通过 `HADOOP_CONF_DIR` 加载集群配置，不在程序中写死主机 IP。2—4 台 Ubuntu 的配置生成与部署步骤见[Ubuntu 部署](../deploy/ubuntu/README.md)。本机验证和真正多物理主机故障接管分别记录，不将本机多个 Java 进程冒充多台主机。

任务记录持久保存在 ZK，worker 在线注册和执行租约是临时节点。领取通过同一事务创建租约、递增版本与尝试次数、设置新的随机 token；提交同时核对任务版本和 token。worker 丢失 session 后，其他 worker 可重新执行同一逻辑任务；旧进程产生的孤立尝试文件不能成为已提交输入或已发布结果。

失败的处理尝试可能从冻结输入重算，不能宣称从任意指令断点继续；已经运行的旧 YARN application 也可能在原 worker 故障后继续计算，但没有当前 token 就不能发布。所有输出目录带 taskId/attemptToken，不覆盖已有结果。该设计保证提交权限和可重放，不保证网络请求或计算恰好执行一次。

公开控制队列继续使用 ZK，云端身份和接收记录由 Spring cloud profile 的 MySQL 管理。两者通过服务凭据和冻结归档协议连接，Spring 请求线程不加载 Hadoop。公开集合导入不等于用户同意上传本机浏览日志。CLI import 只供受信任维护者导入已授权或明确标记为合成的输入。

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

本轮接收 API 分开保存 acceptedThrough、exportedThrough、processedThrough，归档仅推进 exportedThrough；processedThrough 保持0，等待第二轮同代画像实际发布。现有 process 不组装个人云端快照，不直接处理 cloud-export 历史，不能把12阶段完成等同于客户端日志接续完成。

## UI 新设计

管理端 `/` 为真实任务查询表格、3—4核心指标、在线采集进程和创建采集任务表单；客户端新设计预览 `/client` 显示实际已采集公开目录、主题、维护时间和项目证据。两个界面均采用已安装 b-end-design-system 的语义色、轻边框、唯一主操作、表格对齐和五态。未完成的质量/画像明确标注，不产生随机指标。原生 `<details>` 提供轻量同页展开，未引入自制阻断浮层。

`/client` 是数据平台的公开目录预览，与现有 Vue 应用入口分别提供。现有应用已经修改侧栏、移动导航、项目卡片、个人页、登录与兴趣弹窗以及设置抽屉，原有本机账号和推荐调用仍保留；它没有接入正式 Hadoop 个性化结果。目录五态包括连接中、实际列表、空输入、请求失败、无凭据受限；两主机模式始终显示控制面限制。管理凭据只存当前页面内存，默认只绑定回环地址。

## 验证与后续接入

按项目约定功能合入 develop 后执行目标测试；测试覆盖受控 worker 进程被杀后的租约转移、旧 token 无法发布、输入幂等冲突、完整12阶段固定输入、HDFS 副本读取与最新可见性。真实采集的四个公开项目也已完整运行12阶段，记录见[本轮验收](../docs/validation/2026-11-03-data-platform.md)。真正 3—4 台 Ubuntu 的节点分配、YARN attempt 迁移、NameNode/RM active切换与 fencing 仍须在指定主机上保存独立证据。

## 本机复现

以下命令在仓库根目录的 Ubuntu/WSL 执行。运行时只写入专用目录，不替换系统 Java。首次下载 Hadoop 约1 GiB，解压和 Maven 依赖还需额外空间。

```bash
python3 tools/bootstrap_data_runtime.py --dest /tmp/happygit-runtime/v2 --hadoop
bash tools/data_local.sh build
bash tools/data_local.sh classpath
bash tools/start_data_demo.sh /tmp/happygit-demo-new --foreground
```

演示使用全新的临时目录，启动一个 MiniDFSCluster（3个 DataNode 实例）、一个本机 ZK 和两个独立 worker JVM；自动采集4个真实公开项目。`started.json` 保存实际 HDFS/ZK 端口。MapReduce 使用 local 模式；这个演示不包含 YARN 或控制面 HA 演练。停止前台进程时关闭所属 worker 与临时集群，不删除演示目录。

Ubuntu 上访问 `http://127.0.0.1:8090`。Windows 未启用 WSL 回环转发时，在 Windows 仓库根目录另开终端运行 `python tools/windows_demo_bridge.py --distro Ubuntu-22.04`，通过 `http://127.0.0.1:8190` 访问；发行版名称按本机实际值填写。桥接仅监听 Windows 回环，不修改系统转发设置。目录预览为 `/client`，现有 Vue 客户端用 `cd client && npm run dev -- --host 127.0.0.1 --port 4190` 启动。
