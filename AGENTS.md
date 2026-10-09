# dsh-session-tools 开发约定

独立 Cordis consumer：提供索引化会话检索与精确会话浏览工具。**不贡献 bundle，不替换 provider**；消费方必须显式声明插件行。

## 数据访问契约

- **绝不打开或解压 session 文件。** 只经 `ctx.sessionQuery` 读取，可选 `ctx.sessionProjectionCache`（零 I/O 标题提示）与 `ctx.sessionProjections`（当前 step 边界）。
- 搜索只调用 `searchSessions` 与 `searchEvents`。**没有 scan fallback，没有 `maxScan`，没有文本搜索。**
- 索引被禁用、不支持或失败时，抛出 provider 的原始错误类别，并明确说明**没有扫描任何日志**。向用户报告；**不得以扫日志兜底**。
- 不重试失败的 provider 请求。
- 与内置 consumer 冲突：先禁用 profile 中内置的 `session_search`／`session_event_search`／`session_event_read`／`session_trace`／`session_event_trace`，再启用本包。不要同时注册两套 consumer。

## 作用域与分页

- `scope` 默认 `project`，取精确的 `exec.agent.session.header.cwd`，**绝不用 Host 的 cwd**。无调用方 cwd 时 project scope 失败；`all` 必须显式给出，且只覆盖当前 sessionQuery provider 的一个 DSH_HOME。
- cwd 过滤在 provider 查询**之前**施加，不是查完再裁剪结果。
- 跨请求保持 `query`／`scope`／`limit`／`include_current`／`include_archived` 不变；provider 代际可能使 cursor 失效。
- 工具只过滤 provider 的一页，**不 refill**。排除当前会话或归档会话可能得到短页甚至空页，但 `has_more: true` 且保留原始 `next_cursor`——用该 cursor 继续，不要期待工具补页。
- 大事件分片按 **Unicode code points** 计数，不按字节或 UTF-16 code unit，不拆代理对。单个 `json_fragment` 不保证是合法 JSON：按 `next_offset` 依次读取、按序拼接后再 `JSON.parse`。
- 整页超过 `outputBytes` 时显式报错，不返回部分页或 cursor；调用方应降低 `limit` 后不带 cursor 重新开始。

## 版本与依赖

- 要求提供公开 `pageSessions`／`pageEvents` 的 `@deepseek-ai/dsh-session-query` fork2 或兼容 engine；缺失时在加载阶段明确报错。其他 DSH peers 保持 `0.1.7-rc.2`。
- 同时需要 `workspaceRegistry`（来自 `@deepseek-ai/dsh-workspace`）与 query／projection／tool 服务；Cordis 会等待这些服务可用后再注册工具。
- 大事件分片缓存由插件 effect 拥有；dispose/HMR 清空缓存，进行中的旧调用不得重新填充。

## ADR 状态

采用 Michael Nygard ADR 状态：`Proposed`（提议）、`Accepted`（采纳）、`Deprecated`（弃用）、`Superseded`（被后续决策取代）。`Accepted` 只表示决策已采纳；实施情况单独记录，不以状态推断已实现。各阶段验收后移除对应待确认标签，将确定值写入正文。

## 验证

```sh
pnpm install --frozen-lockfile
pnpm --config.verify-deps-before-run=false check
```

`tests/pack-smoke.mjs` 检查显式安装 peers 的打包结果；`deploy/activate.test.mjs` 检查 profile 无直接依赖的实际布局。

## 溯源

源自 [LeslieWylie/dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) 的固定提交 `82787487d75f6af3d0e1b219a19dec49b93213cb`，其 MIT 版权与许可声明保留在 [LICENSE](LICENSE)。本实现在语义上有意不同：仅索引检索、项目作用域、原生对象、分页与完整原始事件续读。
