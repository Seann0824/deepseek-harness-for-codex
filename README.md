# DeepSeek Harness MCP

DeepSeek Harness MCP is a TypeScript MCP server and Codex plugin that lets Codex start the local [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web UI, open it for the user, delegate a coding task into a visible session, and then review the real workspace changes itself.

## How it works

The plugin starts this MCP server through `npx`. On the first task for a workspace, the MCP server starts `@deepseek-ai/dsh web --port 0` on loopback and opens its URL in the default browser. Codex creates the workspace and session through Harness's own Web API, so the browser and Codex observe the same live task. Later tasks reuse that local service. The task does not run on a hosted bridge.

Each run is fresh and asynchronous:

1. Codex calls `start_run` with an absolute workspace and a complete task.
2. The MCP server starts/reuses Harness Web, opens the page, and submits a visible session.
3. Codex follows the same session with `wait_run` or `get_run` while the user watches it in the browser.
4. Codex inspects the resulting diff and runs its own verification.

## Requirements

- Node.js 22 or later, including `npx`
- A DeepSeek API key available as `DEEPSEEK_API_KEY`, or in an uncommitted `.env` file at the target workspace root
- A Codex client with plugin or MCP support

The first run may download the pinned MCP and DeepSeek Harness npm packages. Later runs use the local npm cache.

## Codex desktop plugin installation

The npm package is the MCP executable; publishing it does not by itself publish a Codex plugin. The Codex plugin is the marketplace entry under `.agents/plugins/marketplace.json` plus `plugins/deepseek-harness-mcp/`. It installs both the MCP configuration and the delegation Skill.

Install the plugin from GitHub:

```sh
codex plugin marketplace add Seann0824/deepseek-harness-mcp --ref main
codex plugin add deepseek-harness-mcp@deepseek-harness
```

For local development, add an absolute checkout path instead. On macOS, if another global `codex` shadows the desktop client's executable, use the binary bundled with the app:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex plugin marketplace add /absolute/path/to/deepseek-harness-mcp
/Applications/ChatGPT.app/Contents/Resources/codex plugin add deepseek-harness-mcp@deepseek-harness
```

Start a new Codex task after installation so the new MCP tools and Skill are loaded. The plugin starts the published `deepseek-harness-mcp@0.2.0` package; users do not separately register the MCP server.

For local plugin development, build the package and point `.mcp.json` temporarily at the absolute `dist/bin.mjs` path:

```sh
npm install
npm run check
node dist/bin.mjs
```

The last command starts a stdio MCP server and is normally launched by Codex rather than a terminal user.

## Standalone MCP installation

Use this only when the Skill and plugin UI entry are not needed:

```sh
codex mcp add deepseek-harness -- npx --yes --package=deepseek-harness-mcp@0.2.0 -- deepseek-harness-mcp
```

Keep `DEEPSEEK_API_KEY` out of shell history. Set it in the environment that starts Codex or place it in the target repository's ignored `.env` file:

```dotenv
DEEPSEEK_API_KEY=your-key
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `doctor` | Check Node, npx, package selection, credential visibility, data location, and workspace restrictions. |
| `start_service` | Start/reuse Harness Web for a workspace and open the browser. |
| `open_service` | Reopen a running Harness page. |
| `list_services` | List local Harness Web services and URLs. |
| `stop_service` | Stop a Harness Web service. |
| `start_run` | Create a visible Web session and submit a task. |
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

Telemetry is disabled for Harness child processes by default. The Web service binds to a loopback address and selects a free port. Session data remains in the configured data directory for local audit. A key can also be configured interactively through **Settings → Models** in the opened Harness page.

## Security model

`start_run` is a write-capable tool. The server requires an existing absolute workspace, resolves symlinks, uses argv instead of a shell, and can restrict allowed roots with `DSH_MCP_WORKSPACE_ROOTS`. Harness Web stays on loopback. The default permission mode is `workspace-write`; this project does not silently enable unrestricted host access.

## Session model

Every `start_run` creates a new visible Harness Web session. The service is reused for later tasks in the same workspace until `stop_service` or MCP shutdown. Codex supplies correction feedback as another visible session against the already modified workspace and independently verifies the result.

## Publishing the MCP package

This repository is configured to publish the public, unscoped `deepseek-harness-mcp` package to the official npm registry. `npm publish` automatically runs the complete typecheck, test, and build gate before uploading. Only `dist/`, `README.md`, `LICENSE`, and the package manifest are included.

Before the first release, authenticate with the official registry and verify the account:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

Inspect exactly what would be uploaded:

```sh
npm run release:check
```

Publish version `0.2.0`:

```sh
npm publish
```

Then verify the public package and executable:

```sh
npm view deepseek-harness-mcp version --registry=https://registry.npmjs.org/
npx --yes deepseek-harness-mcp@0.2.0
```

An npm version cannot be overwritten. For later releases, update references in `package.json`, `.mcp.json`, and the MCP server metadata together, then run `npm version patch`, `npm version minor`, or `npm version major` as appropriate before publishing.
