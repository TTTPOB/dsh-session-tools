# ADR 0002：按需读取相关记录，明确展示不完整内容

- 状态：Accepted（已采纳）
- 实施情况：已完成并验收。固定 observation、原事件分页、有界补读、完整性证据、整页预算与超时已接入 List/Read；默认值已依据本机 6 个真实历史会话做有界估计后保留，见[校准依据](<../reading-budgets.md>)。

## 背景

一次工具操作可能分散在多条日志里。例如第 100 条记录调用工具，第 180 条才记录结果。事件列表按页读取，某一页可能只包含调用，不包含结果。

[ADR 0001](<0001-shared-event-association-and-projection.md>)要求把相关记录合起来展示：Compact 简要展示，Detail 展示更多内容，Raw 精确读取指定原始事件。因此，插件需要在当前页之外再找一些相关记录。

底层公开 `SessionObservation.readEvents(from, to)` 可读取半开事件序号区间（包含 from，不含 to）；`pageEvents` 只返回元数据及可选提取文本、不返回 payload 或当前消息分类。已有 seq 范围读取，但没有“找出某次调用或某个助手执行阶段的全部记录”的查询接口。这里决定每次查找多少，以及找不齐时如何呈现。

## 先看一个跨页例子

**这份 ADR 主要回答：一个活动被分页切开后，要补读哪些记录，以及没补齐时怎么办。** 活动即一次助手响应及相关工具操作；它可能超过一页，也可能只是恰好被分页边界切开。

下面使用当前接口字段，省略无关字段，展示分页与补读的关系。假设以下记录属于 `step:1:1`，第 99 条为已核实的 `step/start`：

```json
[
  { "seq": 100, "type": "assistant/message" },
  { "seq": 101, "type": "tool/call" },
  { "seq": 102, "type": "tool/result" },
  { "seq": 103, "type": "step/end" }
]
```

本次 List 请求只选两条原始记录作为当前页：

```json
{ "session_id": "s1", "after_seq": 99, "limit": 2 }
```

插件额外读到第 99、102、103 条，核实完整阶段及必要关系后，返回：

```json
{
  "activities": [{
    "activity_id": "step:1:1",
    "page_source_seqs": [100, 101],
    "source_seqs": [99, 100, 101, 102, 103],
    "complete": true,
    "truncated": false
  }],
  "has_more": true,
  "next_after_seq": 101
}
```

`page_source_seqs` 是本页消费的记录，`source_seqs` 是展示实际使用的全部记录。**虽然展示用了五条，本页仍只消费两条。** 下一页仍会选到 102、103，同一活动可以再次出现；不能因为补读就跳过它们。

如果补读只取得第 99、102 条，没有取得阶段结束，则返回部分活动：

```json
{
  "activities": [{
    "activity_id": "step:1:1",
    "page_source_seqs": [100, 101],
    "source_seqs": [99, 100, 101, 102],
    "complete": false,
    "incomplete_reasons": ["step_coverage_unproven"],
    "truncated": false
  }],
  "has_more": true,
  "next_after_seq": 101
}
```

关系已读齐、但展示有省略时，这两个标记可以同时为 true：

```json
{ "complete": true, "truncated": true }
```

本 ADR 只定义两种标记的区别。正文预览、Compact/Detail 的展示差异和 Raw 回读示例见 [ADR 0001：投影示例](<0001-shared-event-association-and-projection.md#投影示例>)。

简记：**分页决定本次消费哪些记录，补读决定活动能解释到什么程度，展示预算决定正文能显示多少。** 三者分别处理。

## 决策一：先读当前页，再有限地补找相关记录

列表先选出当前页的原始事件，再读取附近记录，以及事件明确引用的其它记录。Read 默认 `read_scope: "target"`，只补读解释目标事件或配对目标调用所需的记录；不展开父工具、兄弟调用或所有子调用。显式 `read_scope: "activity"` 才寻找整个所属活动。范围与密度的选择见 [ADR 0001：Read 范围示例](<0001-shared-event-association-and-projection.md#read范围与信息密度分开>)。

例如当前页有第 100 条工具调用，插件可以往后补读，寻找具有相同调用 ID 的结果。找到后合并展示；超过读取范围仍未找到，就显示“结果未观察到”，并保留原始事件的读取入口。

查找受读取范围、事件数量和数据量等限额约束。不会为了补齐一次操作，每次都处理整个会话历史，也不会仅凭记录相邻就认定它们有关。

**这项取舍优先保证常见浏览开销可控，而不是保证每次都找齐所有相关记录。** 本轮接受有界补读无法证明任意跨度关系完整，不新增公共关系查询。

## 决策二：一次查询使用固定的日志截止位置

假设查询开始时有 200 条事件，这次主读和补读都只使用前 200 条。查询期间新增的第 201、202 条留到下一次查询。

实现使用底层的 `SessionObservation`，即一次查询持有的读取对象。它固定本次可见的最后事件序号（cut），响应以 `captured_through_seq` 标明。使用 `projectionMode: "none"`，在同一读取租约（lease）内选择页内锚点及补读，不先独立分页再取得另一 cut；finally 释放对象，返回值不保留 lease。不使用 `.events` 物化全日志。

不同查询可以看到不同的截止位置。稍后再查时，新结果可能已写入，原先不完整的操作就可能展示完整。

## 决策三：补找记录不改变翻页位置

分页仍按原始事件序号进行。`limit` 表示本页选取多少条原始事件，不是合并后显示多少个活动。

例如本页选中第 100、101 条，为了说明这两条记录，又补读了第 102 条：

- 本页只消费第 100、101 条。
- 下一页仍从第 101 条之后继续，第 102 条不会被跳过。
- 同一操作可以在下一页再次出现；返回内容说明哪些记录属于本页，哪些只是补读。

`event_types` 只决定本页选哪些事件，不限制解释这些事件时补读的类型。例如筛选工具结果，仍可补读对应调用。只有确认还有匹配记录时才返回下一页位置。

## 决策四：区分“没有读齐”和“没有全部展示”

这两种情况对读者的意义不同，必须分别标记：

| 情况 | 展示含义 | 返回标记 |
|---|---|---|
| 读到调用，但没有找到结果 | 相关记录没有读齐 | `complete: false`，附原因 |
| 已读齐一次操作，但结果太长，只显示预览 | 记录已齐，内容展示有省略 | `complete: true, truncated: true` |
| 既没找到父调用，结果正文又被缩短 | 两种情况同时存在 | `complete: false, truncated: true` |

“未观察到”不等于“日志中不存在”，也不等于“仍在运行”。`complete` 按请求范围判断：target 范围中，配齐目标调用及必要引用即可，不要求读取所有兄弟或子调用；activity 范围中，只有一对调用和结果不足以证明整个阶段完整，需要取得其开始、结束及中间记录，并补齐必要的明确关联。未请求的其它调用不算缺失，也不因此标记展示截断。

已经发现的错误不能因为缩短展示而消失：即使省略错误正文，也保留错误存在和对应事件序号，方便继续读取。

工具结果默认展示原始执行结果，replacement 去重与明确引用规则见 [ADR 0001](<0001-shared-event-association-and-projection.md#replacement-去重默认展示原始执行结果>)；完整性不要求找到所有后续版本。

## 展示预算与精确续读

补读事件数、处理字节、跨度、树深度/节点数和展示预算分别受限。默认 `readBatchSize=128`、`readSupplementalEvents=1024`、`readProcessingBytes=8388608`、`readSeqSpan=4096`；展示默认 `projectionStringChars=2000`、`projectionItems=32`、`projectionDepth=8`、`projectionNodes=512`、`outputBytes=24576`；`readTimeoutMs=30000`。这些值在功能验收后通过公开 query 对本机 6 个真实历史会话有界抽样估计后保留，具体数据及局限见[读取预算校准](<../reading-budgets.md>)。样本中阶段最多 27 条事件、工具配对最大间隔 23 seq、PTC 最多 11 个直接子节点，当前读取限额有余量；长正文和大集合则按设计裁剪，不以放大预算追求全文。30 秒是执行上限，不是已量测的冷历史性能保证。

避免先完整序列化巨大对象再截短；优先保留身份、状态、错误、requested/read seq 和分页字段，按最终 JSON UTF-8 字节数执行 outputBytes。若最小完整页仍放不下则明确报错，不交付部分页或可跳记录的 cursor。

Raw 沿用 Unicode code-point JSON 分片续读：单片不一定可解析，按 next_offset 拼接后再解析；offset_chars 仅用于显式 Raw，语义视图不得混用。读取大事件时只保证查询服务提供的逻辑事件，不获取 spill/附件全文。scope 默认精确调用方 cwd 的 project，all 必须显式且限当前 provider；补读不扩大授权。

## 代价与实施边界

- **查询可能返回部分记录。** 读者可以继续用 Detail、Raw 或自行编写 PTC 分析代码查找；插件不承诺一次补齐任意跨度的操作。
- **局部展示不代表所有底层读取都便宜。** 当前活跃会话可以按范围读取；尚未加载的历史会话，首次准备可能读取完整日志。按事件类型筛选时，也可能经过很多不匹配记录才能找到下一页。这些成本需要单独量测，底层优化见 session-query 的[增量内存分析决策](<../../../deepseek-harness/.agents/notes/implemented/architecture/2026-10-09-session-query-incremental-memory-analysis.zh.md>)。
- **超时不能假装已经读到末尾。** 取消或超时应明确报错，不返回可能跳过事件的翻页位置。
- **读取权限保持不变。** 补读仍限于已授权会话，发现子会话入口不会自动读取子会话正文。

实现依据：[observation.ts](<../../../deepseek-harness/packages/session-query/session-query/src/observation.ts>) 中的 `SessionObservation` 与 `SessionObservationReader` 定义公开读取接口及历史会话准备/缓存；[query 引擎](<../../../deepseek-harness/packages/session-query/session-query/src/index.ts>) 中的 `pageEvents` 定义分页规则。

## 验证要点

1. 调用和结果跨页时，补读能帮助理解，但不会让下一页跳过记录。
2. 没读齐、展示省略、两者同时发生时，标记准确；错误始终有可追溯入口。
3. 单目标 replacement 的补读不改变 Raw requested seq；摘要来源不冒充原工具结果。
4. 新事件追加、稀疏类型筛选、历史会话首次读取及超时场景中，分页和状态判断仍然可信。
