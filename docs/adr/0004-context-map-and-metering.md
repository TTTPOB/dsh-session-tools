# ADR 0004：通用 Surface 地图与同源计量

- 状态：Accepted（已采纳）
- 实施情况：未实现。

## 背景

历史回读需要回答“现在模型上下文有哪些区段、来自哪里、体量多大、如何回读”。Log 按事件追加排序，Surface 按模型消息位置排序：新 checkpoint 的 seq 可以较大，却位于 Surface 前部。因此，地图必须使用 Surface 顺序，不能以 Activity 来源集合或最小/最大 seq 推断连续区间。

session-tools 提供只读地图，供模型浏览上下文，也供树外 ACP（Active Context Pruning，模型主动裁剪上下文）插件定位历史。数据访问延续 [ADR 0001](0001-shared-event-association-and-projection.md)、[ADR 0002](0002-local-reading-and-completeness.md) 和 [ADR 0003](0003-search-and-projection-separation.md) 的关联、读取与搜索分工。

## 决策

### 职责与采样

提供模型工具 `session_context_map` 和公开 `context-map` 库入口，工具与 ACP 提醒共用采集、预览、定位和展示代码。

地图描述连续 Surface 区段、节点、来源、短预览、回读入口、逐节点估价和同计量依据的占比。ACP 消费地图库，负责保护规则、可压建议、压缩准入和收益核算，见[提交 ADR](../../../dsh-active-context/docs/adr/0001-active-compaction-submission.md)及[提醒 ADR](../../../dsh-active-context/docs/adr/0002-pressure-notices.md)。通用地图独立于这些压缩政策。

通过自有 Query fork 的同步采样入口，沿现有 store-definition 路径取得 live/prepared Session。节点、预览和现有 token-meter 的计量在同一同步过程取得，返回独立 DTO 后释放租约，见 [Query 提案](../../../deepseek-harness/.agents/notes/proposed/architecture/2026-10-10-session-query-synchronous-capture.zh.md)。

### 工具输入与查询方式

| 字段 | 语义 |
|---|---|
| `session_id` | 省略时取调用会话；显式目标查询它现在的 Surface |
| `scope` | 默认精确 caller cwd 的 project；all 须显式，仅当前 provider；授权先于采样 |
| `view` | overview / messages；完整正文及关系交给已有 Read/Raw/Trace |
| `window`、`limit` | 按 anchor/side 定位当前节点窗口；limit 限制展示节点数 |
| `metering` | auto / none / require；缺计量时 auto 给原因，require 明确失败 |

采用有界概览加当前窗口：每次调用采样当前状态，返回本次快照。后续窗口查询重新采样，不提供旧地图分页，也不保存跨调用地图缓存。anchor 已被替换时明确报错，要求重新定位。

首版查询当前 Surface；任意历史 `as_of_seq`、过滤 DSL 和 Activity/PTC 全量展开不在本接口范围内。

### 返回信息

- `snapshot_ref`：session_id、采样标识及源读取上界；replacement/content generation 可作为诊断信息。
- `window`：Surface 起止位置、returned/total 节点数和首尾 locator；overview 另报区段数。
- `node`：surface_index、seq、event_type、read_seq、role/source/form、preview、导航及计量。未知信息标 unknown；空/dormant 节点保留位置，可无消息且估计 token 数为零。
- `preview_basis`、`preview_truncated`：说明预览来自原事件还是 Session 消息解释，以及是否截断。
- `metering.available/basis/reason`：说明计量是否可用、计量依据及缺失原因。
- `segments/windows`：连续 span、首尾 anchor、节点数、estimated_tokens、share_of_surface 和 locator。
- `context_summary`：已记录的 contextPressure/contextBreakdown 汇总，附 asOfSeq、计量依据和缺失原因。

`session_id + read_seq` 可直接交给已有读取工具。Turn/Step 导航依据实际边界生成，缺证据为 unknown。locator 描述目标位置；ACP 提交时负责核对当前目标及保护规则。

### 计量依据

复用现有 token-meter：普通文本/reasoning 主要按 JavaScript 字符串 length / 4 向上取整，加内容块与角色开销；工具名称和参数分别估价。这是启发式估计，中文等内容的真实 token 密度可能不同。

图片有路由能力时，以 adapter visualTokens 和描述文字估价替换引用结构价；文件以实际 handle 文本估价替换引用结构价，否则保留 heuristic。路由取最近已落档 header，附件使用当前挂载实现。纯文本使用固定启发式算法，API usage 用于总量基线。

`surfaceTokens` 为节点估价之和，区段估价同样求和，`share_of_surface` 使用该总数。`totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)`；配置与最近成功请求一致且 API usage 满足既有覆盖条件时使用 usage baseline，否则 estimated。schemas 由原 meter 计入。

预览来自 Session 当前消息解释；meter 对同一 Session 日志独立折叠原事件，并应用其 image/offload 与附件路由计量。二者分别标明 basis：节点按 seq 对齐，但预览文字与计量所依据的文本可能不同，插件消息改写和最终 provider wire 转换也可能影响实际用量。

容量占比仅在同采样 requestContext 与 header 的 provider/model 匹配、contextWindow 有效时提供，否则 unknown。无 meter 时仍返回节点和已知汇总。

已记录汇总使用 `projectionMode: all`，仅节点地图使用 none。汇总分子优先 projectedTokens，否则 pressureTokens；缺 baseline/容量时标 unknown。breakdown 的 heuristic system/tools/messages 中，tools 指 schemas、工具结果归 messages；三类之和可能与占用分子不同。汇总用于展示，ACP 的执行判断使用自己的计量输入。

### 读取成本

地图覆盖已提交 Surface。source cut 与 meter logRevision 分开记录：cold 读取可在内存补 interrupted closers，prepared Session 可有非 Surface end-seed，因此两个值的数值含义不同。

Query 复用同模式、同源版本且仍有效的 prepared 对象；模式切换、版本变化或淘汰可能重新准备。首次 cold 可能读取完整 Log，meter 可能遍历全 Surface；缩小展示窗口只减少输出，不一定降低读取或计量成本。

## 理由与替代方案

- **ACP 专用地图**将通用阅读与压缩政策绑定；共享地图库能同时服务独立浏览和 ACP 提醒。
- **UI 汇总作为节点计量值**缺少区段定位，计量依据也不同；采用 meter 的逐节点 measurement，汇总保留自身语义。
- **另写 tokenizer 或 Surface fold**增加估价与消息投影的维护成本；复用现有实现并标明依据。
- **固定旧地图分页**支持稳定遍历，但需要缓存和过期管理；当前用途是定位现有上下文，按需查询当前窗口即可。

## 后果与风险

区段估价帮助比较上下文体量。压缩后的净节省还取决于摘要、framing、工具交互和提醒开销，由 ACP 核算。

每次窗口查询反映当时状态，连续查询之间内容可能变化。模型需重新定位已被替换的目标；返回 DTO 保留本次采样结果，不随后续消息变化。

## 默认值与校准

经公开 Query 接口对本机 6 个真实历史会话进行只读粗测后，保留以下默认值。样本与方法见[地图预算粗测](<../map-budgets.md>)。

| 项目 | 保留默认值 |
|---|---|
| 默认窗口节点数 | 20 |
| 最大窗口节点数 | 100 |
| 每节点预览长度 | 240 Unicode code points |
| 完整 JSON 输出上限 | 24 KiB（24576 UTF-8 bytes） |
| 概览最多连续区段数 | 12 |

样本从创建至少 10 分钟的历史记录中分散选择，Surface 为 27–148 个节点。默认 20 节点概览的完整 JSON 为 15811–16482 UTF-8 bytes（约 15.4–16.1 KiB），均低于 24 KiB；预览包含中文/非 ASCII 内容，所取窗口未含真实图片或文件。附件行为由专项 fixture 覆盖，完整验收另行确认。

这些结果支持保留当前限额，不证明其最优，也不保证最大 100 节点窗口或任意内容都能装入 24 KiB。超输出限额明确报错，调用方可缩小展示范围或缩短配置预览。本次粗测记录的是输出体量及含 cold 准备的读取耗时，未测量实际模型 usage、付费成本、缓存效果或任务收益。

## 验收要点

1. 节点与计量值按 Surface 顺序对齐，覆盖高 seq checkpoint、空节点、长 Turn、cold 修复记录和图片；Turn/Step 导航符合实际边界。
2. 历史读取保持只读，不激活 Agent；返回 DTO 不受后续追加/replacement 影响；后续窗口读取当前状态，失效 anchor 明确报错。
3. 预览和计量依据正确；无 meter、容量未知或路由不匹配时明确缺失信息；scope 与完整输出预算有效。
4. 地图可独立使用，ACP 通过共享库消费地图；标准地图结果保持相同职责，压缩入口重验目标。
5. 打包后公开库子入口、peer 类型和实际 Loader 组合可用，工具注册唯一。

## 实现依据

Query 源解析和租约见 [observation.ts](../../../deepseek-harness/packages/session-query/session-query/src/observation.ts#L152-L268)；同步计量与结果复制见 [token-meter](../../../deepseek-harness/packages/llm/token-meter/src/index.ts#L146-L190)，原事件折叠见 [meter fold](../../../deepseek-harness/packages/llm/token-meter/src/surface-fold.ts#L107-L127)。现有输出配置见 [session-tools 配置](../../src/index.ts#L27-L31)，作用域、预览和结果字节限制复用 [shared helpers](../../src/shared.ts#L15-L42)。
