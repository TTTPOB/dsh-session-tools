# dsh-session-tools 开发约定

独立 Cordis consumer：通过 Unix socket 提供会话数据流，并贡献 Bash 用的 `session-stream` skill。不贡献 bundle，不替换 provider，不注册会话工具；消费方显式声明插件行。

## 数据访问与传输

- **绝不直接打开或解压 session 文件。** 只使用 `ctx.sessionQuery`。允许模型显式发起的原文流；索引禁用、不支持或失败时保留 provider 错误，禁止自动扫日志兜底。预热错误可在同一请求内限时等待。
- 搜索只调用 `searchSessions` 与 `searchEvents`。列表和搜索的 `cwd` 在 provider 查询之前施加；默认全库，cwd 不是安全边界。
- `/events` 借用固定观察点，以有界 `readEvents` 批次交付原始事件；不物化全量 live 日志，客户端断开停止读取并释放 observation。
- 每行一个完整 JSON 值；内部翻页。遵守 HTTP 背压；首行前错误为非 2xx 单行 JSON，首行后写错误行并中止。不给模型透出 cursor 或偏移分段协议。
- 默认 socket 在 `$DSH_HOME/run`（目录 `0700`、socket `0600`），不要使用 `/tmp`。插件卸载须清理 socket、`shellEnv` 与 skill 注册。

## 版本、验证与发布

- 保持 Session 和 Query 的 fork 制品与 Host 兼容。未发布 fork 用实际工作树打本地 tarball、在隔离安装中验证；不伪造 Release URL，不把机器本地路径提交进依赖或 lockfile。lockfile 只能由 pnpm 生成。
- 检查用 `NODE_OPTIONS=--max-old-space-size=4096 pnpm --config.verify-deps-before-run=false check`。测试使用临时 socket 与合成数据；`tests/pack-smoke.mjs` 验证显式安装 peers 的 tarball；`deploy/activate.test.mjs` 验证由 Host 提供 peers 的 profile 布局。
- 长期分支为 TTTPOB remote `origin/main`；开发和测试用独立分支或 worktree。仅从长期分支上的提交由 GitHub Actions 发布不可变 Release 资产，不上传本地构建。
- ADR 使用 Nygard 状态；现行协议见 [ADR 0007](<docs/adr/0007-session-stream.md>)。

## 溯源

源自 [LeslieWylie/dsh-session-search-pro](https://github.com/LeslieWylie/dsh-session-search-pro) 的提交 `82787487d75f6af3d0e1b219a19dec49b93213cb`；保留 [MIT 版权与许可声明](<LICENSE>)。
