# dsh-session-tools

Independent DSH 0.1.7-rc.2 Cordis consumer for indexed session search and exact session browsing. This package does **not** contribute a bundle or replace a provider. It reads sessions through `ctx.sessionQuery`, optionally reads zero-I/O title hints from `ctx.sessionProjectionCache`, and obtains the current-step boundary from `ctx.sessionProjections`; it never opens or decompresses session files. Built-in `session_search`, `session_event_search`, `session_event_read`, `session_trace`, and `session_event_trace` may already be registered by a profile: disable the built-in consumer before enabling these replacements. The seven tools here replace the old `agent_session_search`, `agent_session_list`, and `agent_session_read` entries from `dsh-session-search-pro`; do not register both consumer sets simultaneously.

The plugin requires `workspaceRegistry` from `@deepseek-ai/dsh-workspace` alongside its query, projection, and tool services; Cordis waits for these services before registering the tools.

## Scope and search

Each tool defaults to `scope: "project"`: the exact `exec.agent.session.header.cwd`, never the Host's cwd. Without a caller cwd, project scope fails; `scope: "all"` must be explicit and covers the **current sessionQuery provider's one DSH_HOME**, not multiple homes. The target is checked before cross-session reading; session search supplies the cwd filter **before** the provider query, not by trimming results afterward. Project traces hide out-of-project ancestor and descendant identities, and omit parent IDs in summary records. `all` enables cross-project reads/traces.

Both searches use **only** `searchSessions` and `searchEvents` and return indexed provider cursors; no scan fallback, `maxScan`, or `filterEvents` text search exists. FTS token semantics are not arbitrary substrings. A disabled, unsupported, or failed index raises the provider's original error category plus a message that **no logs were scanned**: report it to the user, do not scan logs as a workaround. Neither tool retries a failed provider request. `session_search` excludes its own session by default (`include_current: true` opts in). It also excludes archived sessions by default; set `include_archived: true` only when archived work is specifically needed. Each cross-session search item includes an `archived` boolean from the current Workspace registry. This is a discovery filter, not an access restriction: listing, exact reads, event search, and traces keep their existing behavior. `session_event_search` on its own session excludes the executing `step/start` and later events. Search results expose `items`, `has_more`, `next_cursor` (opaque or null). `snippet` is always an excerpt, not the full event text; `snippet_truncated` only indicates additional shortening of the provider's excerpt by this plugin. Each tool calls its indexed provider exactly once per request, passing the validated `limit` (default 30, maximum `maxPageSize: 100`). The tool filters one provider page without refilling it; excluding the current or archived sessions may yield a short or empty page with `has_more: true` and its original `next_cursor`. Continue with that cursor rather than expecting the tool to refill the page. The token is a provider cursor, not a result count. Keep query, scope, limit, include_current, and include_archived unchanged across requests; provider generations can invalidate a cursor after live session updates. For current-session event search, the provider binds the seq ceiling to the cursor: crossing an active step may reject a stale cursor rather than silently search the new step.

`session_event_search` accepts optional `surfaces: ["current", "shadowed", "log-only"]`. Omission searches existing indexed documents across all three surfaces; an explicit nonempty array selects surfaces with OR semantics. `current` identifies events still in the folded message surface, `shadowed` identifies messages covered by replacements, and `log-only` identifies other log events such as ordinary tool calls and todos. The provider applies this metadata filter before ranking and pagination, ANDed with the current-session seq ceiling. Keep query, scope, limit and surfaces unchanged on continuation. Hits retain provider order and return `seq`, `type`, `time`, `surface`, `snippet`, `snippet_truncated`, and `read_seq` equal to `seq`. Pass `read_seq` to `session_event_read` for Detail or Raw; search does not read activities for each hit.

Search covers the existing extractor rules: user/assistant messages, ordinary tool calls/results, todos, and some turn-end outcomes; empty extracted text produces no document. PTC dispatch records and their child-tool errors have no independent FTS documents. Detail previews can expose fields that are not indexed, including result error reason/meta. No match does not mean no record: use List or known event/call locators, then Detail or Raw to investigate. Snippets are index excerpts, not complete events or activity summaries.

`session_list` and `session_search` return compact `session_id` and display-hint `title` (`cwd` only under `all`); listing returns `items`, `has_more`, `next_cursor`. Cold results may use the optional `sessionProjectionCache` service's lifecycle/version-checked current or predecessor title checkpoint without log reads or durable writes. Only cache-backed titles include `title_cached: true`; these hints can lag the latest rename. Explicit cached null is a hit displayed as `(untitled)`, not a reason to read the log. Without the service or a usable title, only unresolved IDs use the existing batched `readTitleSnapshots`; those results omit `title_cached`. Live records or cheaply available live Sessions also use that exact query read rather than stale checkpoints. Cache read failures propagate, not silently fall back. Headers, IDs, cwd, snippets, and authorization still come from query records/search hits, never the cache; the complete QueryEngine title API is unchanged.

## 事件读取

`session_event_list` 默认 Compact，返回 `activities`、`captured_through_seq`、`has_more` 与 `next_after_seq`；显式 `view: "metadata"` 返回 `items` 中的精确 seq/type。省略 `after_seq` 从 0 开始，EOF 是空页、false 与 null。`limit` 计数本页原始事件，不计合并后的活动数。`event_types` 只筛选分页锚点，不过滤解释锚点时补读的调用、结果、阶段边界等类型。仅确认 cut 内还有匹配事件时才返回最后页内 seq 作为 `next_after_seq`；补读不推进 cursor，同一活动可以跨页重复。

活动包含 `activity_id`、`records`、`tools`、`source_seqs` 和 `page_source_seqs`。`source_seqs` 列出实际使用的证据，`page_source_seqs` 仅列本页消费的原事件。`complete` 按请求范围及覆盖证据判断，`incomplete_reasons` 描述未读齐的关系；`truncated` 独立表示展示裁剪。已知错误存在、错误 seq 和调用身份不因省略正文而丢失。未观察到结果不能解释为仍在运行或日志中不存在。

`session_event_read` 默认 `view: "detail", read_scope: "target"`，返回目标记录或该次工具调用自己的参数与结果，以及已取得的可靠 `activity_locator`。它不展开父、兄弟、子调用；显式 `read_scope: "activity"` 才有界展开所属活动。`view: "compact"` 只改变同一关联结构的展示密度，不扩大读取范围。原字段预览不依赖搜索 text，PTC 的子错误可读但未必可搜索。工具默认展示原 append 执行结果；单目标 replacement 沿明确引用有界读取原结果，摘要 checkpoint 不冒充工具结果。

List 和 Read 的一次主读与补读都持有同一个 `SessionObservation`，使用 `projectionMode: "none"` 和固定 cut，finally 释放 lease。响应的 `captured_through_seq` 是本次可见末尾；查询期间追加的记录留到后续请求。读取只借用有界 `readEvents` 批次，不访问 `.events` 全量物化。稀疏类型筛选可以扫描多个事件引用批次以确认 continuation，批间让出执行；取消与 timeout 明确失败，不能返回假 EOF。历史冷会话首次准备仍可能由 provider 读取完整日志，本插件的补读界限不能保证该底层准备成本很低。

### Raw 与 Unicode 续读

精确原事件必须显式 `view: "raw"`，Raw 精确返回 requested `seq`，包括 replacement 本身；`raw + read_scope: "activity"` 拒绝。`offset_chars` 仅 Raw 可用。小事件返回 `{format:"event-json",event,has_more:false,next_offset:null}`；大事件返回 `{format:"json-unicode-code-points",json_fragment,offset_chars,total_chars,has_more,next_offset}`。offset 按 Unicode code points，不是 bytes 或 UTF-16 code units；按 `next_offset` 继续、依次拼接片段，再 `JSON.parse`。单片不保证可解析。任何视图都不补读 spill、附件二进制或子会话正文。

Raw 缓存仅保存同 provider/session/原 seq 的已准备 code points 与 captured cut，不持有 lease。首次读取或 `offset_chars: 0` 刷新；续片复用 snapshot，每次重新检查当前目标授权和 snapshot header。LRU 受 entries 与估算 bytes 双限额控制，任一为 0 禁用；单个超容量事件不保留，淘汰后续片重新准备。dispose/HMR 清空缓存，进行中的旧调用不得重新填充。

### 配置与预算

所有预算通过插件 `Config` 配置，不需要改源码。以下是可运行的初始工作值，**尚未用本机历史校准**；ADR 0001/0002 功能验收后另行通过公开 query 抽样评估，此处不访问真实历史。

| 字段 | 初始值 | 控制内容 |
|---|---:|---|
| `pageSize / maxPageSize` | 30 / 100 | 原事件页大小；pageSize 不超过 maxPageSize |
| `previewChars` | 240 | 搜索 snippet 与标题预览 |
| `outputBytes` | 24576 | 最终整页包装 JSON UTF-8 bytes，最少 1024 |
| `searchTimeoutMs` | 30000 | 搜索工具 timeout 元数据，沿用既有执行管线 |
| `readTimeoutMs` | 30000 | List/Read 执行内与 caller signal 组合的实际 deadline |
| `readBatchSize` | 128 | metadata/事件引用扫描批次；批间可取消 |
| `readSupplementalEvents` | 1024 | 主锚点之外保留的补读事件数量 |
| `readProcessingBytes` | 8388608 | 保留证据的保守处理 bytes 估算，访问受限后才构造展示 |
| `readSeqSpan` | 4096 | 每个锚点附近与明确引用的最大 seq 距离 |
| `projectionStringChars` | 2000 | 每个展示字符串的 Unicode code-point 上界 |
| `projectionItems` | 32 | 展示集合与助手调用块访问上界 |
| `projectionDepth / projectionNodes` | 8 / 512 | 展示字段、工具树深度与节点访问上界 |
| `eventReadCacheEntries / eventReadCacheBytes` | 8 / 67108864 | Raw 已准备片段缓存条数/估算内存 bytes |

补读超数量、处理或跨度预算时保留不完整证据，不据此声称 EOF；主锚点不能进入处理预算则明确失败，调用方可缩小页或显式 Raw。完整阶段要求真实首尾与中间每条原记录均已取得，并补齐必要明确引用。整页预算包含 wrapper、pagination、身份、错误和所有活动；预览可省略并标记 truncated，但最小完整页仍不 fit 就报错，不返回部分页或跳记录 cursor。List 可降低 limit 后从相同 after_seq 重试；索引搜索或 session list 降低 limit 后应不带旧 cursor 重启。

## 分页快照与追踪

本包要求提供公开 `pageSessions`、`pageEvents`、`observeSession` 的 `@deepseek-ai/dsh-session-query 0.1.7-rc.2-fork2` 或兼容 engine；缺失时加载明确失败。其他 DSH peers 保持 0.1.7-rc.2。`session_list` 使用不可变 metadata snapshot cursor，续页保持 scope/limit；新 session 不漂移页。snapshot 内标题来源删除时保留 NOT_FOUND 并提示不带 cursor 重启，不以默认标题掩盖失败。provider 重载、snapshot 超时或淘汰使 cursor 失效。

两个 trace 工具返回公开服务提供的完整关系，预算不足报错，不截断 links。`session_trace` 在首个隐藏父节点停止 ancestry，并以 scope_limited 标记隐藏关系；先过滤可见节点再对去重后的标题使用与 List/Search 相同的 helper。cache hint 保留 title_cached:true。

## 内部历史关联与投影模型

[src/event-association.ts](src/event-association.ts) 的 `associateEvents(events, budget)` 接受同一次读取已取得的逻辑事件及现有预算，返回共享的 `activities`、`activityBySeq`、`toolBySeq` 与 `tools`。关联时以 `maxItems`／`maxNodes` 限制助手调用块的实际访问，并保存已发现块的直接参数证据；Compact 和 Detail 复用同一关联结果和关联预算。被略过的调用块以 `limitedBlockSeqs` 及活动的 `tool_blocks_not_fully_associated` 缺口保留，不能据此声称整个活动已读齐。同一显式 turn/step 的助手和工具组成 Step，callId 去重配对，执行记录拥有参数证据；PTC 使用 subCallId 和直接 parentCallId，沿已核实根调用继承 Step。找不到根或直接父链的片段独立保留，缺少结算只表示未观察到结果。压缩、重试、workflow、命令及审批使用各自真实身份，workflow 的成员 seq 不作为 Session seq。

[src/event-projection.ts](src/event-projection.ts) 提供 `projectActivity(model, activity, options)` 和 `projectTarget(model, seq, options)`。target 只展示目标记录或自身工具配对，返回已知 activity/root/parent locator；目标配对和必要引用齐全时，未请求的根、父、兄弟或子调用不算缺失或展示截断。activity 才展示工具树。普通工具展示真实 `surfaceOp: "append"` 的原结果；只有 tool/result replacement 的明确单节点 startSeq/endSeq 引用可在 `maxDepth`／`maxNodes` 内递归定位同一调用的 append 结果。source 集合允许包含额外诊断，不等于被覆盖的节点数。单目标 replacement 的独立活动锚点与 target 复用原结果定位，保留 replacement 自身入口及活动身份，只展示该调用、不扩展其整个 Step。summary/checkpoint 保留独立语义；目标记录和已定位引用保留 seq/read_seq、surface metadata、实际来源与原结果 locator，不重复展开工具节点已展示的参数和结果。本模块不提供 Raw 或改变 Raw 的 requested seq。

`options.view` 为 compact/detail。相同预算下，Compact 保留首个可见消息块和首个工具结果块、省略工具参数及错误正文；Detail 展示有界多块内容、参数、错误和 meta。两者保留角色、消息／调用身份、来源类别、工具增删事实及各层错误存在、code 和 seq；Compact 的内容省略标记 `truncated`，不会改变已核实的配对和身份。Reasoning 和嵌入 stream 不作为普通消息正文展开。

调用方显式提供 `options.budget`：`maxStringChars`（Unicode code points）、`maxItems`、`maxDepth`、`maxNodes` 和最终 JSON UTF-8 `outputBytes`。消息和 developer 工具增删块的实际访问受 maxItems／maxNodes 限制；工具树受每层 maxItems、总 maxNodes 和 maxDepth 限制，达到上限后不访问剩余节点。预览先有界访问原字段，再序列化有限结果；字段名超限的预览字段省略。最终预算不足时继续省略预览，保留身份、seq、已发现错误及其 Raw 入口；树节点省略后，记录证据仍保留已发现的错误，关联阶段已知配对缺口仍影响完整性。最小元数据仍超限则抛错。reader 仍负责约束传入的事件数、读取字节和跨度；这里没有已校准默认值，限额需完整 reader 功能完成后用本机历史校准。

reader 可传入 `options.evidence.pageSourceSeqs`、`coverageComplete`、`incompleteReasons`：页内来源不会因补读而增加，Activity 未有读取覆盖证据时保持 incomplete，目标工具缺调用/结果或明确原结果引用时附缺口。`complete` 和正文裁剪的 `truncated` 独立。`coverageComplete` 必须由 reader 的固定 observation 和实际覆盖证明，不能仅因看到首尾边界或一个完整工具对就设为 true。返回值不持有 observation 或执行 I/O，现有公共工具接口在本节之外定义。

### 内部有界证据读取

[src/bounded-reader.ts](src/bounded-reader.ts) 的 `BoundedReader` 借用调用方拥有的单个 `SessionObservation`，只经 `readEvents` 扫描固定 cut，不访问 `.events`。`page` 用原事件数选择锚点并确认是否还有匹配类型；`completeTarget` 只补目标工具对，`completeActivities` 有界读取页内活动附近记录及明确引用。补读数量、处理 bytes、seq 跨度和扫描 batch 分别由 `ReaderBudget` 控制，限额耗尽保留缺口，取消明确报错。活动完整性需要真实生命周期首尾与中间每条记录均已取得，并检查明确引用；只有工具配对或首尾边界不能证明 Step 完整。

`commitReadingPage` 对最终整页包装 JSON 执行 UTF-8 `outputBytes`，预算不足时省略已有限预览，保留身份、关系、已知错误、分页锚点；最小完整元数据仍放不下则报错，不提交部分页或 cursor。读取预算的工作值尚待功能完成后的独立本机历史校准。

## Build and handoff

Use Node 22.19+ or 24+ and pnpm. Prepare the pinned query/SQLite dependencies with `pnpm install --frozen-lockfile`, then run `pnpm --config.verify-deps-before-run=false check`. The tarball contains built ESM, declarations, README and MIT license. This ordinary plugin has no bundle patch; consumers declare its row explicitly. Its Cordis/DSH service peers use the Host instances through the public profile resolver; Schemastery must match the Host version and pass Host Config validation.

`tests/pack-smoke.mjs` checks packaging with explicitly installed peers; `deploy/activate.test.mjs` exercises Host-provided peers without direct profile dependencies. Personal installation and artifact-test procedures are maintained in [dsh-config](../dsh-config/README.md).

The repository Release workflow builds, tests, packs and publishes versioned assets from `v*` tags without overwriting existing Releases.

## Provenance

Inspired by [LeslieWylie/dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) at pinned commit `82787487d75f6af3d0e1b219a19dec49b93213cb`; its MIT copyright and license notice remain in [LICENSE](./LICENSE). This implementation changes semantics intentionally: indexed-only search, project scope, native objects, pagination and full raw-event continuation.
