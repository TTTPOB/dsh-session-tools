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

- Session core 与 Query peers/devDependencies 精确固定为 `0.2.1-rc.1-fork1`；其他 DSH 包固定为 `0.2.1-rc.1`。Cordis 为 `4.0.5`，Loader 为 `1.0.6`，Schemastery 为 `3.18.5`。Query 依赖 Session 的 `SurfaceFoldAccumulator`；要求公开 `pageSessions`／`pageEvents`／`observeSession`／`captureSession`，缺失时加载明确报错。未发布 fork 用本地 tarball 验证，不伪造 Release URL；lockfile 只能由 pnpm 生成。
- 同时需要 `workspaceRegistry`（来自 `@deepseek-ai/dsh-workspace`）与 query／projection／tool 服务；Cordis 会等待这些服务可用后再注册工具。
- 大事件分片缓存由插件 effect 拥有；dispose/HMR 清空缓存，进行中的旧调用不得重新填充。

## ADR 状态

采用 Michael Nygard ADR 状态：`Proposed`（提议）、`Accepted`（采纳）、`Deprecated`（弃用）、`Superseded`（被后续决策取代）。`Accepted` 只表示决策已采纳；实施情况单独记录，不以状态推断已实现。各阶段验收后移除对应待确认标签，将确定值写入正文。

## 验证

```sh
pnpm --config.verify-deps-before-run=false install --no-frozen-lockfile
pnpm --config.verify-deps-before-run=false check
```

`tests/pack-smoke.mjs` 检查显式安装 peers 的打包结果；`deploy/activate.test.mjs` 检查 profile 无直接依赖的实际布局。

## 溯源

源自 [LeslieWylie/dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) 的固定提交 `82787487d75f6af3d0e1b219a19dec49b93213cb`，其 MIT 版权与许可声明保留在 [LICENSE](LICENSE)。本实现在语义上有意不同：仅索引检索、项目作用域、原生对象、分页与完整原始事件续读。

## 分支与发布

- 长期发布分支为 `main`，位于 TTTPOB remote `origin`（github.com/TTTPOB/dsh-session-tools）；本地长期分支必须跟踪 `origin/main`，不跟踪第三方上游。
- 开发和测试使用独立分支或 worktree。
- 发布前先合并到长期分支并 push，等待分支 CI（`.github/workflows/ci.yml`）通过。
- 仅从长期分支上的提交，通过 GitHub Actions Release workflow（`.github/workflows/release.yml`）发布；tag 和 Release 资产不可变，不上传本地构建。
- 本机约 13 GB 内存，本地只跑本仓库相关的 scoped 检查；重型全仓检查交给 CI。
