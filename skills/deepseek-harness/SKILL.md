---
name: deepseek-harness
description: Start and control the local DeepSeek Harness Web UI, delegate work into visible sessions, manage queues and continuable subagents, handle pending human interactions with explicit user decisions, then independently verify workspace changes. Use when the user asks Codex to use, show, control, or hand work to DeepSeek Harness.
---

# DeepSeek Harness

Use the `deepseek-harness` MCP tools to run DeepSeek Harness locally through its Web UI. The user must be able to watch the same session that Codex controls. Codex remains responsible for the task outcome and must inspect changed files and run appropriate verification itself.

## Delegated run workflow

1. Call `doctor` before the first run in a task. Explain any failed prerequisite. A DeepSeek API key may come from the MCP environment, the target workspace's uncommitted `.env` file, or the Harness Web Models settings.
2. Inspect the target repository enough to write a concrete delegation prompt. Include the requested outcome, repository instructions, scope limits, and acceptance checks. Do not include credentials.
3. Omit `sessionId` for independent work or a clean retry. Pass an earlier completed run's `sessionId` only for a direct follow-up in the same workspace. Never reuse a running session or a session from another workspace.
4. Call `start_run` exactly once for that attempt with `openBrowser: false`. Show the returned `webUrl` as a clickable Markdown link and state whether the session was reused. Do not call `open_service` unless the user explicitly asks Codex to open the page.
5. Call `wait_run` for at most 30 seconds at a time. A response with `waitReason: "attention"` remains `running`; inspect `pendingInteractions`, obtain the required user decision, respond, and continue waiting.
6. Treat Harness output as a handoff report, not proof. Inspect the actual workspace diff, preserve unrelated user changes, and run the smallest checks covering the change.
7. If review finds a concrete defect, continue the completed session when its context helps or start a clean correction session. State the defect and failed check precisely, then review again.
8. Use `cancel_run` for an unsafe or obsolete turn while leaving the Web service available. Use `stop_service` only when the local server is no longer needed.

## Direct control workflow

- Use `start_service` and `list_sessions` to locate persisted sessions, including sessions that predate the current MCP process. Direct session tools use `serviceId + sessionId` and never create a run record.
- Use `create_session`, `read_session`, `queue_session_message`, `steer_session`, `wait_session`, `cancel_session`, and `fork_session` for ordinary sessions. Preserve the `afterSeq` returned by `queue_session_message` and pass it to `wait_session`.
- `read_session` and `wait_session` return raw Harness events, tool render views, pagination state, and projections. Do not invent a second transcript projection.
- Use `read_session_queue` as the queue authority. `observed: false` means the control stream has not established a baseline. Edit, remove, or steer only item IDs from an observed snapshot.
- Use `list_subagents` and `read_subagent` for direct children. Only `mode: "continuable"` children may receive `send_subagent_message` or `interrupt_subagent`; never attempt to control one-shot children.
- Cancel an ordinary turn with `cancel_session` and a continuable child with `interrupt_subagent`. Neither operation stops Harness Web. There is no individual tool-call or background-job cancellation tool.
- Queueing or steering a session already tracked by a run is allowed. Continue tracking the original run after the direct action.

## Human interactions

- Read pending requests with `list_pending_interactions`. `wait_run` and `wait_session` return early when attention is required.
- Never call `approve_harness_action` unless the user explicitly authorizes that exact pending approval after seeing its tool name, reason, and relevant arguments or context. Do not infer approval from the original coding request.
- Use `reject_harness_action` when the user explicitly rejects the action or when cancelling an unsafe or obsolete turn is not the desired response.
- Never call `answer_harness_question` for a `plan-review` question without the user's explicit decision. Other questions also require an answer grounded in user intent; ask the user whenever the choice is not already explicit.
- Interaction responses are one-shot. After submission, keep waiting for the resolved frame. Treat `not-pending` as stale or already answered; do not retry by guessing.

## Safety

- Harness Web is a loopback-only local child process with access to the requested workspace. Do not pass a broader directory than needed.
- The default permission mode is `workspace-write`. Do not switch to `danger-full-access` unless the user explicitly authorizes that broader access.
- Do not ask Harness to commit, push, publish, deploy, or contact external systems unless the user explicitly requested that action.
- This plugin does not expose settings, credentials, host filesystem browsing, workspace administration, models, presets, goals, background jobs, or individual tool-call interruption.
