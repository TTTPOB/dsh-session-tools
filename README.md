# dsh-session-tools

DSH 的只读会话历史接口。Agent 在 Bash 中读取 Unix socket 上的 NDJSON，再用 `jq` 筛选或统计；插件不注册会话工具。使用随包提供的 [session-stream skill](<skills/session-stream/SKILL.md>)获取八个可直接运行的例子。

## 配置

在已经安装本包的 profile 中显式声明插件行。本包不贡献 bundle，也不替换查询 provider。Host 须提供 `sessionQuery`、`profileContext`、`shellEnv` 和 `skills`；搜索使用支持多会话／全库事件检索的 Session Query 与 SQLite provider。

```yaml
- insert:
    - id: session-tools
      name: dsh-session-tools
      # Optional absolute path:
      # config:
      #   socketPath: /home/me/.dsh/run/custom-session.sock
```

默认地址为 `$DSH_HOME/run/session-stream-<profile>.sock`（目录 `0700`，socket `0600`）。覆盖地址必须是绝对路径；插件会以 `0700` 创建缺失的上级目录，不修改覆盖地址已存在的目录权限。启动时，如果该路径上的 socket 仍有服务在监听，插件拒绝启动；只有无人监听的残留 socket 会被替换。卸载会关闭服务并移除 socket。同一 DSH_HOME 下同时运行同名 profile 时，为每个实例指定不同地址。

**隔离实例不要把 `DSH_HOME` 设在 `/tmp`。** Linux 的 bwrap `workspace-write` 沙箱以 tmpfs 覆盖 `/tmp`，沙箱里的 Bash 看不到 Host 的 socket。Windows 不支持。Web GUI 搜索不经过该接口。

## 接口

在 Agent 的 Bash 中，`DSH_SESSION_STREAM` 指向该 socket。用 `--get --data-urlencode` 传查询参数；会话 ID 从 `/sessions` 或 `/search` 的结果中原样复制：有的以 `session-` 开头，有的是裸 UUID，不要增删前缀。每行一个 JSON 值，内部翻页，不暴露 cursor。默认搜索当前 Host provider 可见的全库。

| GET | 参数 | 响应行 |
| --- | --- | --- |
| `/sessions` | 可选 `cwd`、`limit` | `header`（含 `id`、`cwd` 和可选 `parentSession`）、`title`（字符串或 `null`）及 `live`、`persisted` 等元数据 |
| `/search` | 必须传 `q` 和 `group=session\|event`；可选 `cwd`、`limit`、最多 50 个 `session` | 按 provider 排序的会话命中（含 `header`、`bestMatch`）或事件命中（含 `sessionId`、`session`、`seq`、`type`、`snippet`） |
| `/events` | 1–50 个 `session`；可选 `types`（逗号分隔）、`after_seq`（不含）、`until_seq`（含） | 原始事件加顶层 `session_id`；按会话输入顺序、会话内按 `seq` 排序 |
| `/trace` | 一个 `session` | `target`、`ancestors`、`descendants`、`complete`；完整时含 `root`，否则含 `unresolvedParentId` |

- `cwd` 是会话元数据中的精确绝对目录，不是权限隔离。限制范围时显式传入。查询语法由 provider 解析。索引预热期间，一个 `/search` 请求总共最多等待 120 秒。索引失败时不扫日志补搜索结果。中文、日文、韩文按任意连续片段匹配。索引不收工具调用事件、系统注入的用户消息（指令、skill 目录、运行时上下文等提醒）和超过 10000 字符的工具结果，这些内容用 `/events` 读原文后自行过滤。
- `limit` 为正安全整数，省略时返回全部结果；常见词的命中可能有数万行，`/search` 和 `/sessions` 应带上 `limit`。请求必须使用 GET；未知参数、非重复参数多次出现、目标 ID 不存在均报错。
- `/events` 默认排除 `request/header` 和 `system/message`；显式 `types` 可选中它们。每个会话取一次固定观察点（含尚未持久化的实时事件），不是持续订阅。不做历史消息折叠或事件正文裁剪。

```bash
set -o pipefail
curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" --get http://localhost/sessions \
  --data-urlencode "cwd=$PWD" --data-urlencode limit=10 |
  jq -c '{id: .header.id, title, cwd: .header.cwd}'
```

### 错误

发出首行之前发生错误时，响应为非 2xx 和一行 NDJSON：

```json
{"error":{"code":"SESSION_QUERY_SESSION_NOT_FOUND","message":"Sessions not found: some-id"}}
```

已发出记录后出错时，插件追加相同格式的错误行并中止传输。**出现 `error` 行或命令非零，结果不完整。** Bash 管道使用 `set -o pipefail`，避免 `jq` 的成功退出掩盖 `curl` 的失败。

设计与平台验证见 [ADR 0007](<docs/adr/0007-session-stream.md>)。
