# dsh-session-tools

Independent DSH 0.2.2-rc.5 Cordis consumer for indexed session search and exact session browsing. This package does **not** contribute a bundle or replace a provider. It reads sessions through `ctx.sessionQuery`, optionally reads zero-I/O title hints from `ctx.sessionProjectionCache`, and obtains the current-step boundary from `ctx.agents.turnBoundaryOf`; it never opens or decompresses session files. Built-in `session_search`, `session_event_search`, `session_event_read`, `session_trace`, and `session_event_trace` may already be registered by a profile: disable the entire `@deepseek-ai/dsh-tool-session-query` consumer before enabling these replacements. Its five upstream tools have no pagination and must not be registered alongside this plugin. The tools here replace the old `agent_session_search`, `agent_session_list`, and `agent_session_read` entries from `dsh-session-search-pro`; do not register both consumer sets simultaneously.

The plugin requires `workspaceRegistry` from `@deepseek-ai/dsh-workspace` alongside its query, agent registry, and tool services; Cordis waits for these services before registering the tools.

## Scope and search

Each tool defaults to `scope: "project"`: the exact `exec.agent.session.header.cwd`, never the Host's cwd. Without a caller cwd, project scope fails; `scope: "all"` must be explicit and covers the **current sessionQuery provider's one DSH_HOME**, not multiple homes. The target is checked before cross-session reading; session search supplies the cwd filter **before** the provider query, not by trimming results afterward. Project traces hide out-of-project ancestor and descendant identities, and omit parent IDs in summary records. `all` enables cross-project reads/traces.

Both searches use **only** `searchSessions` and `searchEvents`. FTS matches tokens, not arbitrary substrings. Neither search retries a failed provider request or scans logs as a fallback. Index failures preserve the provider's error category and state that no logs were scanned; report them to the user. `SESSION_QUERY_INDEX_WARMING` asks the caller to retry later.

`session_search` excludes its own session by default (`include_current: true` opts in). It also excludes archived sessions by default; set `include_archived: true` only when archived work is specifically needed. Each item includes the Workspace registry's `archived` flag; this discovery filter does not limit exact access.

Search results expose `items`, `has_more`, and `next_cursor` (opaque or null). `snippet` is an excerpt; `snippet_truncated` marks additional shortening by this plugin. Each search page queries the index at most once and does not refill filtered results: `session_search` can return an empty `items` with `has_more: true`. Continue using `next_cursor`, keeping the request parameters unchanged. The provider may still invalidate a cursor when its index changes.

When you search your own session with `session_event_search`, every page excludes the step executing the first request and all later events. Use `next_cursor` unchanged even after a new step starts. To search through a newer step boundary, start a new search without a cursor.

`session_event_search` accepts optional `surfaces: ["current", "shadowed", "log-only"]`. Omission searches existing indexed documents across all three surfaces; an explicit nonempty array selects surfaces with OR semantics. `current` identifies events still in the folded message surface, `shadowed` identifies messages covered by replacements, and `log-only` identifies other log events such as ordinary tool calls and todos. The provider applies this metadata filter before ranking and pagination, ANDed with the current-session seq ceiling. Keep query, scope, limit and surfaces unchanged on continuation. Hits retain provider order and return `seq`, `type`, `time`, `surface`, `snippet`, `snippet_truncated`, and `read_seq` equal to `seq`. Pass `read_seq` to `session_event_read` for Detail or Raw; search does not read activities for each hit.

Search covers the existing extractor rules: user/assistant messages, ordinary tool calls/results, todos, and some turn-end outcomes; empty extracted text produces no document. PTC dispatch records and their child-tool errors have no independent FTS documents. Detail previews can expose fields that are not indexed, including result error reason/meta. No match does not mean no record: use List or known event/call locators, then Detail or Raw to investigate. Snippets are index excerpts, not complete events or activity summaries.

`session_list` and `session_search` return compact `session_id` and display-hint `title` (`cwd` only under `all`); listing returns `items`, `has_more`, `next_cursor`. Cold results may use the optional `sessionProjectionCache` service's lifecycle/version-checked current or predecessor title checkpoint without log reads or durable writes. Only cache-backed titles include `title_cached: true`; these hints can lag the latest rename. Explicit cached null is a hit displayed as `(untitled)`, not a reason to read the log. Without the service or a usable title, only unresolved IDs use the existing batched `readTitleSnapshots`; those results omit `title_cached`. Live records or cheaply available live Sessions also use that exact query read rather than stale checkpoints. Cache read failures propagate, not silently fall back. Headers, IDs, cwd, snippets, and authorization still come from query records/search hits, never the cache; the complete QueryEngine title API is unchanged.

## 事件读取

`session_event_list` 在两种视图都返回 `items`，并回显 `view`：默认 `compact` 展示活动投影；`metadata` 展示精确的 `{seq, type}`。省略 `after_seq` 从 0 开始；`has_more: false` 与 `next_after_seq: null` 表示没有下一页。`limit` 计数本页选取的原始事件，不计活动；大于 `maxPageSize` 的正安全整数按上限执行，并返回 `requested_limit`、`effective_limit` 和 `notices`。其它工具拒绝超过 `maxPageSize` 的 `limit`。

`event_types` 只筛选分页锚点，不限制补读的类型。`has_more: true` 时，把 `next_after_seq` 用作下一页的 `after_seq`。它指向最后交付的锚点；补读不推进翻页，同一活动可以跨页重复。

活动包含 `activity_id`、`records`、`tools`、`source_seqs` 和 `page_source_seqs`。`source_seqs` 列出实际使用的证据，`page_source_seqs` 仅列本页消费的原事件。`complete` 按请求范围及覆盖证据判断，`incomplete_reasons` 描述未读齐的关系；`truncated` 独立表示展示裁剪。已知错误存在、错误 seq 和调用身份不因省略正文而丢失。未观察到结果不能解释为仍在运行或日志中不存在。

`session_event_read` 默认 `view: "detail", read_scope: "target"`，返回目标记录或该次工具调用自己的参数与结果，以及已取得的可靠 `activity_locator`。它不展开父、兄弟、子调用；显式 `read_scope: "activity"` 才有界展开所属活动。`view: "compact"` 只改变同一关联结构的展示密度，不扩大读取范围。原字段预览不依赖搜索 text，PTC 的子错误可读但未必可搜索。工具默认展示原 append 执行结果；单目标 replacement 沿明确引用有界读取原结果，摘要 checkpoint 不冒充工具结果。

List 和 Read 的一次主读与补读都持有同一个 `SessionObservation`，使用 `projectionMode: "none"` 和固定 cut，finally 释放 lease。响应的 `captured_through_seq` 是本次可见末尾；查询期间追加的记录留到后续请求。读取只借用有界 `readEvents` 批次，不访问 `.events` 全量物化。稀疏类型筛选可以扫描多个事件引用批次以确认 continuation，批间让出执行；取消与 timeout 明确失败，不能返回假 EOF。历史冷会话首次准备仍可能由 provider 读取完整日志，本插件的补读界限不能保证该底层准备成本很低。

### Raw 与 Unicode 续读

精确原事件必须显式 `view: "raw"`，Raw 精确返回 requested `seq`，包括 replacement 本身；`raw + read_scope: "activity"` 拒绝。`offset_chars` 仅 Raw 可用。小事件返回 `{format:"event-json",event,has_more:false,next_offset:null}`；大事件返回 `{format:"json-unicode-code-points",json_fragment,offset_chars,total_chars,has_more,next_offset}`。offset 按 Unicode code points，不是 bytes 或 UTF-16 code units；按 `next_offset` 继续、依次拼接片段，再 `JSON.parse`。单片不保证可解析。任何视图都不补读 spill、附件二进制或子会话正文。

Raw 缓存仅保存同 provider/session/原 seq 的已准备 code points 与 captured cut，不持有 lease。首次读取或 `offset_chars: 0` 刷新；续片复用 snapshot，每次重新检查当前目标授权和 snapshot header。LRU 受 entries 与估算 bytes 双限额控制，任一为 0 禁用；单个超容量事件不保留，淘汰后续片重新准备。dispose/HMR 清空缓存，进行中的旧调用不得重新填充。

### 配置与预算

所有预算通过插件 `Config` 配置，不需要改源码。TypeScript 消费方从包根导入 `Config` schema 和类型：`const config: Config = Config({})` 或 `Config({ pageSize: 10 })` 均返回包含全部数值字段的完整配置。`ConfigInput` 的字段可省略或为 `null`，由 schema 补默认值；指定的非空字段必须为数值。Cordis 加载插件时使用同一个 schema 校验配置，`apply` 接收完整的 `Config`。默认值如下：

| 字段 | 默认值 | 控制内容 |
|---|---:|---|
| `pageSize / maxPageSize` | 30 / 100 | 原事件页大小；pageSize 不超过 maxPageSize |
| `previewChars` | 240 | 搜索 snippet、标题预览与 compact 事件预览中每个字符串的 Unicode code-point 上限 |
| `outputBytes` | 24576 | 最终整页包装 JSON UTF-8 bytes，最少 1024 |
| `searchTimeoutMs` | 30000 | 搜索工具 timeout 元数据，沿用既有执行管线 |
| `readTimeoutMs` | 30000 | List/Read 执行内与 caller signal 组合的实际 deadline |
| `readBatchSize` | 128 | metadata/事件引用扫描批次；批间可取消 |
| `readSupplementalEvents` | 1024 | 主锚点之外保留的补读事件数量 |
| `readProcessingBytes` | 8388608 | 保留证据的保守处理 bytes 估算，访问受限后才构造展示 |
| `readSeqSpan` | 4096 | 每个锚点附近与明确引用的最大 seq 距离 |
| `projectionStringChars` | 2000 | detail 事件预览中每个字符串的 Unicode code-point 上限 |
| `projectionItems` | 32 | 展示集合与助手调用块访问上界 |
| `projectionDepth / projectionNodes` | 8 / 512 | 展示字段、工具树深度与节点访问上界 |
| `eventReadCacheEntries / eventReadCacheBytes` | 8 / 67108864 | Raw 已准备片段缓存条数/估算内存 bytes |

补读超数量、处理或跨度预算时保留不完整证据，不据此声称 EOF；主锚点不能进入处理预算则明确失败，调用方可缩小页或显式 Raw。完整阶段要求真实首尾与中间每条原记录均已取得，并补齐必要的明确引用。

整页输出预算 `outputBytes` 按包装后的 JSON UTF-8 字节数计算。事件列表优先缩短锚点前缀以保留预览；缩页返回 `page_truncated: { reason: "output_bytes", delivered, selected }` 和 `notices`，即使原本是最后一页，也用 `has_more: true` 和最后交付的 `next_after_seq` 继续。若单锚点仍超限，才从整页省略可选预览字段；仍放不下时，用 `view: "metadata"` 找到 seq，再用 `session_event_read` 读取该事件。索引搜索或 `session_list` 超预算仍报错，降低 `limit` 后不带旧 cursor 重启。

## 分页快照与追踪

本包的 Session core 与 Query peers 分别要求 `@deepseek-ai/dsh-session 0.2.2-rc.5`、`@deepseek-ai/dsh-session-query 0.2.2-rc.5`。Query fork 依赖同基线 Session 的 `SurfaceFoldAccumulator`；仅官方 Query 缺少所需扩展，不声明未验证版本的兼容范围。运行时要求公开 `pageSessions`、`pageEvents`、`observeSession`、`captureSession`，缺失时加载明确失败。其他 DSH peers 固定为 0.2.2-rc.5，Cordis 为 4.1.0，Schemastery 为 3.19.0。`session_list` 使用不可变 metadata snapshot cursor，续页保持 scope/limit；新 session 不漂移页。snapshot 内标题来源删除时保留 NOT_FOUND 并提示不带 cursor 重启，不以默认标题掩盖失败。provider 重载、snapshot 超时或淘汰使 cursor 失效。

两个 trace 工具返回公开服务提供的完整关系，预算不足报错，不截断 links。`session_trace` 在首个隐藏父节点停止 ancestry，并以 scope_limited 标记隐藏关系；先过滤可见节点再对去重后的标题使用与 List/Search 相同的 helper。cache hint 保留 title_cached:true。

## 内部历史关联与投影模型

[src/event-association.ts](src/event-association.ts) 的 `associateEvents(events, budget)` 接受同一次读取已取得的逻辑事件及现有预算，返回共享的 `activities`、`activityBySeq`、`toolBySeq` 与 `tools`。关联时以 `maxItems`／`maxNodes` 限制助手调用块的实际访问，并保存已发现块的直接参数证据；Compact 和 Detail 复用同一关联结果和关联预算。被略过的调用块以 `limitedBlockSeqs` 及活动的 `tool_blocks_not_fully_associated` 缺口保留，不能据此声称整个活动已读齐。同一显式 turn/step 的助手和工具组成 Step，callId 去重配对，执行记录拥有参数证据；PTC 使用 subCallId 和直接 parentCallId，沿已核实根调用继承 Step。找不到根或直接父链的片段独立保留，缺少结算只表示未观察到结果。压缩、重试、workflow、命令及审批使用各自真实身份，workflow 的成员 seq 不作为 Session seq。

[src/event-projection.ts](src/event-projection.ts) 提供 `projectActivity(model, activity, options)` 和 `projectTarget(model, seq, options)`。target 只展示目标记录或自身工具配对，返回已知 activity/root/parent locator；目标配对和必要引用齐全时，未请求的根、父、兄弟或子调用不算缺失或展示截断。activity 才展示工具树。普通工具展示真实 `surfaceOp: "append"` 的原结果；只有 tool/result replacement 的明确单节点 startSeq/endSeq 引用可在 `maxDepth`／`maxNodes` 内递归定位同一调用的 append 结果。source 集合允许包含额外诊断，不等于被覆盖的节点数。单目标 replacement 的独立活动锚点与 target 复用原结果定位，保留 replacement 自身入口及活动身份，只展示该调用、不扩展其整个 Step。summary/checkpoint 保留独立语义；目标记录和已定位引用保留 seq/read_seq、surface metadata、实际来源与原结果 locator，不重复展开工具节点已展示的参数和结果。本模块不提供 Raw 或改变 Raw 的 requested seq。

两种视图共用调用定位格式。工具树顶层 `call_id` 是完整 ID；父节点不在投影中时，顶层节点附已知的 `parent_call_id` 和 `root_call_id`。嵌套节点的父子关系由树表达。子调用 ID 以父调用的完整 ID 开头时，`call_id` 仅写后缀（如 `:ptc:1`）；还原时把父调用的完整 ID 和后缀拼接。没有此前缀的子调用保留完整 ID。记录的调用归属由工具节点的 `source_seqs` 给出；不在已展示工具树中的记录保留规范化的 `call_id` 及不同于它的已知父／根 ID。助手消息仍以 `tool_calls[].call_id` 链接调用。工具节点的 `source_seqs` 可直接用于回读。

Compact 通常保留首个可见消息块、首个工具结果块，省略调用参数和错误正文。以下事件只预览指定字段；省略字段时标记 `truncated: true`，可用 Detail 查看有界的完整字段集：

| 事件 | Compact 预览字段 |
|---|---|
| `request/header` | `reason`、从 `header.config` 提取的 `provider`、`model` |
| `system/message` | `role`、`empty` |
| `session/title-llm-request` | `titleProvider`、`route` |
| `job/registered` | `jobId`、`kind`、`label` |
| `job/settled` | `jobId`、`status`、`cause`、`detail` |

Detail 展示有界多块内容、参数、错误和 `meta`。Developer 的 Detail 按消息引用的 `headerSeq` 在 `request/header` 的工具定义中选出新增工具，放入 `preview.tools`；移除工具只保留变更身份。已核实的 header seq 计入来源集合，`headerSeq` 是 Raw 入口。Reasoning 和嵌入 stream 不作为普通消息正文展开。`working-directory/change` 保留有界原字段；`plugin:` 记录标记为 `plugin-record`，保留事件类型和 Raw 入口。

调用方显式提供 `options.budget`：`maxStringChars`（Detail 每个字符串的 Unicode code points）、`maxPreviewChars`（Compact 对应上限）、`maxItems`、`maxDepth`、`maxNodes` 和最终 JSON UTF-8 `outputBytes`。消息和 developer 工具增删块的实际访问受 `maxItems`／`maxNodes` 限制；工具树受每层 `maxItems`、总 `maxNodes` 和 `maxDepth` 限制。预览先有界访问原字段，再序列化有限结果；字段名超限的预览字段省略。reader 负责约束传入的事件数、读取字节和跨度；默认限额由插件 Config 提供。

单个活动超出 `outputBytes` 时先删可选预览，再从中间向两端逐条略去非必要记录。始终保留本页锚点、有错误事实的记录和活动首尾记录；`source_seqs`、`page_source_seqs` 仍按删减前的全部证据计算。略去记录时返回 `records_omitted` 和 `truncated: true`，不改变 `complete` 的读齐判定。必要元数据仍超限才报错。可用保留的来源序号进一步回读。

reader 可传入 `options.evidence.pageSourceSeqs`、`coverageComplete`、`incompleteReasons`：页内来源不会因补读而增加，Activity 未有读取覆盖证据时保持 incomplete，目标工具缺调用/结果或明确原结果引用时附缺口。`complete` 和正文裁剪的 `truncated` 独立。`coverageComplete` 必须由 reader 的固定 observation 和实际覆盖证明，不能仅因看到首尾边界或一个完整工具对就设为 true。返回值不持有 observation 或执行 I/O，现有公共工具接口在本节之外定义。

### 内部有界证据读取

[src/bounded-reader.ts](src/bounded-reader.ts) 的 `BoundedReader` 借用调用方拥有的单个 `SessionObservation`，只经 `readEvents` 扫描固定 cut，不访问 `.events`。`page` 用原事件数选择锚点并确认是否还有匹配类型；`completeTarget` 只补目标工具对，`completeActivities` 有界读取页内活动附近记录及明确引用。补读数量、处理 bytes、seq 跨度和扫描 batch 分别由 `ReaderBudget` 控制，限额耗尽保留缺口，取消明确报错。活动完整性需要真实生命周期首尾与中间每条记录均已取得，并检查明确引用；只有工具配对或首尾边界不能证明 Step 完整。

列表根据交付的锚点前缀重新投影，再检查最终 JSON 的 UTF-8 字节数。`commitReadingPage` 为单锚点列表或语义读取省略可选字段，保留身份、关系、错误事实和定位信息；仍超预算时报错。默认读取预算不承诺任意跨度完整。

## Development

All DSH manifests pin the official `0.2.2-rc.5` version. Runtime and full build verification additionally require the matching capture/pagination-capable Session/Query fork via pnpm overrides; official npm Query alone is insufficient. The fork extensions are not implemented again here. `.github/release-dependencies.json` and workspace overrides pin the published immutable fork assets; the pnpm-generated lockfile records the same sources. Native execution in a consuming profile requires `@deepseek-ai/dsh-tool-executor-native`; PTC requires its executor and runtime, not `tools.mode`.

Use Node 24.9+ and pnpm. Install the exact Session/Query forks before running `pnpm --config.verify-deps-before-run=false check`. Generate the lockfile with `pnpm --config.verify-deps-before-run=false install --no-frozen-lockfile`; subsequent installs can use `--frozen-lockfile`. For unpublished forks, use local pnpm overrides pointing to their tarballs. `tests/pack-smoke.mjs` accepts absolute `DSH_SESSION_TARBALL` and `DSH_QUERY_TARBALL` paths for isolated consumer verification; without local tarballs it requires verified new fork Release sources. Cordis/DSH service peers use the Host instances through the public profile resolver; Schemastery is a plugin-owned runtime dependency; its Schema objects pass Host Config validation without requiring a shared module instance.

Installation, pinned Release sources and artifact verification are documented in [dsh-config installation](<../dsh-config/docs/install.md>) and [testing](<../dsh-config/docs/testing.md>).

## Provenance

Inspired by [LeslieWylie/dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) at pinned commit `82787487d75f6af3d0e1b219a19dec49b93213cb`; its MIT copyright and license notice remain in [LICENSE](./LICENSE). This implementation changes semantics intentionally: indexed-only search, project scope, native objects, pagination and full raw-event continuation.
