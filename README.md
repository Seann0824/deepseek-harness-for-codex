# DeepSeek Harness for Codex

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

DeepSeek Harness for Codex 让 Codex 在本地启动 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)，返回可点击的实时 Web 会话链接，将任务委派给它执行，并由 Codex 独立检查真实的工作区变更。

![DeepSeek Harness for Codex 演示](./imgs/examples.gif)

## 快速开始

除非你只需要独立的 MCP 服务，否则推荐安装 Codex 插件。插件会同时安装 MCP 工具和委派工作流，让 Codex 在 Harness 完成任务后独立验收结果。

### 1. 准备环境

- Node.js 22 或更高版本，并包含 `npx`
- 支持插件的 Codex 客户端
- DeepSeek API Key

推荐把 API Key 放在目标仓库根目录中不提交到 Git 的 `.env` 文件里：

```dotenv
DEEPSEEK_API_KEY=your-key
```

不要提交这个文件。你也可以把 `DEEPSEEK_API_KEY` 注入启动 Codex 的环境，或者稍后在 Harness 页面中的 **Settings → Models** 配置。

### 2. 安装插件

在终端中执行以下两条命令：

```sh
codex plugin marketplace add Seann0824/deepseek-harness-for-codex --ref main
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

在 macOS 上，如果找不到 `codex`，或者其他全局安装覆盖了桌面客户端的命令，请直接使用客户端内置的可执行文件：

```sh
CODEX_APP_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
"$CODEX_APP_BIN" plugin marketplace add Seann0824/deepseek-harness-for-codex --ref main
"$CODEX_APP_BIN" plugin add deepseek-harness@deepseek-harness-for-codex
```

### 3. 新建 Codex 任务

插件会在新任务启动时加载。安装完成后新建一个 Codex 任务，并要求它使用 DeepSeek Harness，例如：

> 使用 DeepSeek Harness 在可见的本地会话中实现这个需求。不要自动打开浏览器，把 Harness 实时页面链接发给我；完成后由你检查 diff 并运行相关测试。

Codex 会在本地启动 Harness，在空闲的回环端口提供 Web 页面，返回可点击链接，提交任务并跟踪同一个可见会话，最后独立验收结果。浏览器不会自动打开；需要查看过程时，由你点击 Codex 消息中的链接。你不需要手动启动 Harness，也不需要另外注册 MCP 服务。

首次运行可能会下载固定版本的 MCP 和 Harness npm 包，后续运行会使用本地 npm 缓存。

## 从旧名称迁移

项目已从 `deepseek-harness-mcp` 更名为 `deepseek-harness-for-codex`。如果安装过旧版插件，请先移除旧插件和旧市场，再按照上面的“安装插件”重新安装：

```sh
codex plugin remove deepseek-harness-mcp@deepseek-harness
codex plugin marketplace remove deepseek-harness
```

旧版 npm 包不会自动替换为新包。默认数据目录仍保留为 `~/.deep-seek-harness-mcp`，因此重新安装后可以继续使用原有的本地 Harness 设置和会话。

## 更新

刷新插件市场并重新安装插件，然后新建一个 Codex 任务：

```sh
codex plugin marketplace upgrade deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

## 卸载

```sh
codex plugin remove deepseek-harness@deepseek-harness-for-codex
codex plugin marketplace remove deepseek-harness-for-codex
```

## 独立安装 MCP

仅当你只需要 MCP 工具、不需要插件的委派工作流和 Codex UI 入口时使用：

```sh
codex mcp add deepseek-harness -- npx --yes --package=deepseek-harness-for-codex@0.3.1 -- deepseek-harness-for-codex
```

注册完成后新建一个 Codex 任务。

## 工作原理

插件通过 `npx` 启动已发布的 MCP 服务。某个工作区首次运行任务时，MCP 服务会在本地回环地址执行 `@deepseek-ai/dsh web --port 0`，但不会自动打开浏览器。Codex 通过 Harness Web API 创建工作区和会话，并把对应 URL 作为可点击链接发给用户，因此用户按需打开后看到的就是 Codex 正在控制的实时任务。后续任务会复用该本地服务，不会通过托管中转服务执行。

每次运行都是异步任务：

1. Codex 使用绝对工作区路径和完整任务调用 `start_run`。
2. MCP 服务启动或复用 Harness Web，提交可见会话，并向 Codex 返回页面链接。
3. Codex 展示可点击链接；用户需要时手动打开，同时 Codex 通过 `wait_run` 或 `get_run` 跟踪同一会话。
4. Codex 检查实际 diff，并运行自己的验证流程。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `doctor` | 检查 Node、npx、包版本、凭据可见性、数据目录和工作区限制。 |
| `start_service` | 为工作区启动或复用 Harness Web，并返回页面链接；默认不打开浏览器。 |
| `open_service` | 在用户明确要求时打开正在运行的 Harness 页面。 |
| `list_services` | 列出本地 Harness Web 服务及其 URL。 |
| `stop_service` | 停止 Harness Web 服务。 |
| `start_run` | 由 Codex 选择创建新会话或继续已完成的会话，然后提交任务。 |
| `wait_run` | 等待可见会话，单次最多 30 秒。 |
| `get_run` | 读取 Web 会话状态和助手输出。 |
| `list_runs` | 列出当前 MCP 服务进程创建的运行记录。 |
| `cancel_run` | 取消当前 agent turn，同时保留 Web 服务。 |

`start_service` 和 `start_run` 的 `openBrowser` 默认值都是 `false`，插件也会明确传入 `false`。Codex 应把返回的 `webUrl` 渲染成可点击链接；只有用户明确要求 Codex 代为打开时，才使用 `open_service`。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_MCP_DATA_DIR` | `~/.deep-seek-harness-mcp` | 持久化各工作区的 Harness Web 设置和会话。 |
| `DSH_MCP_WORKSPACE_ROOTS` | 不限制 | `start_run` 允许使用的绝对根目录列表，使用当前平台的路径分隔符。 |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.1.0-rc.6` | 启动本地 Harness 进程时使用的精确 npm 包版本。 |
| `DSH_MCP_NPX_COMMAND` | `npx` | 自定义 `npx` 命令路径。 |
| `DSH_PERMISSION_MODE` | `workspace-write` | DeepSeek Harness 权限模式。 |
| `DEEPSEEK_BASE_URL` | 服务商默认值 | 可选的 DeepSeek 兼容 API 地址。 |

Harness 子进程默认关闭遥测。Web 服务只绑定回环地址并自动选择空闲端口。会话数据保留在配置的数据目录中，便于本地审计。

## 安全模型

`start_run` 是可写工具。服务端要求工作区必须是已存在的绝对路径，会解析符号链接，使用 argv 而不是 shell 启动进程，并可通过 `DSH_MCP_WORKSPACE_ROOTS` 限制允许访问的根目录。Harness Web 仅监听回环地址。默认权限模式是 `workspace-write`，本项目不会静默启用不受限制的主机访问权限。

## 会话模型

每次调用 `start_run` 时，Codex 都可以选择会话。省略 `sessionId` 会创建新的可见 Harness 会话；传入之前已完成运行返回的 `sessionId`，会继续原有对话，并且只返回本轮新增输出。运行中的会话不能被并发复用。本地 Web 服务会持续复用，直到调用 `stop_service` 或 MCP 服务退出。

## 本地开发

克隆仓库、构建 npm 包，然后把当前仓库作为本地插件市场添加到 Codex：

```sh
npm install
npm run check
codex plugin marketplace add /absolute/path/to/deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

正常安装的插件会启动已发布的 `deepseek-harness-for-codex@0.3.1`。开发本地 MCP 时，可以临时把插件 `.mcp.json` 指向 `dist/bin.mjs` 的绝对路径。

## 发布 npm 包

本仓库将无 scope 的公共包 `deepseek-harness-for-codex` 发布到 npm 官方 registry。`npm publish` 会自动执行类型检查、测试和构建。发布包包含 `dist/`、中英文 README、演示 GIF、`LICENSE` 和包清单。

登录并确认 npm 账号：

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

检查发布内容、发布并验证可执行文件：

```sh
npm run release:check
npm publish
npm view deepseek-harness-for-codex version --registry=https://registry.npmjs.org/
npx --yes --package=deepseek-harness-for-codex@0.3.1 -- deepseek-harness-for-codex
```

npm 版本不能被覆盖。后续发布前，需要同步更新 `package.json`、`.mcp.json` 和 MCP 服务元数据中的版本引用，然后执行 `npm version patch`、`npm version minor` 或 `npm version major`。
