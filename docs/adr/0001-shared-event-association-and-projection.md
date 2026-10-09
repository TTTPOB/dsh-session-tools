# ADR 0001：历史事件共享关联与投影模型

- 状态：Accepted（已采纳）
- 实施情况：已完成并验收。共享关联、Compact/Detail 投影与 Raw 入口已接入公开读取工具；有界补读与展示裁剪的限制见 [ADR 0002](<0002-local-reading-and-completeness.md>)，默认预算依据见[读取预算校准](<../reading-budgets.md>)。

## 背景

维护者和模型需要从会话历史理解“助手说了什么、调用了哪些工具、各自怎样结束”。原始事件按 `seq`（会话内原始事件序号）排列，但同一次活动的消息、调用和结果可以分散在多条记录中。此前列表从全文搜索提取文本生成预览，精确读取只返回单条原始事件。现在[浏览工具](<../../src/read-tools.ts>)共用关联与投影模型。

本设计提供三种读取视图：**Compact** 是用于浏览的简要活动视图；**Detail** 是同一活动的较详细内容和关系；**Raw** 是指定 `seq` 的完整逻辑事件，用于核验证据。活动是将有明确关系的事件组合成一个阅读单元，例如一次助手响应及其工具执行。Compact 与 Detail 对同一份证据应给出一致的活动身份与归属。

## 决策

### 一套关联结构，两种信息密度

先依据原事件建立活动身份、来源、父子关系和状态，再生成 Compact 或 Detail。两种视图共用关联规则；展示裁剪只改变信息量。事件列表工具 `session_event_list`（下文简称 List）默认 Compact，按活动合并浏览；List 保留只看序号和类型的 metadata 视图。

事件读取工具 `session_event_read`（Read）将信息密度和读取范围分开：`view` 默认为 `detail`，`read_scope` 默认为 `target`，可显式选择 `activity`。`target` 详细展示目标事件；若目标是工具调用或结果，则补齐该次调用的参数、结果和必要身份，不自动展开父工具、兄弟调用或整个 Step。返回可得的父 Activity 定位信息，供调用方按需扩大读取。`activity` 才有界读取目标所属的整个活动。Compact 和 Detail 都遵守所选范围，不以 Detail 自动扩大范围。

显式 `view: "raw"` 精确读取指定 `seq`，不关联其它事件；不允许同时请求 `read_scope: "activity"`。Raw 不将关联后的活动伪装成原始事件。

Step 指一个 Turn（一次会话轮次）内由明确 `step` 身份标识的助手响应及工具执行阶段。同一显式 `turn + step` 的 Assistant 消息、普通工具调用和结果组合为一个 Step。调用与结果按 `callId` 关联；Assistant 内容中的调用块与执行事件按真实调用 ID 去重，执行参数以执行事件为证据。只有调用块时标记“执行未观察到”。没有可靠身份的事件保持独立，不依据相邻位置或工具名称猜归属。

活动保留可回读的原始 `seq` 和实际来源集合。来源集合不是最小、最大序号之间的连续区间；孤立片段在后来找到根节点后可以改归活动，但原始回读入口仍有效。分页及完整性语义由 [ADR 0002](<0002-local-reading-and-completeness.md>)规定。

### PTC 的父子关系和状态独立

PTC（Programmatic Tool Calling，程序化工具调用）允许代码执行期间调用其它工具。日志中的 dispatch 开始与结算记录按 `subCallId` 配对，`parentCallId` 表示直接父节点，`rootCallId` 表示根调用。子节点沿直接父链组成树，再继承已核实根工具的 Step 身份；找不到根时保留独立片段。

每个节点的结果、错误和状态来自自身事件。父工具成功不会覆盖子工具失败：例如 `run_code` 捕获子 `read` 的文件不存在错误后正常返回，视图应同时显示父成功和子失败。并行子节点按开始顺序展示，保留各自结算序号；未读到结算仅表示“结果未观察到”，不能据此称仍在运行。

这一模型适用于 JavaScript/TypeScript 与 Python；不解析历史源码来重建调用。dispatch 树只覆盖日志记录的工具调用，不能代表代码中的所有计算或直接文件访问。

### replacement 去重，默认展示原始执行结果

surface 是按消息替换规则折叠出的当前消息节点序列；replacement 是追加的消息替换记录，不是再次执行。pruner 指自动裁剪过长工具结果的生产模块；checkpoint 指摘要替代区间后留下的 user 消息节点。默认工具节点展示原始 append 的执行结果，不默认展开裁剪版本链，也不寻找全局最新版本。若锚点是单条 pruner replacement，可沿明确的单目标引用有界补读原工具结果；无法取得时保留缺口和双方 Raw 入口，不能把替代文本冒充原结果。

当前真实 producer 包括 system prompt 归一化、工具结果 pruner 和摘要 compaction。固定有效配置下，pruner 的输出已在阈值内，后续 pass 跳过，见[裁剪及阈值检查](<../../../deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts#L83-L121>)与[生产引用](<../../../deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts#L136-L181>)。原工具结果可以先被裁剪，再被 user 摘要覆盖；后者是区间摘要，不是工具结果的第二次裁剪或新结算。

system replacement 和摘要 checkpoint 的再次覆盖是真实路径，分别见[system producer](<../../../deepseek-harness/packages/core/agent-loop/src/runtime-context.ts#L88-L110>)与[摘要提交](<../../../deepseek-harness/packages/compaction/compaction-basic/src/region.ts#L470-L509>)。保留它们的明确来源和 Raw 入口，但不因此强加工具结果版本展示。复合 summary 的来源可以包含 start、summary 及多个消息，不能把任意来源读成某个工具的结果。

替换区间按当前 surface 节点位置确定，来源引用也可包含未被覆盖的诊断，见[范围与引用规则](<../../../deepseek-harness/packages/core/session/src/surface.ts#L335-L440>)。因此来源集合和替换端点都不能当作连续原始 seq 区间。Raw 始终准确返回 requested seq，包括 replacement 本身，不能偷偷改读其原结果。

### 事件覆盖按语义复杂度分层

对当前构建已知事件，每种类型都应有明确投影策略，每个本页事件都可追溯到活动或独立记录：

- 消息、Step/Turn 边界、工具与 PTC：按明确身份关联，保留角色、来源、真实结果和错误。system 的空内容、developer 的工具增删块也有意义，不能当作空预览丢弃。
- 压缩、重试、workflow 等生命周期：按自身身份配对，独立呈现各层结局。compaction 按 compactionId 关联 start/end/summary，end.error 是失败证据，没有 summary 不等于没有压缩；summary 与 replacement user 只按明确来源引用合并。workflow 按 runId 及内部 agent 序号关联，内部序号不当作 Session `seq`，缺少 callId/turn/step 时独立展示；PTC 内 workflow 不保证生成这四种记录。子代理 catalog 是发现身份，不是结算，不自动读取 child 正文。
- 待办、策略、标题、反馈、交付及其它简单事实：提供有界字段预览和 Raw 入口，不要求都建成复杂树。可选扩展与历史保留类型按其实际日志能力展示。

对读取服务已经接受、但插件尚未认识的类型，保留 type、seq、有界 payload 和 Raw 入口；底层拒绝未知必需类型时保留原错误。事件覆盖以[核心事件词汇](<../../../deepseek-harness/packages/core/session/src/known-event-types.ts>)和对应生产字段为检查入口，不把词汇存在当成当前 profile 已启用该插件的证明。

## 投影示例

### Read：范围与信息密度分开

以下请求与简化响应使用当前接口字段，省略无关元数据。第 103 条是 PTC 子 `read` 的结果。默认 Read 只关联目标调用，不展开其它调用：

```json
{ "session_id": "s1", "seq": 103, "view": "detail" }
```

```json
{
  "requested_seq": 103,
  "read_scope": "target",
  "tools": [{
    "call_id": "sub1",
    "name": "read",
    "start_seq": 102,
    "result_seq": 103,
    "arguments": { "file_path": "config.json" },
    "is_error": true,
    "error": { "code": "FS_NOT_FOUND", "message": "文件不存在" }
  }],
  "activity_locator": { "root_call_id": "c1" }
}
```

定位字段只返回已取得的可靠身份；不为填 Activity ID 补读整棵树。目标为父工具时，同样默认只返回父调用本身，不自动展开子调用。极端情况下，一个 PTC 程序可能调用 100 个子工具；读取其中一个结果不应自动把另外 99 个调用带入上下文。需要查看整个活动时显式扩大范围：

```json
{ "session_id": "s1", "seq": 103, "view": "detail", "read_scope": "activity" }
```

以下是 List 的 `activities` 元素或显式 `read_scope: "activity"` 的简化活动响应，省略无关字段。假设一次 `run_code` 调用内部执行了 `read`，子调用失败后，程序捕获错误并正常返回。

### Compact：看活动和各层结局

```json
{
  "activity_id": "step:1:1",
  "kind": "step",
  "source_seqs": [99, 100, 101, 102, 103, 104, 105],
  "records": [{
    "seq": 100, "type": "assistant/message", "read_seq": 100,
    "preview": { "role": "assistant", "content": [{ "type": "text", "text": "检查配置文件" }] }
  }],
  "tools": [{
    "call_id": "c1",
    "name": "run_code",
    "start_seq": 101,
    "result_seq": 104,
    "is_error": false,
    "result": [{ "type": "text", "text": "检查完成，配置文件不存在" }],
    "children": [{
      "call_id": "sub1",
      "name": "read",
      "start_seq": 102,
      "result_seq": 103,
      "is_error": true,
      "error_observed": true,
      "error_seq": 103,
      "error_code": "FS_NOT_FOUND"
    }]
  }],
  "complete": true,
  "truncated": true
}
```

父工具成功、子工具失败同时可见。这里假定第 99、105 条是已核实的阶段边界，区间和必要关系已读齐，所以 `complete` 为 true；参数和结果正文有省略，所以 `truncated` 为 true。完整性判定见 [ADR 0002](<0002-local-reading-and-completeness.md#决策四区分没有读齐和没有全部展示>)。

### Detail：同一结构，展开内容

对同一份证据，Detail 保持相同的活动 ID、调用身份和父子关系，增加参数、结果与错误正文。以下只展示展开后的工具部分：

```json
{
  "activity_id": "step:1:1",
  "tools": [{
    "call_id": "c1",
    "name": "run_code",
    "start_seq": 101,
    "result_seq": 104,
    "is_error": false,
    "result": [{ "type": "text", "text": "检查完成，配置文件不存在" }],
    "children": [{
      "call_id": "sub1",
      "name": "read",
      "start_seq": 102,
      "result_seq": 103,
      "arguments": { "file_path": "config.json" },
      "is_error": true,
      "error": { "code": "FS_NOT_FOUND", "message": "文件不存在" }
    }]
  }]
}
```

Detail 也受展示预算约束，不保证展开所有正文。若结果很长，可缩短或省略 `result` 预览，保留 `result_seq` 并标记 `truncated: true`。具体默认预算及抽样依据见 [ADR 0002](<0002-local-reading-and-completeness.md#展示预算与精确续读>)。

### Raw：指定原始事件，不返回合并活动

Raw 可用于核验任意指定事件，包括消息、调用、结果和状态变更。下面以读取子调用结果为例，使用它的 `result_seq`：

```json
{ "session_id": "s1", "seq": 103, "view": "raw" }
```

Raw 返回第 103 条原始逻辑事件，而不是整个 `step:1:1` 活动。大事件可以分片续读；日志中只有 spill 预览和定位符时，Raw 也不会自动取回外置全文。

### 从 replacement 定位原工具结果

以下是假设单目标 pruner replacement 位于 90、引用原结果 40 的简化响应：

```json
{
  "requested_seq": 90,
  "records": [{
    "seq": 90, "type": "tool/result", "read_seq": 90,
    "original_result_seq": 40,
    "surface_op": { "op": "replace", "startSeq": 40, "endSeq": 40 }
  }],
  "tools": [{
    "call_id": "c1", "result_seq": 40,
    "result": [{ "type": "text", "text": "Original execution output" }]
  }]
}
```

Detail 可沿明确引用展示原结果；Raw 请求 90 仍返回第 90 条 replacement。摘要覆盖多个消息时，不使用这一单结果规则。

## 理由与替代方案

- **独立 Activity 档位**与 Detail 的活动阅读目的重复，增加不必要的选择。**两套 Compact/Detail 关联**则容易让同一调用的归属或状态不同；共享结构把身份判断集中在一处，只调整信息密度。
- **仅展示逐条事件**虽容易精确回读，却把配对、去重和版本判断交给每个调用方。保留 Raw 作为证据层，活动视图承担常见历史理解工作。
- **用邻接或解析源码补齐树**可能把并行调用、裁剪版本和独立诊断拼错。接受部分活动比制造完整执行史更可信。

## 后果

关联与投影由本插件负责，仍只通过公开 `ctx.sessionQuery` 读取；不持久化另一份活动树。搜索索引职责单独见 [ADR 0003](<0003-search-and-projection-separation.md>)。

采用上述接口，不为旧返回结构或已有一次性 PTC 调用代码提供兼容层、双轨或过渡期开关：临时代码没有持续兼容需求，维护两套返回契约的成本不值。调用方需要更新。Raw 保留现有大事件续读方式；“完整逻辑事件”不承诺恢复 spill（移到日志外的大结果）的全文、二进制附件或磁盘 JSONL 的物理原文，也不自动读取子会话正文。

## 验证要点

- 普通多工具 Step 和仅有 Assistant 调用块的场景中，Compact/Detail 身份一致，调用不重复，状态不虚构。
- PTC 嵌套、并行乱序及父成功子失败场景保留直接父链和各节点结局。
- 原结果与 pruner replacement 只有一次执行，默认展示原结果；后续摘要不冒充工具结果，Raw 不改 requested seq。
- 按已知事件族检查投影策略与来源追溯；简单、可选、历史及未知已接受事件不会静默消失。

## 附录：当前构建的 59 项覆盖基线

按[已知事件词汇](<../../../deepseek-harness/packages/core/session/src/known-event-types.ts#L22-L82>)合并事件族，共 14 + 11 + 18 + 16 = 59 项。这是所查构建的检查基线，不是永久穷尽清单；可选 team 不代表已加载，schedule/change 为历史保留。FTS 的“有”只表示存在提取分支，空文本仍不建文档。Compact/Detail 均从原字段预览。

### 核心消息与结构（14 项）

| 类型 | Compact | Detail / 关联 | 现有 FTS |
|---|---|---|---|
| `user/message` | 正文、实际 source、seq | 有界 content/附件 locator、source discriminant、替换引用；非固定 human/agent/plugin 三选一 | 有：text/tool-call |
| `system/message` | 角色、正文变化或清除标记 | 有界 message 与 replacement；空消息的清除/休眠语义保留 | 无 |
| `developer/message` | 注册/移除工具等变更 | 保留 tool-addition/removal 的块、toolName、headerSeq；有界补读定义，不复制完整 request header | 无 |
| `assistant/message` | Step 正文与工具树 | 更多正文、interrupted、usage；stream/reasoning 默认不展开 | 有：text/tool-call |
| `assistant/attempt` | Step 有未提交尝试 | 有界尝试诊断，不作成功正文，不因同 Step 就把多个 attempt 与 retry 一一配对 | 无 |
| `tool/call`, `tool/result` | 名称、参数/结果预览、真实状态 | 按 callId 配对，识别 replacement 并定位原结果，有界 error.reason/meta | 有；result 的 error.name/code，不含全部 reason/meta |
| `turn/start`, `turn/end`, `step/start`, `step/end` | 边界/最终状态，或归入对应活动 | turn/end.reason/error，真实 turn/step 与边界 seq；全部保留 Raw 入口 | 仅 turn/end 部分结局有 |
| `request/header`, `request/context` | 请求变化、route、seq | 有界配置、system/tool 概况；headerSeq 显式引用可补读，缺身份不绑定 Step | 无 |
| `session/end-seed` | 恢复/继承 cut | inherited 标志及生命周期边界，不重复展开 seed 正文 | 无 |

### 工具嵌套、压缩与诊断（11 项）

| 类型 | Compact | Detail / 关联 | 现有 FTS |
|---|---|---|---|
| `tool/ptc-dispatch-start`, `tool/ptc-dispatch` | 子工具预览与各层状态 | 按 subCallId/rootCallId/parentCallId 组成树；有界参数、content、error 与 spill locator | 无 |
| `compaction/start`, `compaction/end` | 压缩发生、结局或未观察到结局 | compactionId 配对、turn/sourceCommandId、end.error | 无 |
| `compaction/summary` | 摘要预览与来源数量 | 更多 summary、shadowedSeqs、模型信息；按引用与 replacement user 去重 | 无；replacement user 的 text 可有 |
| `compaction/prune` | 裁剪对象概况 | shadowedSeqs、估算 token；不称精确节省量，不凭邻接绑 replacement | 无 |
| `image/offload` | 目标与图片数量 | target seq/imageIndexes 与模型请求投影变化；不称删除原附件或 surface replacement | 无 |
| `llm/retry`, `llm/retry-started` | 失败/等待/重试启动 | retryId 配对，turn/step 可归诊断；provider/failure/retry/delayMs；启动不是成功 | 无 |
| `hook/invoked`, `hook/result` | Hook 与决策/结局 | 有界 handlerId/point/exitCode/stderrSummary/durationMs；无唯一执行身份时不凭邻接配对 | 无 |

### Agent、workflow、状态与策略（18 项）

| 类型 | Compact | Detail / 关联 | 现有 FTS |
|---|---|---|---|
| `agent/inbox/spliced` | 入队/移除数量、target、outcome | 有界消息 id/source；与后续 user 消费阶段分清；仅同 message id 时链接阶段，撤销不称已进模型 | 无 |
| `subagent/catalog` | child 身份/label/mode | childId/childCreatedAt locator；发现不推断已结算 | 无 |
| `subagent/descriptor` | 当前 child 的模式/provider | 有界 composition，与 header 身份合看；不是父工具结果 | 无 |
| `subagent/model-selection-policy` | 路由政策事实 | 有界 allowedModels 等 metadata | 无 |
| `tool-workflow/run-start`, `tool-workflow/run-end`, `tool-workflow/agent-start`, `tool-workflow/agent-end` | 独立 workflow、子任务状态 | runId 与内部 agent seq 配对，childId/label/phase/outcome/stopReason；不冒认 Step 或工具归属 | 无 |
| `todo/write` | 待办数量与状态概况 | 有界本次 todos 快照；没有 callId，独立展示 | 有 |
| `goal/change` | 目标/状态变化 | 有界目标与变更，不从相邻工具推归属 | 无 |
| `plan/mode` | active 状态 | metadata 与 seq；事件不保证含完整计划 | 无 |
| `sandbox/mode`, `approval/policy`, `permission/preset` | 策略新值/source | 有界 metadata；日志历史值不保证等同当前运行策略 | 无 |
| `approval/asked`, `approval/decided` | 审批请求与选择 | 以真实 id 配 request/outcome；批准不是执行成功 | 无 |
| `model/selection`, `agent-preset/selected` | 模型/preset 选择 | 有界 metadata；实际 request route 仍以 header/context 为证据 | 无 |

### 命令、交付、辅助请求、反馈及可选/历史（16 项）

| 类型 | Compact | Detail / 关联 | 现有 FTS |
|---|---|---|---|
| `command/run`, `command/done` | 命令与结局 | 按真实 command identity 配对，有界诊断；不是 tool/call | 无 |
| `deliverables/presented` | 交付数量/文件 locator | turn/callId/files 可关联真实工具；不打开文件 | 无 |
| `workspace/changes` | 变化 marker 与 turn | 持久 payload 只有 turn；冷历史不保证有 live Host 中的文件列表或 diff | 无 |
| `session/title`, `session/title-llm-request` | 标题或辅助请求标记 | 有界 title/request；请求不代表已产出标题，不是 assistant 正文 | 无 |
| `web/deepseek-search-llm-request` | 辅助搜索请求标记 | 有界请求诊断，不是最终搜索结果 | 无 |
| `feedback/record`, `feedback/message-put`, `feedback/message-delete` | 反馈/修改/删除事实 | messageId 与有界 note/版本；反馈删除不删除原模型消息 | 无 |
| `session-log-deepseek/delivery-accepted` | 上传接受/receipt | 有界回执 metadata，不当工具结算 | 无 |
| `team/member`, `team/task`, `team/message/queued`, `team/message/delivered`（可选） | type、主要身份、seq | 有界 payload 与明确存在的 locator；首版不保证完整团队状态或跨阶段复杂关联 | 无 |
| `schedule/change`（历史保留） | 历史 schedule 变更标记 | 有界 metadata/Raw；当前管理写 Host storage，不承诺日志重建整个任务库 | 无 |

未来未知事件：仅对底层读取服务已经接受的类型提供 type、seq、有界 payload 与 Raw 入口，不强行归组或递归索引。底层拒绝未知 required 类型时保留原错误，不绕过恢复校验。

不另立 Session Log 类型：jobs 的 output/progress/settled bus、workflow phase/log mirror、assistant live chunk、工具 lifecycle bus、inbox inserted/discarded、附件二进制、workspace live diff、schedule changed UI 通知。它们已有的持久证据分别通过 inbox/user、tool result/PTC、上述四个 workflow 事件或具体 marker 展示。
