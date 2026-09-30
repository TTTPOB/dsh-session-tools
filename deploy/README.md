# dsh-session-tools：用户自行安装与配置切换

**先拿到已验证的插件 tarball 绝对路径，不要在安装前启用全局插件行。** 本入口默认只处理当前已迁移的 `web` profile；全局 Cordis patch 仍共享，并非 Web 特化。按既有 [共享迁移规范](../../docs/dsh-fork-install.md#其他消费-profile)，尚未迁移共用依赖的 headless、paper-chew 当前不可宣称可用；日后确需消费全局插件时，先按既有流程迁移共用依赖，再安装新插件并显式纳入预检。脚本不自动修复旧 profile。

## 1. 用户在外部终端安装

先停下受影响 Host，并私下备份 `$DSH_HOME/cordis.patch.yml` 和 Web profile 的 package.json、patch、lockfile；不要打印配置内容。设置交付的真实 tarball 路径：

```sh
DSH_HOME=/home/tpob/.dsh
TARBALL=/absolute/path/to/dsh-session-tools.tgz
pnpm --dir "$DSH_HOME/profiles/web" add --ignore-workspace --config.auto-install-peers=false --config.enable-global-virtual-store=false "file:$TARBALL"
```

要部署已迁移的其他消费 profile，分别执行相同 pnpm 命令，换成其 profile 目录；安装通过 pnpm 管理依赖和 lockfile，不用全局 overrides 安装独立插件，不手改 lockfile，不自动安装 peers。**不要删除 tarball**：`file:` 依赖仍引用它。

## 2. 用户运行预检与切换

第三个参数必须是当前已安装 Host 包的真实 `package.json` **绝对路径**，先确认其存在并对应当前 Host；下面路径仅为本机检查时观察到的示例，不保证未来全局安装版本或目录仍相同。

```sh
HOST_MANIFEST=/home/tpob/.local/share/pnpm/global/v11/304e3f-1a0f1838a1e-4a7ea5c36f67531c/node_modules/@deepseek-ai/dsh/package.json
node /home/tpob/playground/dsh/artifacts/session-tools-deployment/activate.mjs "$DSH_HOME" "$TARBALL" "$HOST_MANIFEST"
```

可选第四参数是已迁移且已安装新插件的消费 profile 名称列表，默认 `web`；如 `web,headless`。必须包含 Web，因为脚本会从 Web bundle 删除旧插件。它只检查**指定** profile 显式共用依赖、插件的构建入口实际导入、peer 实际解析及与 Host 的共享 Cordis／Schemastery 身份；没有通过就不切换。预检通过后，脚本把本次相关现有配置及 lockfile 私密备份至所报告目录，在**全局** patch 加入新插件，并从 Web bundles 删除旧第三方 bundle；旧依赖暂留，留给 pnpm 管理。脚本不重启 Host、不改 SQLite／persistence provider、索引或优化。

在隔离 `DSH_HOME` 副本中用 `dsh --profile web --dump-config` 检查新行、旧 bundle、官方同名工具及 SQLite 配置；不要展示包含凭据的完整 dump。用户确认后自行按原方式重启 Host。

## 3. 重启验证后的收尾与回滚

验证新七个工具和原索引组合后，用户在外部终端用 pnpm 卸载 Web 旧依赖（**先确认旧 bundle 已移除**）：

```sh
pnpm --dir "$DSH_HOME/profiles/web" remove --ignore-workspace --config.auto-install-peers=false --config.enable-global-virtual-store=false dsh-session-search-pro
```

确认稳定且不需要回滚后，只能由用户指定并确认**本次脚本打印的具体备份目录**再删除；不能清空整个 backups 目录。不要删除 `session-search.db`、对应 WAL/SHM、sessions/storages，也不能删除仍被 `file:` 引用的新 tarball。

需要回滚则先停止受影响 Host，从本次私有备份恢复原全局 patch 与 Web manifest/patch，再通过 pnpm 恢复旧依赖组合，不手工编辑 lockfile。若中途写盘失败且部分配置已切换，先从备份恢复两个变更文件，之后再启动 Host。
