import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inspectRuntime } from "./runtime.js";
import { RunManager } from "./run-manager.js";

const runIdSchema = z.string().uuid().describe("Run identifier returned by start_run.");
const serviceIdSchema = z.string().uuid().describe("Service identifier returned by start_service or start_run.");
const sessionIdSchema = z.string().min(1).describe("Harness session identifier returned by a session or run tool.");
const parentSessionIdSchema = z.string().min(1).describe("Harness parent session identifier.");
const childSessionIdSchema = z.string().min(1).describe("Direct child Harness session identifier.");
const textSchema = z.string().min(1).max(100_000).describe("Text-only message content.");

function result(value: object) {
  const structuredContent: Record<string, unknown> = { ...value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Creates the MCP tool surface over a local run manager. */
export function createMcpServer(manager: RunManager = new RunManager()): McpServer {
  const server = new McpServer(
    { name: "deepseek-harness-for-codex", version: "0.4.0" },
    {
      instructions:
        "Start the local DeepSeek Harness Web service, return a clickable session URL, submit coding tasks into visible Web sessions, then inspect workspace changes independently. Do not open the browser unless the user explicitly requests it.",
    },
  );

  server.registerTool(
    "start_service",
    {
      title: "Start the local DeepSeek Harness Web UI",
      description: "Start or reuse a local Harness Web service for an absolute workspace and return its URL without opening a browser by default.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute repository path served by DeepSeek Harness."),
        openBrowser: z.boolean().default(false).describe("Open the Harness page after readiness. Keep false unless the user explicitly requested it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.startService(input)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "open_service",
    {
      title: "Open the DeepSeek Harness page",
      description: "Open an already running Harness Web service in the user's default browser.",
      inputSchema: { serviceId: serviceIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.openService(input.serviceId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List local DeepSeek Harness Web services",
      description: "List Web services started by the current MCP server and their visible URLs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ services: manager.listServices() }),
  );

  server.registerTool(
    "stop_service",
    {
      title: "Stop a DeepSeek Harness Web service",
      description: "Cancel active sessions and stop the local Harness Web service process.",
      inputSchema: { serviceId: serviceIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.stopService(input.serviceId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "doctor",
    {
      title: "Check local DeepSeek Harness prerequisites",
      description: "Check Node, npx, runtime package, credentials visibility, data location, and workspace restrictions without downloading anything.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result(inspectRuntime()),
  );

  server.registerTool(
    "create_session",
    {
      title: "Create a DeepSeek Harness session",
      description: "Create an ordinary session inside an existing Harness Web service without creating an MCP run record.",
      inputSchema: {
        serviceId: serviceIdSchema,
        agentPreset: z.string().min(1).optional().describe("Optional Harness agent preset for this session."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.createSession(input.serviceId, input.agentPreset)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List DeepSeek Harness sessions",
      description: "List persisted ordinary sessions visible to an existing Harness Web service.",
      inputSchema: { serviceId: serviceIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.listSessions(input.serviceId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "read_session",
    {
      title: "Read a DeepSeek Harness session",
      description: "Read one raw, message-aligned history page, including tool views, hasMore, and projection data returned by Harness.",
      inputSchema: {
        serviceId: serviceIdSchema,
        sessionId: sessionIdSchema,
        beforeSeq: z.number().int().min(0).optional().describe("Read the page before this event sequence number."),
        maxMessages: z.number().int().min(1).max(100).default(20).describe("Maximum message origins in this page."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.readSession(input.serviceId, input.sessionId, input.beforeSeq, input.maxMessages)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "queue_session_message",
    {
      title: "Queue a DeepSeek Harness session message",
      description: "Queue text for an ordinary session's next turn and return the history cursor captured immediately before submission.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema, text: textSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.queueSessionMessage(input.serviceId, input.sessionId, input.text)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "steer_session",
    {
      title: "Steer an active DeepSeek Harness session",
      description: "Inject text only into the currently active turn. Harness returns its native error when the session is idle.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema, text: textSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.steerSession(input.serviceId, input.sessionId, input.text)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "wait_session",
    {
      title: "Wait for a DeepSeek Harness session",
      description: "Wait up to 30 seconds for a turn boundary, pending human interaction, service failure, or timeout and return all new raw events.",
      inputSchema: {
        serviceId: serviceIdSchema,
        sessionId: sessionIdSchema,
        afterSeq: z.number().int().min(-1).describe("Return events with a greater sequence number."),
        timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.waitSession(input.serviceId, input.sessionId, input.afterSeq, input.timeoutMs)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "cancel_session",
    {
      title: "Cancel a DeepSeek Harness session turn",
      description: "Cancel the ordinary session's active turn while preserving queued messages and keeping the Web service running.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.cancelSession(input.serviceId, input.sessionId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "fork_session",
    {
      title: "Fork a DeepSeek Harness session",
      description: "Create a new session from a completed-turn prefix without creating an MCP run record.",
      inputSchema: {
        serviceId: serviceIdSchema,
        sessionId: sessionIdSchema,
        atSeq: z.number().int().min(0).optional().describe("Event sequence anchoring the completed turn to include."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.forkSession(input.serviceId, input.sessionId, input.atSeq)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "read_session_queue",
    {
      title: "Read a DeepSeek Harness session queue",
      description: "Return the authoritative transient queue snapshot observed from the Harness Mux stream and whether a baseline was observed.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(manager.readSessionQueue(input.serviceId, input.sessionId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "edit_queued_message",
    {
      title: "Edit a queued DeepSeek Harness message",
      description: "Replace one still-pending queue item's content with text.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema, itemId: z.string().min(1), text: textSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.editQueuedMessage(input.serviceId, input.sessionId, input.itemId, input.text)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "remove_queued_message",
    {
      title: "Remove a queued DeepSeek Harness message",
      description: "Remove one still-pending queue item.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema, itemId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.removeQueuedMessage(input.serviceId, input.sessionId, input.itemId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "steer_queued_message",
    {
      title: "Steer a queued DeepSeek Harness message",
      description: "Move one pending queued message into strict steering placement.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema, itemId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.steerQueuedMessage(input.serviceId, input.sessionId, input.itemId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "list_subagents",
    {
      title: "List DeepSeek Harness subagents",
      description: "List durable direct children and parent availability for one Harness session.",
      inputSchema: { serviceId: serviceIdSchema, parentSessionId: parentSessionIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.listSubagents(input.serviceId, input.parentSessionId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "read_subagent",
    {
      title: "Read a DeepSeek Harness subagent",
      description: "Read one direct child's raw paginated transcript without activating it.",
      inputSchema: {
        serviceId: serviceIdSchema,
        parentSessionId: parentSessionIdSchema,
        childSessionId: childSessionIdSchema,
        beforeSeq: z.number().int().min(0).optional(),
        maxMessages: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.readSubagent(input.serviceId, input.parentSessionId, input.childSessionId, input.beforeSeq, input.maxMessages)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "send_subagent_message",
    {
      title: "Message a continuable DeepSeek Harness subagent",
      description: "Send text to a direct continuable child. One-shot children are rejected before submission.",
      inputSchema: { serviceId: serviceIdSchema, parentSessionId: parentSessionIdSchema, childSessionId: childSessionIdSchema, text: textSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.sendSubagentMessage(input.serviceId, input.parentSessionId, input.childSessionId, input.text)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "interrupt_subagent",
    {
      title: "Interrupt a continuable DeepSeek Harness subagent",
      description: "Interrupt a direct continuable child's active turn. One-shot children cannot be interrupted.",
      inputSchema: { serviceId: serviceIdSchema, parentSessionId: parentSessionIdSchema, childSessionId: childSessionIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.interruptSubagent(input.serviceId, input.parentSessionId, input.childSessionId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "list_pending_interactions",
    {
      title: "List pending DeepSeek Harness interactions",
      description: "List approval and question requests replayed by the control stream, optionally for one session.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema.optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result({ interactions: manager.listPendingInteractions(input.serviceId, input.sessionId) }); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "approve_harness_action",
    {
      title: "Approve a pending DeepSeek Harness action",
      description: "Allow one pending Harness action once. Never call this tool unless the user explicitly authorized this exact approval.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema, approvalId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.approveHarnessAction(input.serviceId, input.sessionId, input.approvalId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "reject_harness_action",
    {
      title: "Reject a pending DeepSeek Harness action",
      description: "Reject one pending Harness action without granting it permission.",
      inputSchema: { serviceId: serviceIdSchema, sessionId: sessionIdSchema, approvalId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.rejectHarnessAction(input.serviceId, input.sessionId, input.approvalId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "answer_harness_question",
    {
      title: "Answer pending DeepSeek Harness questions",
      description: "Submit one complete pending question batch. A plan-review question requires the user's explicit decision before this tool may be called.",
      inputSchema: {
        serviceId: serviceIdSchema,
        sessionId: sessionIdSchema,
        rpcId: z.string().min(1).describe("Stable rpcId from the pending question interaction."),
        answers: z.array(z.object({
          id: z.string().min(1),
          selected: z.array(z.string()),
          custom: z.string().optional(),
        })).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.answerHarnessQuestion(input.serviceId, input.sessionId, input.rpcId, input.answers)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "start_run",
    {
      title: "Start a local DeepSeek Harness run",
      description: "Start or reuse the Harness Web UI, then create a new session or continue a completed session selected by Codex. Returns runId, sessionId, sessionReused, and webUrl.",
      inputSchema: {
        task: z.string().min(1).max(100_000).describe("Complete implementation task, constraints, and acceptance checks for DeepSeek Harness."),
        workspace: z.string().min(1).describe("Absolute path of the repository DeepSeek Harness may inspect and modify."),
        sessionId: z.string().min(1).optional().describe("Completed Harness session to continue. Pass a sessionId returned by an earlier run in this workspace, or omit it to create a new session."),
        openBrowser: z.boolean().default(false).describe("Open the live Harness Web page. Keep false unless the user explicitly requested it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return result(await manager.start(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Read a DeepSeek Harness run",
      description: "Read the current state and assistant response from the same Harness Web session shown to the user.",
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.get(input.runId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "wait_run",
    {
      title: "Wait for DeepSeek Harness output",
      description: "Poll the visible Harness Web session for up to 30 seconds and return its current status and assistant response.",
      inputSchema: {
        runId: runIdSchema,
        timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.wait(input.runId, input.timeoutMs));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "List local DeepSeek Harness runs",
      description: "List runs started by the current MCP server process, including session IDs Codex may choose to continue in a later start_run call.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ runs: await manager.list() }),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel a local DeepSeek Harness run",
      description: "Cancel the agent turn in its visible Web session while keeping the Harness Web UI running.",
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.cancel(input.runId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
