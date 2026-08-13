---
name: delegate-to-deepseek-harness
description: Start the local DeepSeek Harness Web UI, open it for the user, delegate a scoped coding task into a visible Web session, then independently review and verify the workspace changes. Use when the user asks Codex to use, show, control, or hand work to DeepSeek Harness.
---

# Delegate to DeepSeek Harness

Use the `deepseek-harness` MCP tools to run DeepSeek Harness locally through its Web UI. The user must be able to watch the same session that Codex controls. Codex remains responsible for the task outcome and must inspect the changed files and run appropriate verification itself.

## Workflow

1. Call `doctor` before the first run in a task. Explain any failed prerequisite. A DeepSeek API key may come from the MCP environment, the target workspace's uncommitted `.env` file, or the Harness Web Models settings.
2. Inspect the target repository enough to write a concrete delegation prompt. Include the requested outcome, relevant repository instructions, scope limits, and acceptance checks. Do not include credentials.
3. Call `start_run` exactly once for that attempt with `openBrowser: true`. It starts or reuses `dsh web`, opens the page, creates a workspace-bound Web session, and submits the task. Tell the user the returned `webUrl`.
4. Call `wait_run` with a timeout of at most 30 seconds until the run is `succeeded`, `failed`, or `cancelled`. The browser and MCP observe the same session ID and history.
5. Treat the Harness response as a handoff report, not proof. Inspect the actual workspace diff, preserve unrelated user changes, and run the smallest checks that cover the change.
6. If review finds a concrete defect, start a fresh visible correction run in the same workspace with the defect and failed check stated precisely. Review the correction again.
7. Use `cancel_run` to cancel an unsafe or obsolete turn while leaving the Web page available. Use `stop_service` only when the local server is no longer needed.

## Safety

- Harness Web starts as a loopback-only local child process and receives access to the requested workspace. Do not pass a broader directory than needed.
- The default permission mode is `workspace-write`. Do not switch to `danger-full-access` unless the user explicitly authorizes that broader access.
- Do not ask Harness to commit, push, publish, deploy, or contact external systems unless the user explicitly requested that action.
