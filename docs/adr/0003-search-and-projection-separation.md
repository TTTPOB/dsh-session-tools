# ADR 0003：搜索与事件投影分离

- 状态：Accepted（已采纳）
- 实施情况：已完成并验收。surfaces 过滤与轻量 read_seq 已接入搜索；省略 surfaces 默认覆盖全部三个面中的既有索引文档，原字段投影不扩展索引。

## 背景

全文搜索、事件预览和原始日志服务于不同问题。搜索回答“现有索引中哪些事件匹配关键词”；预览帮助理解事件和活动；原始读取用于核验指定事件。可读内容并不一定进入全文索引。

现有[文本提取器](<../../../deepseek-harness/packages/session-query/session-query/src/extraction.ts>)只为 user/message、assistant/message、tool/call、tool/result、todo/write 和部分 turn/end 提取文本；空文本事件不建立搜索文档，见[文档构建](<../../../deepseek-harness/packages/session-query/session-query/src/documents.ts#L36-L53>)。例如工具结果中的 error.name/code 可被提取，error.reason/meta 并不会因此全部可搜索。PTC（Programmatic Tool Calling，程序化工具调用）在代码执行中产生的子工具 dispatch 记录没有独立全文文档。

此前列表复用同一提取文本生成预览，导致“未索引”也变成“缺少可读预览”；现在[列表](<../../src/read-tools.ts>)直接投影原事件字段。历史理解需要改善预览，但不必同时扩大搜索索引。

## 决策

### 保持索引规则，预览直接读原字段

保持现有全文索引类型和文本提取规则，不新增 PTC、重试、目标或其它事件的文本索引；不更改索引 schema、版本或历史索引内容，不安排索引重建。

Compact（简要活动视图）与 Detail（较详细的同一活动视图）从原事件字段生成有界正文、参数、结果和错误预览，不依赖全文提取器。共享关联模型见 [ADR 0001](<0001-shared-event-association-and-projection.md>)，局部读取与完整性见 [ADR 0002](<0002-local-reading-and-completeness.md>)。Raw 则精确读取指定原始 `seq`（会话内事件序号）的完整逻辑事件。

例如 PTC 子 `read` 在 dispatch 结算中记录 `FS_NOT_FOUND`，Detail 可以展示这个错误，但全文搜索不会命中该 dispatch，因为它没有独立索引文档。若该字符串也没有出现在其它已索引事件中，搜索就没有命中。搜索到普通 tool/result 中的同名错误，也只证明那个结果文档匹配，并不代表所有同名 PTC 错误都被检索。**没搜到不等于没记录。**

### surfaces 过滤由 provider 执行

surface 是事件在消息投影中的分类，不是消息来源或重要性等级。查询 provider 基于完整日志折叠消息与替换关系，提供三类标签，见[surface 类型](<https://github.com/TTTPOB/deepseek-harness/blob/8091de25e10c43debeda8f5485102adf41f0db42/packages/session-query/session-query/src/types.ts#L24-L25>)与[分类实现](<https://github.com/TTTPOB/deepseek-harness/blob/8091de25e10c43debeda8f5485102adf41f0db42/packages/session-query/session-query/src/documents.ts#L16-L27>)、[消息与替换折叠](<https://github.com/TTTPOB/deepseek-harness/blob/8091de25e10c43debeda8f5485102adf41f0db42/packages/session-query/session-query/src/documents.ts#L57-L74>)：

- `current`：仍在当前消息投影中的事件。
- `shadowed`：被 replacement（追加的新消息替换记录）覆盖的旧消息事件。
- `log-only`：其余日志事件，例如普通工具调用和待办记录；不等于无关或不可搜索。

例如一次普通工具调用：含 `tool-call` 块的 [assistant/message](<https://github.com/TTTPOB/deepseek-harness/blob/8091de25e10c43debeda8f5485102adf41f0db42/packages/core/agent-loop/src/agent.ts#L495-L518>)进入模型消息投影；独立的 [tool/call](<https://github.com/TTTPOB/deepseek-harness/blob/8091de25e10c43debeda8f5485102adf41f0db42/packages/core/agent-loop/src/tool-calls.ts#L262-L266>)记录执行开始，属于 `log-only`；[tool/result](<https://github.com/TTTPOB/deepseek-harness/blob/8091de25e10c43debeda8f5485102adf41f0db42/packages/core/agent-loop/src/tool-calls.ts#L268-L290>)作为结果消息进入投影。前后两个消息事件未被后来替换时是 `current`，被替换后是 `shadowed`，并非永远 `current`。`log-only` 只说明这条独立记录不进入消息投影，不表示模型完全不知道该操作：调用块和结果消息仍可提供该操作的信息。

提供可选 `surfaces` 参数。显式数组按 OR 过滤，空数组拒绝；插件将其转换为现有 surface metadata filter，交给 provider 在查询阶段执行，而不是取得一页命中后再删除。搜索仍只覆盖这些面中**已有的索引文档**，选择三个面也不是遍历原始日志中的所有字段。

省略 `surfaces` 时，默认覆盖 `current`、`shadowed`、`log-only` 三个面中已有的全部索引文档，因为历史回忆可能需要被替换的正文，以及 log-only 的 tool/call、todo 内容。默认范围由历史回忆需求决定，不以旧调用代码兼容性为依据。

### 搜索返回轻量 seq 入口，深挖交给读取

事件搜索工具 `session_event_search`（Search）的命中返回 `seq/type/time/surface/snippet/read_seq`，其中 `read_seq=seq` 可直接交给事件读取工具 `session_event_read`（Read）。保留 provider 排名、snippet、cursor 和错误；snippet 是索引文本摘录，不是完整原事件或活动摘要。

首版不为每个命中回读日志来补活动 ID、Step（助手响应及工具执行阶段）或根调用 ID。先搜索定位，再用 Detail 默认读取目标事件或目标调用，显式 `read_scope: "activity"` 才有界展开所属活动，或用 Raw 核验指定事件；需要进一步分析未索引 PTC 内容时，从已知活动、根工具或事件列表工具 `session_event_list`（List）找到 seq，再由调用方通过 Detail/Raw 或另写 PTC 分析代码处理已取得的记录，不自动执行历史代码。

保留当前会话搜索排除执行中 Step 的 seq 上界过滤，并与 surfaces 条件共同传给 provider。续页保持 query、scope、limit、surfaces 一致；provider 代际改变仍可使 cursor 失效。索引禁用、失败或不支持时保留原错误，不重试，也不扫描日志兜底；这延续[项目数据访问约定](<../../AGENTS.md#数据访问契约>)。

## 理由与替代方案

- **扩大索引以覆盖所有可读事件**可以直接检索更多内容，但需要定义新增事件的文本语义、评估噪声及历史重建成本。日常历史理解不需要新增 PTC 全文索引；罕见深挖可用 Raw/PTC 分析已有记录，因此本轮不承担新增 extraction 和历史重建成本。
- **投影继续依赖全文提取文本**实现简单，却无法展示未索引事件中已有的参数、错误与状态。直接原字段投影让阅读覆盖不受搜索覆盖限制。
- **每个搜索命中都展开活动树**减少后续调用，却把一页索引查询变成多次日志读取，并可能仍只能得到部分活动。轻量 seq 入口让调用方只深挖相关命中。

## 后果

session-query 与 SQLite provider 继续负责索引、surface 分类、查询过滤和 cursor；本插件负责 surfaces 参数、轻量命中定位与原字段预览。项目作用域和读取授权保持现有规则，不扩展为全日志文本搜索或外部附件全文读取。

工具说明必须明确哪些内容未索引，避免将 Detail 可见内容写成 Search 可检索内容。Search 使用 provider 给出的索引 surface；List/Detail 默认展示原始工具结果，读取完整性归 [ADR 0002](<0002-local-reading-and-completeness.md>)；不按搜索 surface 标签替换 Raw 目标。新增其它事件索引和跨会话搜索策略不属于本决策。

## 验证要点

- 已有文档和提取规则保持不变；PTC 的参数、错误和结果能预览，但不产生新增全文命中。
- 各 surface 单选与多选在 provider 查询阶段过滤，空数组拒绝；省略时验证默认覆盖三个面中已有的全部索引文档。
- `read_seq` 可用于 Detail 和 Raw；Search 不为每个命中读取活动树，snippet 不冒充完整原文。
- 执行中 Step 的上界、续页条件和 provider 原错误保留；索引不可用不触发日志扫描。
