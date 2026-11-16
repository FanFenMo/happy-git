# Ubuntu 2—4 主机数据平台部署

本轮新增的 MySQL 接收服务、cloud profile、云端 OAuth 回调、归档桥接和计时任务见[服务端接入交接](../../docs/implementation/服务端数据接入交接.md)。业务 API 使用独立 JDK17，现有 Hadoop 进程继续使用 JDK11；`cloud.env.example` 与 `happygit-api.service` 提供维护者安装模板，真实凭据不提交仓库。采集计划配置样例为 `collection-plan.example.json`。

本目录是实际配置生成器的输入和运维步骤。示例 IP 不是用户实际主机。本轮先在本机 Ubuntu 验证；没有把本机多个进程称为多个物理主机。部署适配目标为 Ubuntu 20.04/22.04/24.04 的原生 systemd，运行 JDK 11、Hadoop 3.4.2；实际本机运行验证为 Ubuntu 22.04.5 x86_64，20.04/24.04 和其他架构尚未逐一运行。真实主机部署时记录版本、架构及兼容结果。

## 角色与故障范围

| 主机数 | 控制与数据角色 | 可以承诺的范围 |
| --- | --- | --- |
| 2 | 一个 NameNode/RM、一个 ZK；两个 DataNode/NM/采集进程 | 工作节点任务重试和双副本；控制面有单点，界面标记受限模式 |
| 3 | 前两台 NameNode/RM/ZKFC；三台 ZK/JournalNode/DataNode/NM/采集进程 | 多数派存活、数据可读、资源足够且 fencing 正常时自动接管 |
| 4 | 前三台仲裁；前两台 NameNode/RM；四台数据/计算/采集进程 | 同上，增加一台数据与计算节点，不把仲裁失去多数派说成可用 |

NameNode 的 fencing 必须真实可执行。示例使用服务账号的 SSH 密钥与 psmisc/fuser；需要在两 NameNode 之间验证。SSH 完全不可达时 fencing 可能阻止切换，整机断电或网络隔离的自动接管应补充机房提供的 STONITH/IPMI/电源隔离脚本，并实际演练。生成器拒绝 `/bin/true` 之类无条件成功的假 fencing。不能仅凭副本数或两个 NameNode 页面就保证整机故障验收通过。

## 生成每台主机配置

复制 inventory.example.json，填写两至四台 Ubuntu 的唯一主机名、私网地址、SSH 别名和 YARN 预算。每台至少预留 Java 守护进程、OS 和任务容器内存；yarnMemoryMb 不是整机内存。多角色共置建议每台8 GiB；4 GiB 仅作为低并发实验预算，需下调容器/堆上限并按实际 RSS 峰值验收，不能把 Swap 算作可用任务容量。

```bash
python3 tools/ubuntu_cluster.py \
  --inventory deploy/ubuntu/inventory.actual.json \
  --output deploy/ubuntu/generated
```

生成结果包含节点 XML、环境样例、systemd 单元、zoo.cfg、myid 与 cluster-plan.json。工具只生成文件，不连接 SSH、不安装软件、不格式化数据。actual 清单与生成目录应留在部署环境；含凭据的 platform.env 不提交 Git。

## 准备运行时和部署包

```bash
python3 tools/bootstrap_data_runtime.py --dest /tmp/happygit-runtime --hadoop
export JAVA_HOME=/tmp/happygit-runtime/jdk-11.0.32.1+1
export PATH="$JAVA_HOME/bin:$PATH"
/tmp/happygit-runtime/apache-maven-3.9.11/bin/mvn -f data-platform/pom.xml -DskipTests package
```

JDK 具体目录以脚本输出为准。脚本通过 Adoptium 校验值与 Apache SHA-512 校验下载；部署应记录版本与摘要。将已编译 JAR、bin/ 两个启动脚本和该节点生成配置复制到专用安装目录。Hadoop 放入 `/opt/happygit/runtime/hadoop`，Java 放入 `/opt/happygit/runtime/java`，应用 JAR 为 `/opt/happygit/happygit-data-platform.jar`。可以用只指向已验证版本目录的符号链接管理运行时。

服务账号需可写 `/var/lib/happygit` 中的 namenode/datanode/journal/zookeeper/tmp/logs 目录；安装文件与 XML 只读。所有主机必须能解析 inventory 中的其他主机名，时钟保持同步，集群端口仅在私网互通。操作系统预备项目为 OpenSSH、psmisc、Python 3 与 chrony/systemd-timesyncd；不对外暴露 HDFS/YARN/ZK。

在对应 Ubuntu 主机上可使用安装脚本复制该节点配置和 systemd 单元，参数明确指定已准备的运行时。脚本不启动、停止或格式化 Hadoop；它从仓库路径读取 bin 启动器，所以需保留仓库中对应文件。

```bash
sudo bash deploy/ubuntu/install-node.sh \
  deploy/ubuntu/generated/hg-1 \
  data-platform/target/happygit-data-platform-1.0.0.jar \
  /opt/happygit-runtimes/hadoop-3.4.2 \
  /opt/happygit-runtimes/jdk-11.0.32.1+1
```

上例要求先把运行时放在持久、服务账号可遍历读取的专用目录，不能长期依赖会被清理的 `/tmp`。每台选择自己的 hg-N 配置，实际根路径与生成配置一致。

## 首次初始化与启动顺序

安装脚本创建服务用户、目录和 systemd 单元，复制环境样例为 root 所有、服务组可读的0640 `platform.env`；也可手工设置为服务账号所有的0600，保证该账号可读。各数据 worker 使用相同 HG_ZK_AUTH；控制台远程监听时必须设置足够长度 HG_ADMIN_TOKEN，默认只监听127.0.0.1，可通过 SSH 隧道访问。

先启动仲裁节点上的 ZooKeeper；三主机模式再启动 JournalNode。在**确认是全新、隔离的数据目录**后，按下面命令初始化第一 NameNode。已有 VERSION 文件的 NameNode 直接恢复运行，不再次格式化。

```bash
# 仅在首次新集群执行；已有 VERSION 文件时禁止再次格式化
$HADOOP_HOME/bin/hdfs namenode -format -clusterId happygit
$HADOOP_HOME/bin/hdfs namenode
# 三/四主机：另一 NameNode 在第一台可达后执行一次
$HADOOP_HOME/bin/hdfs namenode -bootstrapStandby
# 仅三/四主机，初始化自动故障切换状态一次
$HADOOP_HOME/bin/hdfs zkfc -formatZK
```

NameNode 初始化后交给 systemd 持有进程，不能保留一个手工前台 NameNode 再启动同端口 systemd 实例。两/三/四模式按 roles.json 启动相应服务：先 NameNode/ZKFC，再 DataNode、RM、NodeManager，最后 collector、console。historyserver 为作业历史读取服务，其单点不用于宣称正在执行的任务必然失败。

HDFS 上创建 `/happygit/data` 和 `/happygit/yarn-logs`，目录所有权交给服务账号；各服务采用统一 HADOOP_CONF_DIR。不要用 root 身份启动普通 Hadoop 任务。部署工具不自动执行格式化命令，已有数据不被覆盖。

## 功能操作

```bash
bin/data-platform enqueue --type repository --target apache/hadoop --namespace public --request catalog-20261103-hadoop
bin/data-platform worker --id hg-1
bin/data-platform status
# 受控导入逐次事件/用户种子，文件不含账号凭据
bin/data-platform import --file /path/to/trusted-input.jsonl --namespace experiment-01
bin/data-platform process --namespace experiment-01 --dataset-kind synthetic
bin/data-platform serve --bind 127.0.0.1 --port 8090
```

`process` 冻结该 namespace 已成功归档文件与摘要，再入队；后续采集不会悄悄改变输入。公开项目与导入输入必须属于同一计算 namespace，实验用户不与真实授权用户混用。处理 worker 使用 HADOOP_CONF_DIR 的 YARN 模式，不用 local 模式冒充多节点。

## 故障验收

先保存健康基线、各主机实际角色和任务 JobID；再在专用验收环境一次只停止一个指定服务。采集进程被杀后等待 ZK session 到期，存活 worker 应增加 attempt、取得新 token 并完成；旧 token 不能切发布指针。NodeManager 故障要看到同一作业的新 task attempt 在另一 node ID 运行。NameNode/RM 的 active 切换单独核对，不用 worker 重试结果代替控制面接管证据。

整机断电、网络分区和仲裁丢多数派只在明确指定的隔离环境演练；记录 fencing 结果、实际中断时间、恢复后的结果数量/摘要。预期是多数派缺失时停止领取和发布，不允许两个分区同时确认结果。此目录提供配置与步骤，实际多物理主机证据待取得真实主机连接后补齐。
