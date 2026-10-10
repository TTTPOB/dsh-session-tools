# ADR 0004：通用 Surface 地图与同源计量

- 状态：Accepted（已采纳）
- 实施情况：未实现。已采纳有界概览加当前窗口的方案；接口正式类型与默认值在骨架实现后验证，不以采纳状态推断实现已完成。

## 背景

历史回读需要回答“现在模型上下文有哪些区段、来自哪里、体量多大、如何回读”。Log 的追加顺序与 Surface 的模型消息顺序不同：新 checkpoint 的 seq 可以较大，却位于 Surface 前部。Activity 的来源集合或最小/最大 seq 不能代表连续上下文区间。

session-tools 继续是独立只读 consumer。通用地图可用于历史理解，也可供树外 ACP（Active Context Pruning，模型主动裁剪上下文）插件使用；地图本身不决定压缩政策。数据访问延续 [ADR 0001](0001-shared-event-association-and-projection.md)、[ADR 0002](0002-local-reading-and-completeness.md) 和 [ADR 0003](0003-search-and-projection-separation.md) 的关联、读取与搜索分工。

## 决策

### 已定范围与职责

提供模型工具 `session_context_map` 和公开 `context-map` 库入口。工具与 ACP 的粗地图提醒共享采集、预览、定位和展示；首版不新增 Cordis 地图服务，不另外注册 ACP 专用完整地图工具。

地图展示真实连续 Surface 区段、节点、来源、短预览、回读入口、逐节点估价和同 basis 占比。标准结果不因 ACP 启用而加入保护、可压建议、目标摘要价格或 estimated_savings。压缩准入、收益与提醒预算由 ACP 拥有，见[提交 ADR](../../../dsh-active-context/docs/adr/0001-active-compaction-submission.md)及[提醒 ADR](../../../dsh-active-context/docs/adr/0002-pressure-notices.md)。

采样通过自有 Query fork 的窄同步入口取得 Session，复用已有 token-meter；不重写 Surface fold 或估价算法。采用 Query 现有 store-definition 准备路径，同步采集选中的同一个 live/prepared Session，finally 释放租约，见 [Query 提案](../../../deepseek-harness/.agents/notes/proposed/architecture/2026-10-10-session-query-synchronous-capture.zh.md)。准备模式由实现方按现有接口确定，不是用户待选项。

### 建议工具输入

| 字段 | 建议语义 |
|---|---|
| `session_id` | 省略时取调用会话；显式目标查询它现在的 Surface |
| `scope` | 默认精确 caller cwd 的 project；all 须显式，仅当前 provider；授权先于采样 |
| `view` | overview / messages；完整正文及关系交给已有 Read/Raw/Trace |
| `window`、`limit` | 按 anchor/side 定位当前节点窗口；limit 限制展示节点数，不表示旧地图续页 |
| `metering` | auto / none / require；缺计量时 auto 给原因，require 明确失败 |

首版采用有界概览加当前窗口（方案 B）：每次调用重新同步采样，只在本次调用内使用固定 snapshot；不保留旧地图续页，不增加地图 DTO 缓存、cursor 或独立 freshness 检查。库按一次 capture 加有界投影实现，正式类型由实现方完成；不提供任意历史 `as_of_seq`、地图过滤 DSL 或 Activity/PTC 全量展开。

### Snapshot、节点与区段

- `snapshot_ref`：session_id、该次采样标识及源读取上界；可记录 replacement/content generation 供诊断，不把 generation 当整图有效性授权。结果是调用时的快照，不承诺后来仍最新，不增加 freshness 状态。
- `window`：Surface 起止位置、returned/total 节点数和首尾 locator；overview 的区段数不是节点数。后续窗口请求读取当时状态，不能称为同一旧快照的下一页。
- `node`：surface_index、seq、event_type、read_seq、实际观察到的 role/source/form、短 preview、导航及计量。未知字段明确 unknown；空/dormant 节点保留位置，可无消息且价格为零。
- `preview_basis`：original_event / session_projected；原事件不等于最终模型消息。采样结束后不 derive 最新消息补入旧 snapshot。
- 最小完整性表达：窗口的 returned/total、preview_basis 与 preview_truncated、metering.available/basis/reason；未知导航直接标 unknown。不再设计统一 complete 或复杂 coverage 状态系统。
- `segments/windows`：真实连续 span、首尾 anchor、节点数、estimated_tokens、同 basis 的 share_of_surface 和 locator。累计位置价格若提供也只表示统计，不表示压缩收益。
- `context_summary`：复用已记录 contextPressure/contextBreakdown，附 asOfSeq、basis 和缺失原因；不冒充逐节点 measurement。

地图返回真实 `session_id + read_seq`，可直接交给现有读取工具。Turn/Step 导航只折叠实际边界，缺证据为 unknown；不改变现 Activity 的显式身份关联规则。普通窗口提供采样引用与 anchor/side locator，供 ACP 提交时定位；locator 是结构引用，不是安全授权。ACP 在提交时核对目标，通用地图不做跨调用新鲜度检查。

### 计量依据

现有 token-meter 对普通文本/reasoning 主要按 JavaScript 字符串 length / 4 向上取整，加内容块与角色开销；工具名称和参数分别估价。这不是精确 tokenizer，中文等内容的真实密度可能不同。

图片有路由能力时以 adapter visualTokens 与描述文字估价替换引用结构价；文件以实际 handle 文本估价替换引用结构价，否则保留 heuristic。路由来自最近已落档 header，附件使用当前挂载实现，明确 basis；纯文本节点不因换模型自动换 tokenizer，API usage 不按比例摊给节点。

`surfaceTokens` 为节点估价之和；区段估价同样求和，`share_of_surface` 使用该总数。`totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)`；配置与最近成功请求一致且 API usage 满足既有覆盖条件时使用 usage baseline，否则 estimated。schemas 由原 meter 处理，不重复加入。

容量占比仅在同采样 requestContext 与 header 的 provider/model 匹配、contextWindow 有效时提供，否则 unknown；这与 UI prompt-only occupancy 不同。meter 与最终 provider tool-history 转换、通用插件投影未必完全一致，同采样不承诺最终 wire 精确价格。

无 meter 的普通地图仍返回节点和已知汇总；ACP 自己声明 mandatory 计量依赖。已记录汇总需要 `projectionMode: all`，节点地图可用 none。汇总分子优先 projectedTokens，否则 pressureTokens，缺 baseline/容量不造比例；breakdown 的 heuristic system/tools/messages 之和不保证等于占用分子，tools 指 schemas、结果归 messages。这些汇总只用于展示，不用于 ACP gating。

### 生命周期与成本

不保存跨调用地图，所以不需要地图 TTL/entries/bytes。每次查询当前窗口，anchor 已被替换就明确报错、要求重新定位，不悄悄改查别处。Query 原有 prepared cache 照常复用，不另建按 sid 的恢复缓存；同模式、同源版本且对象仍有效时可复用，模式切换、版本变化或淘汰可能重新准备。

地图覆盖已提交 Surface，不包含 pending 输入与后续 system 协调。source cut 与 meter logRevision 分开保存；逻辑 cold cut 可含内存 interrupted closers，prepared Session 可有非 Surface end-seed。首次 cold 可能读取完整 Log，meter 可能遍历全 Surface；窗口限制输出，不保证 I/O 或计量成本按窗口减少。

## 理由与替代方案

- **只提供 ACP 地图**会让通用阅读依赖压缩政策，重复既有回读入口；采用通用地图加 ACP 自有注解。
- **直接把 UI 汇总当节点价格**无法定位区段，basis 也不一致；复用 meter 的 measurement，并保留汇总自身语义。
- **重写 tokenizer 或 Surface fold**增加另一套估价与投影事实；沿用现有算法，诚实标明误差和覆盖。
- **固定旧地图分页**提供稳定遍历，但需保存 DTO 并管理缓存；当前地图主要用于定位当前内容，因此采用有界概览加当前窗口，每次采样明确是新的结果。

## 后果与风险

地图可独立使用，ACP 不反向进入 session-tools。逐节点估价可以比较区段体量，但不能称为“压掉后省多少 token”：摘要、framing 与工具交互成本属于 ACP 的收益核算。

采样使用同一 Session，按 seq 对齐节点与价格；预览与计量分别标 basis。输出 DTO 与内部可变容器分离，不增加全日志哈希或第二份状态真源。

## 验收要点

1. 高 seq checkpoint 仍按 Surface 位置展示；空/dormant、长 Turn 和中途输入不丢位置，不伪造 Turn。
2. live/cold 节点与 meter 同源对齐；逻辑 cut、内存 marker、计量 revision 及准备模式分别验证；无历史 Agent 激活或持久写入。
3. 本次返回 DTO 不因后续追加/replacement 改变；下一窗口重新采样当前状态，缺失 anchor 明确报错，scope 和输出预算行为可诊断。
4. preview/pricing basis 正确；无 meter、容量未知或路由不匹配不造价格或百分比。
5. 不启用 ACP 也有区段估价；启用 ACP 不改变标准地图；locator 可交给压缩入口，执行仍重验。
6. 公开库子入口、工具注册、peer 类型、发布 tarball 与实际 Loader 组合验证，无重复工具注册。

## 实现方负责的收敛与验证

正式工具/DTO/库类型由实现方按上述语义落地，不要求用户选择内部字段。暂定默认值如下，均未做地图输出实测；优先复用已有预览与输出限额配置，不为地图增加无必要的独立参数。

| 项目 | 暂定值 |
|---|---|
| 默认窗口节点数 | 20 |
| 最大窗口节点数 | 100 |
| 每节点预览长度 | 240 Unicode code points |
| 完整 JSON 输出上限 | 24 KiB（24576 UTF-8 bytes） |
| 概览最多连续区段数 | 12 |

骨架实现后，使用本机若干现有会话粗测概览、节点窗口和中文/附件内容的输出体量及可读性，确认或调整这些数字，再更新本文和对应配置。以足够合理、便于工作为目标，不做精确最优参数搜索，不再逐项询问用户。超输出限额明确报错并建议缩小展示，不制造旧图续页。

已核对源码：Query store/live 解析与租约见 [observation.ts](../../../deepseek-harness/packages/session-query/session-query/src/observation.ts#L152-L268)；meter 的同步采样与不可变 measurement 见 [token-meter](../../../deepseek-harness/packages/llm/token-meter/src/index.ts#L146-L190)。预览使用 Session 当前解释，meter 则按同 Session 日志走自己的原事件 fold 与 image/offload、附件路由定价；二者不承诺定价文本完全相同，也不承诺任意插件改写或最终 wire 转换等价，见 [meter fold](../../../deepseek-harness/packages/llm/token-meter/src/surface-fold.ts#L107-L127)。

现有输出配置见 [session-tools 配置](../../src/index.ts#L27-L31)，scope、预览与结果字节限制复用 [shared helpers](../../src/shared.ts#L15-L42)。本次仅源码核对，仍需实施测试节点对齐、空节点、cold marker、图片、预算与真实发布导入。
