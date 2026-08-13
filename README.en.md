# DeepSeek Harness for Codex

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

DeepSeek Harness for Codex lets Codex start [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) locally, open its live Web session for you, delegate work to it, and then independently review the resulting workspace changes.

![DeepSeek Harness for Codex demo](./imgs/examples.gif)

## Quick start

Use the Codex plugin unless you specifically need a standalone MCP server. The plugin installs both the MCP tools and the instructions that tell Codex to review Harness's work independently.

### 1. Check the requirements

- Node.js 22 or later, including `npx`
- A Codex client with plugin support
- A DeepSeek API key

Put the API key in the target repository's ignored `.env` file:

```dotenv
DEEPSEEK_API_KEY=your-key
```

Do not commit this file. You can instead provide `DEEPSEEK_API_KEY` to the environment that starts Codex, or configure the key later in the opened Harness page under **Settings → Models**.

### 2. Install the plugin

Copy these two commands into a terminal:

```sh
codex plugin marketplace add Seann0824/deepseek-harness-for-codex --ref main
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

On macOS, if `codex` is not found or another global installation shadows the desktop client, use the executable bundled with the app:

```sh
CODEX_APP_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
"$CODEX_APP_BIN" plugin marketplace add Seann0824/deepseek-harness-for-codex --ref main
"$CODEX_APP_BIN" plugin add deepseek-harness@deepseek-harness-for-codex
```

### 3. Start a new Codex task

Plugins are loaded when a task starts. Create a new task in Codex and ask it to use DeepSeek Harness, for example:

> Use DeepSeek Harness to implement this change in a visible local session. Keep the Harness Web page open so I can follow the work, then review the diff and run the relevant checks yourself.

Codex will start Harness locally, open its Web page on a free loopback port, submit the task, follow the visible session, and independently verify the result. You do not need to run Harness or register a separate MCP server.

The first task may download the pinned MCP and Harness npm packages. Later tasks use the local npm cache.

## Migrating from the old name

The project was renamed from `deepseek-harness-mcp` to `deepseek-harness-for-codex`. If you installed the old plugin, remove its plugin and marketplace before following the installation steps above:

```sh
codex plugin remove deepseek-harness-mcp@deepseek-harness
codex plugin marketplace remove deepseek-harness
```

The old npm package is not replaced automatically. The default data directory remains `~/.deep-seek-harness-mcp`, so the new installation can continue using existing local Harness settings and sessions.

## Update

Refresh the marketplace and reinstall the plugin, then start a new Codex task:

```sh
codex plugin marketplace upgrade deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

## Uninstall

```sh
codex plugin remove deepseek-harness@deepseek-harness-for-codex
codex plugin marketplace remove deepseek-harness-for-codex
```

## Standalone MCP installation

Use this only when you need the MCP tools without the plugin's delegation instructions and Codex UI entry:

```sh
codex mcp add deepseek-harness -- npx --yes --package=deepseek-harness-for-codex@0.3.0 -- deepseek-harness-for-codex
```

Start a new Codex task after registration.

## How it works

The plugin launches the published MCP server through `npx`. On the first task for a workspace, the MCP server starts `@deepseek-ai/dsh web --port 0` on loopback and opens its URL in the default browser. Codex creates the workspace and session through Harness's Web API, so the browser and Codex observe the same live task. Later tasks reuse that local service. The task does not run on a hosted bridge.

Each run is fresh and asynchronous:

1. Codex calls `start_run` with an absolute workspace and a complete task.
2. The MCP server starts or reuses Harness Web, opens the page, and submits a visible session.
3. Codex follows the session with `wait_run` or `get_run` while the user watches it in the browser.
4. Codex inspects the resulting diff and runs its own verification.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `doctor` | Check Node, npx, package selection, credential visibility, data location, and workspace restrictions. |
| `start_service` | Start or reuse Harness Web for a workspace and open the browser. |
| `open_service` | Reopen a running Harness page. |
| `list_services` | List local Harness Web services and URLs. |
| `stop_service` | Stop a Harness Web service. |
| `start_run` | Create a new visible session or continue a completed session selected by Codex, then submit a task. |
| `wait_run` | Wait up to 30 seconds for the visible session. |
| `get_run` | Read state and assistant text from the Web session. |
| `list_runs` | List runs owned by the current MCP server process. |
| `cancel_run` | Cancel the agent turn while keeping Web available. |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_MCP_DATA_DIR` | `~/.deep-seek-harness-mcp` | Persistent per-workspace Harness Web settings and sessions. |
| `DSH_MCP_WORKSPACE_ROOTS` | unrestricted | Platform-delimited absolute roots that may be passed to `start_run`. |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.1.0-rc.6` | Exact npm package used for the local Harness process. |
| `DSH_MCP_NPX_COMMAND` | `npx` | Alternate path to `npx`. |
| `DSH_PERMISSION_MODE` | `workspace-write` | DeepSeek Harness permission mode. |
| `DEEPSEEK_BASE_URL` | provider default | Optional DeepSeek-compatible API endpoint. |

Telemetry is disabled for Harness child processes by default. The Web service binds to loopback and selects a free port. Session data remains in the configured data directory for local audit.

## Security model

`start_run` is a write-capable tool. The server requires an existing absolute workspace, resolves symlinks, uses argv instead of a shell, and can restrict allowed roots with `DSH_MCP_WORKSPACE_ROOTS`. Harness Web stays on loopback. The default permission mode is `workspace-write`; this project does not silently enable unrestricted host access.

## Session model

Every `start_run` lets Codex choose the session. Omitting `sessionId` creates a new visible Harness session. Passing a completed `sessionId` from an earlier run continues that conversation while returning only the new turn's output. A running session cannot be reused concurrently. The Web service is reused for later tasks in the same workspace until `stop_service` or MCP shutdown.

## Local development

Clone this repository, build the npm package, then add the checkout as a local marketplace:

```sh
npm install
npm run check
codex plugin marketplace add /absolute/path/to/deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

The installed plugin normally starts the published `deepseek-harness-for-codex@0.3.0` package. During local MCP development, temporarily point the plugin's `.mcp.json` at the absolute `dist/bin.mjs` path.

## Publishing the npm package

This repository publishes the public, unscoped `deepseek-harness-for-codex` package to the official npm registry. `npm publish` automatically runs the typecheck, test, and build gate. The package includes `dist/`, both README files, the demo GIF, `LICENSE`, and the package manifest.

Authenticate and verify the account:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

Inspect the release, publish it, and verify the executable:

```sh
npm run release:check
npm publish
npm view deepseek-harness-for-codex version --registry=https://registry.npmjs.org/
npx --yes --package=deepseek-harness-for-codex@0.3.0 -- deepseek-harness-for-codex
```

An npm version cannot be overwritten. For later releases, update references in `package.json`, `.mcp.json`, and the MCP server metadata together, then run `npm version patch`, `npm version minor`, or `npm version major` before publishing.
