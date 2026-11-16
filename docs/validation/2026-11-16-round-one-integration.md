# 第一轮 A/B 集成验证记录

日期：2026-11-16。

本轮在独立工作目录集成 develop 基线 `5e46112`、推荐契约修复 `bfba752`、A 分支 `feature/data-and-cloud-ingest` 的 `f229654`，以及 B 分支 `feature/dataset-and-client-events` 的 `96b9d6b`。A/B 源代码合并没有文本冲突，联调发现的问题在 `bugfix/round-one-integration` 修复。

## 集成修复

双端按照服务端 UUID 字符串处理 streamEpoch，并在摘要和上传事件中保留相同的字符串类型。上传的 open 事件补齐 schemaVersion、streamEpoch 和 analysisEpoch。修正服务端 cloud_events 插入语句的占位符数量。

集合、分析设置和重置操作先读取账号当前 revision，按账号统一修订提交。分析范围变化后重新注册服务端设备流，同范围离线事件接续到新流；旧分析范围的待上传内容不会迁入新范围。旧流的迟到 ACK 不再覆盖当前流和处理进度，云端重置失败也不会被当成已完成。

修正 Android 登录页面 WebView.loadUrl 方法名。采集 URL 校验只识别路径中的父级跳转，正常放行 created、stars 等查询中的区间语法，与当前采集已使用的区间修复一致。标准 npm test 入口纳入第一轮新增测试。

## 实际验证结果

| 范围 | 执行结果 |
| --- | --- |
| 客户端 Electron 回归 | 31 项通过 |
| 客户端 Node 测试 | 13 项通过，包含 UUID 流、离线队列接续、事件摘要、账号统一修订、设置与重置、迟到 ACK 隔离 |
| 服务端 | 7 项通过，无跳过；其中 1 项使用独立临时 MySQL 验证设备注册、真实事件落库、重复上传、序号缺口、完整及不完整集合、导出和分析范围重置 |
| Hadoop 数据平台 | 7 项通过，包括 12 阶段流水线、临时 HDFS 副本读取、任务租约、可见性过滤及区间查询 |
| 数据工具 | 2 项通过：pilot 可复现生成与证据校验、standard 用户划分和事件配额分配 |
| 网页构建 | npm run build 成功 |
| Android | JDK 21 下 assembleDebug 成功 |

MySQL 使用独立临时数据目录和 33307 端口，结束后关闭测试实例。接口测试中的 HDFS 提交描述符为测试数据，实际 HDFS 写读由数据平台临时集群测试验证；本轮没有执行真实个人 OAuth 授权回调和 Android 真机操作。

数据工具验证不代表真实 pilot/standard 训练数据已经齐备，也没有执行学习模型训练。数据集工具的实际命令以 tools/datasets/README.md 为准。

## 与当前采集的关系

当前采集使用 WSL `/opt/happygit/happygit-data-platform.jar`，工作目录为 `/var/lib/happygit`。本轮构建、测试和 Git 集成都在独立目录执行，原采集工作区的未提交更改保留。

验证结束时 happygit-collector、happygit-console 和 happygit-collection-batches 仍为原 PID 164960、164962、165330，启动时间保持 2026-11-15。2026-11-16 16:49 的进度快照为第 38 批运行中，已处理 36 批；合并期间未替换部署程序或重启这些服务。