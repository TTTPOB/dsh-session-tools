# 读取预算：本机历史的有界校准

## 结论

保留 [Config](<../src/index.ts#L27-L44>) 与 [README 默认表](<../README.md#L35-L55>) 的全部数值。真实样本支持常见工具阶段的读取余量；长字符串、大集合及整页内容仍需要裁剪。此次是功能验收后的粗略估值，不是精确统计或大规模 benchmark，也不保证任意跨度活动完整。

## 获取方法与边界

在功能基线 `408e83c` 上，只经当前 runtime 的公开 `functions.session_list`、`session_event_list`、`session_event_read`，由一次性 `run_code` 在内存中处理：

1. 显式 `scope: "all"`，只覆盖当前 provider 的一个 DSH_HOME。主采样使用一个列表 snapshot cursor，最多 3 页 × 10 个候选；排除当前实施 worktree 和标题明确属于阶段/ADR/校准的候选，分散选取 6 个会话。候选发现另有少量 list 调用及一次读取形状探针，未计入下表。
2. 每个目标最多读取前 2 页 × 100 条 metadata；共 10 次调用取得 992 条元数据。只从这些已见 seq 中挑选一个工具较密集、至多 30 条事件的可见首尾 Step，并增加至多 6 个结果入口。
3. 取得 144 个完整 Raw 逻辑事件，150 次 read 调用含 6 次 Unicode 续片。单事件最多 4 片，未出现达到片数上限仍未读完的事件。不跟随子会话 locator，不读取 spill、附件，也不执行历史代码；没有直接打开/解压 session 文件、接入真实 persistence 写入或修改 Host/profile/storage。
4. 复用构建后的 `associateEvents`、`projectActivity`、`projectTarget`、`commitReadingPage` 离线投影。比较 6 个 Compact 原事件窗口与 48 个 Detail 目标；包装保留 44 字符的匿名 session ID 占位，按最终 JSON UTF-8 bytes 计数。Compact 样本不提供新 reader 的覆盖证明，明确保持 sample-only/incomplete，不能据此声称完整活动；Detail 只按所取目标证据判断。

旧 runtime 只公开 Raw/metadata，**不返回 `captured_through_seq`，也不能跨请求固定 observation lease**。本次只使用先列出的有限 seq 集；表中末尾是采样位置，不是会话最终 cut。四个会话达到 200 条元数据上限，未继续读取。公开工具正常记录调用日志；仓库只保留下列聚合统计，不保存用户正文、参数、完整 session ID 或原事件。没有创建临时样本文件或统计框架。

样本均含 `subagent/descriptor`，偏向工具工作历史；包括普通多工具阶段、PTC 子调用、长结果、重试和多轮记录。没有在已取窗口中观察到 compaction，也没有覆盖纯闲聊；不能把缺少样本解释成这些场景不存在，更不能外推全部会话分布。

## 去身份化结果

| 样本 | metadata 数 / seq 窗口 | Raw 数 | 可见 Step 最大事件数 | 已配对工具最大 seq 间隔 | 最大结果 bytes | PTC 直接子节点最大数 | Compact 最终 bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| S1：PTC 密集 | 100 / 0–99 | 27 | 27 | 23 | 1193 | 11 | 20834 |
| S2：多轮/PTC | 200 / 0–199 | 25 | 27 | 13 | 1624 | 6 | 16157 |
| S3：普通多工具/长结果 | 200 / 0–199 | 27 | 21 | 3 | 41169 | 0 | 22899 |
| S4：PTC/长结果 | 200 / 0–199 | 29 | 23 | 17 | 45095 | 8 | 24472 |
| S5：重试/长结果 | 92 / 0–91 | 15 | 13 | 3 | 46606 | 0 | 12240 |
| S6：普通多工具 | 200 / 0–199 | 21 | 15 | 3 | 17033 | 0 | 16941 |

- 元数据中有 90 个可见首尾 Step，3–27 条事件，最大首尾距离 26 seq；Raw 中实际配齐 46 对工具，最大调用/结果距离 23 seq，已见 source 引用最大距离也为 23 seq。未配齐的抽样目标不计入配对间隔。
- 已见助手消息最多 9 个调用块；已关联 PTC 树最大深度 2（含根）。直接子节点最多 11 个，不以此推断所有调用都并行。
- 单事件最大 46606 bytes；各样本所取事件 JSON 总量为 37657–200611 bytes。这是序列化大小，不等同于 ReaderBudget 的保守 processingSize 或 provider 冷加载内存。
- 原字段最大字符串 44714 Unicode code points，最大集合 817 项、payload 深度 7、节点数 1722；大集合包含诊断/来源等字段，不代表 817 个工具子节点。
- Compact 窗口为 9–27 个原事件，最终 12240–24472 bytes。S4 包装从 28450 裁至 24472 bytes，其余无需额外整页裁剪；48 个 Detail 包装为 1821–12193 bytes。全部通过现有整页提交函数，没有元数据超限错误。它们不模拟未取得的补读证据，也不等价于线上默认 30 条的所有页。
- 所记录旧工具单次主读取耗时 28–263 ms（包括 metadata 和 Raw 首片，续片未单独计时）。这含公开工具往返开销，不是新 reader 的基准；没有验证冷缓存、超大会话、稀疏过滤的最坏耗时。

## 默认值保留依据

| 默认项 | 保留值 | 估值依据与限制 |
|---|---:|---|
| `readBatchSize` | 128 | 样本 Step 最大 27 条，单批有足够余量；仍按批让出执行，不用本次往返耗时推导最优 batch。 |
| `readSupplementalEvents` | 1024 | 明显高于样本阶段事件量，为跨页及明确引用留余量；仍可能耗尽，不能证明长活动完整。 |
| `readProcessingBytes` | 8388608（8 MiB） | 所取单样本 JSON 总量至多约 196 KiB，保留证据预算有余量；JSON bytes 只作数量级参考，不把它冒充处理成本或冷加载上限。 |
| `readSeqSpan` | 4096 | 样本配对/引用至多 23 seq，保留现有跨度以容纳更稀疏的执行；没有验证 4096 以内所有关系或更远历史。 |
| `projectionStringChars` | 2000 | 真实长字符串明显超过上限，预览裁剪是需要的行为，全文交给 Raw 续读。 |
| `projectionItems` | 32 | 覆盖已见 9 个助手调用块与 11 个直接子节点；大字段集合按设计省略。 |
| `projectionDepth / projectionNodes` | 8 / 512 | 已见工具树深度 2；payload 深度 7，但大型诊断超过 512 节点，应保留有界访问而非扩大为全文展开。 |
| `outputBytes` | 24576（24 KiB） | 6 个 Compact 和 48 个 Detail 包装均能提交，密集页通过省略预览保持预算；最小元数据仍可能不 fit，调用方需降低 limit。 |
| `readTimeoutMs` | 30000 | 旧工具观察远低于 30 秒；保留实际 deadline 作为失败上限，不宣称冷历史/稀疏扫描已量测通过。 |

`pageSize / maxPageSize=30 / 100`、`previewChars=240`、`searchTimeoutMs=30000`、Raw 缓存 `8 / 67108864` 也保持原值。此次没有发现修改它们的必要；没有单独测试搜索吞吐、缓存命中率或 100 条密集页容量。数值无需变更，因此 fixtures/default configs 不作机械更新。

完整性、分页不跳记录、取消与预算耗尽的正确性由既有回归测试验证；真实抽样只为默认值提供数量级依据。更长引用、compaction 与冷会话准备仍遵守 [ADR 0002 的实施边界](<adr/0002-local-reading-and-completeness.md#代价与实施边界>)。
