import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManager } from "../src/run-manager.js";
import type { HarnessCommand } from "../src/runtime.js";
import { createMcpServer } from "../src/server.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");
const openBrowser = vi.fn(async () => undefined);

describe("MCP server", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: RunManager;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    openBrowser.mockClear();
    temporaryRoot = await mkdtemp(join(tmpdir(), "deep-seek-harness-mcp-server-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    manager = new RunManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser,
      commandFactory: ({ workspace: cwd, serviceHome }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env, FAKE_HARNESS_STATE_FILE: join(serviceHome, "fake-state.json") },
      }),
    });
    server = createMcpServer(manager);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await manager.close();
    await server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("advertises the complete orchestration surface", async () => {
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name).sort()).toEqual([
      "answer_harness_question",
      "approve_harness_action",
      "cancel_run",
      "cancel_session",
      "create_session",
      "doctor",
      "edit_queued_message",
      "fork_session",
      "get_run",
      "interrupt_subagent",
      "list_pending_interactions",
      "list_runs",
      "list_services",
      "list_sessions",
      "list_subagents",
      "open_service",
      "queue_session_message",
      "read_session",
      "read_session_queue",
      "read_subagent",
      "reject_harness_action",
      "remove_queued_message",
      "send_subagent_message",
      "start_run",
      "start_service",
      "steer_queued_message",
      "steer_session",
      "stop_service",
      "wait_run",
      "wait_session",
    ]);
    const approval = response.tools.find((tool) => tool.name === "approve_harness_action");
    expect(approval?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    const history = response.tools.find((tool) => tool.name === "read_session");
    expect(history?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    const readOnly = new Set([
      "doctor", "get_run", "list_pending_interactions", "list_runs", "list_services", "list_sessions",
      "list_subagents", "read_session", "read_session_queue", "read_subagent", "wait_run", "wait_session",
    ]);
    const destructive = new Set([
      "answer_harness_question", "approve_harness_action", "cancel_run", "cancel_session", "edit_queued_message",
      "interrupt_subagent", "reject_harness_action", "remove_queued_message", "stop_service",
    ]);
    const nonIdempotent = new Set([
      "answer_harness_question", "approve_harness_action", "create_session", "fork_session", "queue_session_message",
      "reject_harness_action", "send_subagent_message", "start_run", "steer_queued_message", "steer_session",
    ]);
    const openWorld = new Set([
      "answer_harness_question", "approve_harness_action", "open_service", "queue_session_message",
      "send_subagent_message", "start_run", "start_service", "steer_queued_message", "steer_session",
    ]);
    for (const tool of response.tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(readOnly.has(tool.name));
      expect(tool.annotations?.destructiveHint, tool.name).toBe(destructive.has(tool.name));
      expect(tool.annotations?.idempotentHint, tool.name).toBe(!nonIdempotent.has(tool.name));
      expect(tool.annotations?.openWorldHint, tool.name).toBe(openWorld.has(tool.name));
    }
    expect(history?.inputSchema).toMatchObject({
      properties: { maxMessages: expect.objectContaining({ default: 20, maximum: 100, minimum: 1 }) },
    });
  });

  it("starts and waits for a local run through MCP", async () => {
    const start = await client.callTool({
      name: "start_run",
      arguments: { task: "MCP task", workspace },
    });
    expect(start.isError).not.toBe(true);
    const runId = (start.structuredContent as { runId: string }).runId;

    const wait = await client.callTool({
      name: "wait_run",
      arguments: { runId, timeoutMs: 2_000 },
    });

    expect(wait.isError).not.toBe(true);
    expect(wait.structuredContent).toMatchObject({
      runId,
      status: "succeeded",
      assistantText: "completed:MCP task",
    });

    const sessionId = (start.structuredContent as { sessionId: string }).sessionId;
    const followUp = await client.callTool({
      name: "start_run",
      arguments: { task: "MCP follow-up", workspace, sessionId },
    });
    expect(followUp.isError).not.toBe(true);
    expect(followUp.structuredContent).toMatchObject({ sessionId, sessionReused: true });

    const followUpRunId = (followUp.structuredContent as { runId: string }).runId;
    const followUpWait = await client.callTool({
      name: "wait_run",
      arguments: { runId: followUpRunId, timeoutMs: 2_000 },
    });
    expect(followUpWait.structuredContent).toMatchObject({
      status: "succeeded",
      assistantText: "completed:MCP follow-up",
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("returns a tool error for an invalid workspace", async () => {
    const response = await client.callTool({
      name: "start_run",
      arguments: { task: "task", workspace: "." },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("absolute path") }),
    ]);
  });

  it("controls a directly addressed session without creating a run", async () => {
    const serviceCall = await client.callTool({ name: "start_service", arguments: { workspace } });
    const serviceId = (serviceCall.structuredContent as { serviceId: string }).serviceId;
    const create = await client.callTool({ name: "create_session", arguments: { serviceId, agentPreset: "default" } });
    const sessionId = (create.structuredContent as { sessionId: string }).sessionId;
    const queued = await client.callTool({ name: "queue_session_message", arguments: { serviceId, sessionId, text: "direct task" } });
    expect(queued.structuredContent).toMatchObject({ accepted: true, afterSeq: -1 });

    const waited = await client.callTool({ name: "wait_session", arguments: { serviceId, sessionId, afterSeq: -1, timeoutMs: 2_000 } });
    expect(waited.structuredContent).toMatchObject({ serviceId, sessionId, waitReason: "complete" });
    expect((waited.structuredContent as { events: unknown[] }).events).toHaveLength(3);
    expect((await client.callTool({ name: "list_runs", arguments: {} }).then((value) => value.structuredContent)) as object)
      .toEqual({ runs: [] });
  });
});
