# DeepSeek Harness MCP

DeepSeek Harness MCP is a TypeScript MCP server and Codex plugin that lets Codex delegate a coding task to a locally started [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) process. Codex can start a run, follow bounded stdout and stderr updates, cancel the process tree, and then review the real workspace changes itself.

## How it works

The plugin starts this MCP server through `npx`. For every delegated task, the server starts a separate local `@deepseek-ai/dsh` headless process with the requested repository as its working directory. The task does not run on a hosted bridge. DeepSeek model requests still use the provider configured for DeepSeek Harness.

Each run is fresh and asynchronous:

1. Codex calls `start_run` with an absolute workspace and a complete task.
2. The server returns a run ID immediately.
3. Codex follows incremental output with `wait_run` or checks it with `get_run`.
4. Codex inspects the resulting diff and runs its own verification.

## Requirements

- Node.js 22 or later, including `npx`
- A DeepSeek API key available as `DEEPSEEK_API_KEY`, or in an uncommitted `.env` file at the target workspace root
- A Codex client with plugin or MCP support

The first run may download the pinned MCP and DeepSeek Harness npm packages. Later runs use the local npm cache.

## Codex plugin installation

Once this package and plugin are published, install the plugin from its Codex plugin directory entry. The bundled `.mcp.json` starts `deepseek-harness-mcp@0.1.0`; no separate server setup is required.

For local plugin development, build the package and point `.mcp.json` temporarily at the absolute `dist/bin.mjs` path:

```sh
npm install
npm run check
node dist/bin.mjs
```

The last command starts a stdio MCP server and is normally launched by Codex rather than a terminal user.

## Standalone MCP installation

The server can also be registered without the plugin:

```sh
codex mcp add deepseek-harness -- npx --yes deepseek-harness-mcp@0.1.0
```

Keep `DEEPSEEK_API_KEY` out of shell history. Set it in the environment that starts Codex or place it in the target repository's ignored `.env` file:

```dotenv
DEEPSEEK_API_KEY=your-key
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `doctor` | Check Node, npx, package selection, credential visibility, data location, and workspace restrictions. |
| `start_run` | Start one local headless Harness process and return its run ID. |
| `wait_run` | Wait up to 30 seconds and return incremental output. |
| `get_run` | Read state and incremental output without waiting. |
| `list_runs` | List runs owned by the current MCP server process. |
| `cancel_run` | Terminate a running Harness process tree. |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_MCP_DATA_DIR` | `~/.deep-seek-harness-mcp` | Private per-run Harness homes and session state. |
| `DSH_MCP_WORKSPACE_ROOTS` | unrestricted | Platform-delimited absolute roots that may be passed to `start_run`. |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.1.0-rc.6` | Exact npm package used for the local Harness process. |
| `DSH_MCP_NPX_COMMAND` | `npx` | Alternate path to `npx`. |
| `DSH_PERMISSION_MODE` | `workspace-write` | DeepSeek Harness permission mode. |
| `DEEPSEEK_BASE_URL` | provider default | Optional DeepSeek-compatible API endpoint. |

Telemetry is disabled for Harness child processes by default. Output retained in MCP memory is bounded to one million characters per stream per run. Session data remains in the configured data directory for local audit.

## Security model

`start_run` is a write-capable tool. The server requires an existing absolute workspace, resolves symlinks, uses argv instead of a shell, and can restrict allowed roots with `DSH_MCP_WORKSPACE_ROOTS`. The default Harness permission mode is `workspace-write`; this project does not silently enable unrestricted host access.

## Current limitation

DeepSeek Harness headless mode is a one-task process, so the MCP layer cannot inject a mid-run follow-up. Codex supplies corrections as a new run against the already modified workspace. This keeps orchestration reliable while preserving Codex's independent review role.

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

Publish version `0.1.0`:

```sh
npm publish
```

Then verify the public package and executable:

```sh
npm view deepseek-harness-mcp version --registry=https://registry.npmjs.org/
npx --yes deepseek-harness-mcp@0.1.0
```

An npm version cannot be overwritten. For later releases, update references in `package.json`, `.mcp.json`, and the MCP server metadata together, then run `npm version patch`, `npm version minor`, or `npm version major` as appropriate before publishing.
