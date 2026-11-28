# ADR 0007：由模型过滤会话数据流

- 状态：Accepted（已采纳）

## 背景

日常使用中积累的数据显示：当工具的整页输出预算为 24 KB，一次请求 100 条事件实际可能只返回约 50 条；单个大事件的 Raw 返回常需分至少三段读取并拼接。一次全库统计通过事件读取工具调用约 2.6 万次，耗时约 25 分钟，同类扫描脚本约 50 秒。模型因此有时直接解压会话文件，但容易输入错误的会话 ID 前缀、只解压 Zstandard 的第一帧，或猜错项目目录。

## 决定

Host 插件提供 Unix socket 上的只读 HTTP 接口。`GET /sessions` 提供会话元数据与标题，`GET /search` 使用 provider 的索引查找会话或事件，`GET /events` 流式返回原事件，`GET /trace` 返回会话父子关系。数据使用 NDJSON，每行一个完整 JSON 值；插件在内部翻页，模型在 Bash 中用 `curl` 与 `jq` 过滤。随插件发布的 [session-stream skill](<../../skills/session-stream/SKILL.md>)提供可直接执行的例子。

删除插件的七个模型工具：`session_list`、`session_search`、`session_trace`、`session_event_list`、`session_event_read`、`session_event_search`、`session_event_trace`，以及它们专用的活动关联、投影、输出预算和 Raw 分段续读代码。

数据仍只通过 `ctx.sessionQuery` 读取，插件不直接打开或解压会话文件。索引预热可在同一个请求内等候，索引被禁用或失败不触发日志扫描。新增的是模型显式发起的原文流：模型可在 Bash 中对已知会话的原文筛选或统计。

### Socket 与范围

默认地址是 `$DSH_HOME/run/session-stream-<profile>.sock`。该目录权限为 `0700`，socket 权限为 `0600`。同用户通过本机文件权限访问，不另设 token。Bash 的 `DSH_SESSION_STREAM` 指向当前 Host 的 socket。`socketPath` 可显式覆盖默认路径。路径上已有 socket 时，插件先尝试连接：仍有服务在监听就拒绝启动，避免误删另一实例的 socket；连接被拒绝时才替换残留文件。

不放在 `/tmp`，因为 Linux workspace-write 沙箱的临时文件系统会遮住 Host 的 socket。也不依赖 `XDG_RUNTIME_DIR`，该变量在 systemd 临时任务或没有登录会话的环境里可能未设置。

默认语料范围是当前 provider 可见的全库，`cwd` 可让列表或搜索缩小到某一项目。Socket 不识别当前 Agent；这是供模型选择的查询范围，不是安全边界。

### 沙箱与平台验证

- **bwrap（Linux 首选后端）：**实测 `read-only`、`workspace-write` 均能用 `curl` 连接工作区外的 socket。`workspace-write` 用 tmpfs 替换 `/tmp`，使 Host 放在其中的 socket 不可见。挂载方式见 [sandbox-local 的 bwrap profile](<https://github.com/TTTPOB/deepseek-harness/blob/32bff99ec5/packages/sandbox/sandbox-local/src/profiles.ts#L16-L22>)。
- **Landlock（无 bwrap 时的后备）：**实测 launcher 报完全生效；`read-only` 和 `workspace-write` 均能用 `curl` 连接工作区外的 socket。授权参数见 [Landlock profile](<https://github.com/TTTPOB/deepseek-harness/blob/32bff99ec5/packages/sandbox/sandbox-local/src/profiles.ts#L30-L35>)。
- **远端服务器家目录：**实测 `~/.dsh` 和家目录测试路径处于同一文件系统；该文件系统可创建 socket、连接并传输数据。
- **审批：**按源码判断，默认 `ask` 策略不会对普通 `curl` 逐条审批。工具流水线只在 guard 返回 `ask` 时请求审批；Bash 只在模型显式申请扩大沙箱权限时另行请求。额外安装的 guard 可能改变结果。见 [Tool 执行流水线](<https://github.com/TTTPOB/deepseek-harness/blob/32bff99ec5/packages/core/tools/src/pipeline.ts#L199-L206>)、[Bash 执行](<https://github.com/TTTPOB/deepseek-harness/blob/32bff99ec5/packages/shell/tool-bash/src/index.ts#L502-L511>)。
- **未验证：**macOS Seatbelt；Windows 见下节。

### Windows

本次不支持 Windows。后续可评估命名管道（`\\.\pipe\…`）或带 token 的回环 TCP。采用命名管道之前，要验证 curl 是否能连接，以及默认 ACL 能否把访问限制在当前用户。

## 否决的方案

- **导出到临时文件：**要清理临时文件，且每次导出只得到快照。
- **用模型工具分页返回原文：**仍需要逐页调用，大事件仍需分段。
- **在 Host 内执行模型的过滤表达式：**慢过滤可能阻塞 Host；过滤留给 Bash 子进程。

## 后果

没有 Bash 的场景不能通过此插件查询会话。Web GUI 继续通过自身的 provider 接口搜索，不受此插件影响。HTTP 已开始交付时无法重新设置状态码；后续失败会写入错误行并中止传输，脚本应同时检查错误行和退出码，不能把部分结果当作完整数据。
