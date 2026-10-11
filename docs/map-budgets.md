# 当前上下文地图：本机预算粗测

## 结论

保留地图默认窗口 20、最大窗口 100、预览 240 Unicode code points、完整 JSON 输出 24576 UTF-8 bytes、概览最多 12 个连续 spans。六个真实历史的默认概览为 15811–16482 bytes，均能在 24 KiB 内展示；这不是任意内容或最大窗口都能装下的保证。超限时明确失败，调用者降低 limit 或缩短配置预览。

## 方法与边界

使用 Harness 源码 paths 与既有依赖，在忽略目录执行一次性脚本；仅经 `sessionQuery.pageSessions` 发现候选，经公开 `getContextMap` 取得地图。读取当前 provider 的单个 DSH_HOME，最多 100 个 metadata 候选，排除创建不足 10 分钟的记录后按列表位置分散选择 6 个。scope 显式 all；未直接打开或解压 session 文件，未执行历史代码、启动 Agent 或修改 Host/profile。持久化服务的 open 被限制为 read，create 被显式拒绝；Query 使用未发布的 prepared Session，未写入历史日志。

每个目标分别读取 overview 默认 20 节点、messages 20 节点及 overview 10 节点。计量使用既有 tokenMeter；输出测量临时放宽预算以观测完整 JSON bytes，再与默认上限比较。六个结果均来自 prepared，首次调用耗时包含 cold 准备与同步计量，并非工具往返或性能基准。仅保存下列去身份化聚合，不保留正文、完整会话 ID、参数或原事件。

## 聚合结果

| 样本 | Surface 节点数 | overview 20 bytes | messages 20 bytes | overview 10 bytes | 非 ASCII 预览数 / 截断数 | 首次读取 ms |
|---|---:|---:|---:|---:|---:|---:|
| S1 | 132 | 16222 | 14035 | 9421 | 9 / 16 | 128 |
| S2 | 148 | 16184 | 14001 | 9890 | 5 / 16 | 98 |
| S3 | 82 | 15811 | 13651 | 9484 | 4 / 14 | 87 |
| S4 | 52 | 16482 | 14328 | 9992 | 12 / 15 | 84 |
| S5 | 34 | 16140 | 13998 | 9612 | 6 / 17 | 90 |
| S6 | 27 | 16014 | 13879 | 9400 | 6 / 16 | 82 |

默认窗口均返回 20 个节点，概览均有 12 个连续 spans。六个样本的 meter logRevision 都比 source cut + 1 多 1：准备 Session 的非 Surface 标记参与 meter revision，source cut 仍指源读取上界，两者不能强行视为同一版本。

此次有中文/非 ASCII 预览，但所取尾部窗口没有图片或文件。附件、空节点、replacement 导致的高 seq 前置、当前窗口变动、失效 anchor、scope 授权及 UTF-8 精确预算由专项测试覆盖；本机粗测不替代这些行为验收，也不代表超大会话的成本上界。100 节点是允许的展示数量上限，不承诺在默认 24 KiB 内成功；展示窗口变小仍可能需要完整 cold Log 准备、全 Surface 计量和真实生命周期导航。
