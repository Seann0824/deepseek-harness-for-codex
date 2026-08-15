import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManager } from "../src/run-manager.js";
import type { HarnessCommand } from "../src/runtime.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");

describe("RunManager Web orchestration", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: RunManager;
  const openBrowser = vi.fn(async () => undefined);

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-harness-mcp-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    openBrowser.mockClear();
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
  });

  afterEach(async () => {
    await manager.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("starts the Web service and opens its page", async () => {
    const service = await manager.startService({ workspace, openBrowser: true });

    expect(service.status).toBe("running");
    expect(service.harnessVersion).toBe("0.1.0-rc.6");
    expect(service.controlConnected).toBe(true);
    expect(service.controlError).toBeNull();
    expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.browserOpened).toBe(true);
    expect(openBrowser).toHaveBeenCalledWith(service.webUrl);
    expect((await fetch(service.webUrl!)).status).toBe(200);
  });

  it("starts the Web service without opening its page by default", async () => {
    const service = await manager.startService({ workspace });

    expect(service.status).toBe("running");
    expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.browserOpened).toBe(false);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("submits the task into the visible Web session", async () => {
    const started = await manager.start({ task: "implement feature", workspace, openBrowser: true });
    expect(started.status).toBe("running");
    expect(started.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started.sessionId).toBe("session-1");
    expect(started.sessionReused).toBe(false);

    const completed = await manager.wait(started.runId, 2_000);
    expect(completed.status).toBe("succeeded");
    expect(completed.assistantText).toBe("completed:implement feature");
    expect(completed.lastEventSeq).toBe(2);
  });

  it("reuses one Web service for later tasks in the workspace", async () => {
    const first = await manager.start({ task: "first", workspace });
    const second = await manager.start({ task: "second", workspace });

    expect(second.serviceId).toBe(first.serviceId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(manager.listServices()).toHaveLength(1);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("lets the caller continue a completed session without returning earlier output", async () => {
    const first = await manager.start({ task: "first", workspace, openBrowser: false });
    await manager.wait(first.runId, 2_000);

    const second = await manager.start({
      task: "follow-up",
      workspace,
      sessionId: first.sessionId,
      openBrowser: false,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionReused).toBe(true);

    const completed = await manager.wait(second.runId, 2_000);
    expect(completed.status).toBe("succeeded");
    expect(completed.assistantText).toBe("completed:follow-up");
    expect(completed.lastEventSeq).toBe(5);
  });

  it("rejects reuse while the selected session is running", async () => {
    const first = await manager.start({ task: "first", workspace, openBrowser: false });

    await expect(manager.start({
      task: "overlap",
      workspace,
      sessionId: first.sessionId,
      openBrowser: false,
    })).rejects.toThrow("still running");
  });

  it("cancels a run but keeps its Web service alive", async () => {
    const started = await manager.start({ task: "long task", workspace, openBrowser: false });
    const cancelled = await manager.cancel(started.runId);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequested).toBe(true);
    expect(manager.listServices()[0]?.status).toBe("running");
  });

  it("controls ordinary sessions directly without creating run records", async () => {
    const service = await manager.startService({ workspace });
    const created = await manager.createSession(service.serviceId, "default") as { sessionId: string; agentPreset: string };
    expect(created.agentPreset).toBe("default");
    expect(await manager.listSessions(service.serviceId)).toMatchObject({ items: [expect.objectContaining({ sessionId: created.sessionId })] });

    const queued = await manager.queueSessionMessage(service.serviceId, created.sessionId, "direct") as { afterSeq: number };
    expect(queued.afterSeq).toBe(-1);
    const waited = await manager.waitSession(service.serviceId, created.sessionId, queued.afterSeq, 2_000) as {
      waitReason: string;
      events: Array<{ event: { type: string } }>;
      projections: unknown;
    };
    expect(waited.waitReason).toBe("complete");
    expect(waited.events.map((entry) => entry.event.type)).toEqual(["turn/start", "assistant/message", "turn/end"]);
    expect(waited.projections).toBeDefined();
    expect(await manager.list()).toEqual([]);

    const forked = await manager.forkSession(service.serviceId, created.sessionId) as { sessionId: string };
    expect(forked.sessionId).not.toBe(created.sessionId);
    await expect(manager.steerSession(service.serviceId, created.sessionId, "too late")).rejects.toThrow("steering requires an active turn");
  });

  it("observes and mutates the authoritative queue while preserving it through cancellation", async () => {
    const service = await manager.startService({ workspace });
    const created = await manager.createSession(service.serviceId) as { sessionId: string };
    const first = await manager.queueSessionMessage(service.serviceId, created.sessionId, "needs approval") as { afterSeq: number };
    await manager.queueSessionMessage(service.serviceId, created.sessionId, "queued follow-up");
    await vi.waitFor(() => expect(manager.readSessionQueue(service.serviceId, created.sessionId).items).toHaveLength(1));
    const queue = manager.readSessionQueue(service.serviceId, created.sessionId);
    expect(queue.observed).toBe(true);
    expect(queue.items).toHaveLength(1);
    const itemId = (queue.items[0] as { id: string }).id;

    await manager.editQueuedMessage(service.serviceId, created.sessionId, itemId, "edited follow-up");
    await vi.waitFor(() => expect(manager.readSessionQueue(service.serviceId, created.sessionId).items).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ content: [{ type: "text", text: "edited follow-up" }] }) }),
    ]));
    await manager.steerQueuedMessage(service.serviceId, created.sessionId, itemId);
    await vi.waitFor(() => expect(manager.readSessionQueue(service.serviceId, created.sessionId).items).toEqual([
      expect.objectContaining({ placement: "steering" }),
    ]));
    await manager.cancelSession(service.serviceId, created.sessionId);
    expect(manager.readSessionQueue(service.serviceId, created.sessionId).items).toHaveLength(1);
    await vi.waitFor(() => expect(manager.listPendingInteractions(service.serviceId, created.sessionId)).toEqual([]));
    const completed = await manager.waitSession(service.serviceId, created.sessionId, first.afterSeq, 100);
    expect(completed).toMatchObject({ waitReason: "complete" });
    await manager.removeQueuedMessage(service.serviceId, created.sessionId, itemId);
    await vi.waitFor(() => expect(manager.readSessionQueue(service.serviceId, created.sessionId).items).toEqual([]));
    expect(manager.listServices()[0]?.status).toBe("running");
  });

  it("returns early for approvals and converges only after the resolved frame", async () => {
    const service = await manager.startService({ workspace });
    const created = await manager.createSession(service.serviceId) as { sessionId: string };
    const queued = await manager.queueSessionMessage(service.serviceId, created.sessionId, "needs approval") as { afterSeq: number };
    const waiting = await manager.waitSession(service.serviceId, created.sessionId, queued.afterSeq, 2_000) as {
      waitReason: string;
      pendingInteractions: Array<{ kind: string; approvalId: string }>;
    };
    expect(waiting.waitReason).toBe("attention");
    const approval = waiting.pendingInteractions[0];
    expect(approval?.kind).toBe("approval");
    expect(await manager.approveHarnessAction(service.serviceId, created.sessionId, approval!.approvalId)).toMatchObject({ responseSubmitted: true });
    await vi.waitFor(() => expect(manager.listPendingInteractions(service.serviceId, created.sessionId)).toEqual([]));
    await expect(manager.approveHarnessAction(service.serviceId, created.sessionId, approval!.approvalId)).rejects.toThrow("not-pending");
    expect(await manager.waitSession(service.serviceId, created.sessionId, queued.afterSeq, 2_000)).toMatchObject({ waitReason: "complete" });
  });

  it("returns run attention without changing the running status and answers questions", async () => {
    const started = await manager.start({ task: "needs question", workspace });
    const attention = await manager.wait(started.runId, 2_000);
    expect(attention).toMatchObject({ status: "running", waitReason: "attention" });
    const question = attention.pendingInteractions[0];
    expect(question?.kind).toBe("question");
    if (question?.kind !== "question") throw new Error("expected a question interaction");
    expect(await manager.answerHarnessQuestion(started.serviceId, started.sessionId, question.rpcId, [
      { id: "choice", selected: ["yes"] },
    ])).toMatchObject({ responseSubmitted: true });
    expect((await manager.wait(started.runId, 2_000)).status).toBe("succeeded");
  });

  it("rejects a pending approval and settles through its resolved frame", async () => {
    const service = await manager.startService({ workspace });
    const created = await manager.createSession(service.serviceId) as { sessionId: string };
    const queued = await manager.queueSessionMessage(service.serviceId, created.sessionId, "needs approval") as { afterSeq: number };
    const attention = await manager.waitSession(service.serviceId, created.sessionId, queued.afterSeq, 2_000) as {
      pendingInteractions: Array<{ kind: string; approvalId: string }>;
    };
    const approval = attention.pendingInteractions[0];
    expect(await manager.rejectHarnessAction(service.serviceId, created.sessionId, approval!.approvalId)).toMatchObject({ responseSubmitted: true });
    await vi.waitFor(() => expect(manager.listPendingInteractions(service.serviceId, created.sessionId)).toEqual([]));
    expect(await manager.waitSession(service.serviceId, created.sessionId, queued.afterSeq, 2_000)).toMatchObject({ waitReason: "complete" });
  });

  it("controls only continuable subagents", async () => {
    const service = await manager.startService({ workspace });
    const created = await manager.createSession(service.serviceId) as { sessionId: string };
    const continuable = `${created.sessionId}-continuable`;
    const oneShot = `${created.sessionId}-one-shot`;
    expect(await manager.listSubagents(service.serviceId, created.sessionId)).toMatchObject({ entries: expect.any(Array) });
    expect(await manager.readSubagent(service.serviceId, created.sessionId, continuable)).toMatchObject({ events: expect.any(Array) });
    expect(await manager.sendSubagentMessage(service.serviceId, created.sessionId, continuable, "continue")).toMatchObject({ messageId: expect.any(String) });
    expect(await manager.interruptSubagent(service.serviceId, created.sessionId, continuable)).toEqual({ accepted: true });
    await expect(manager.sendSubagentMessage(service.serviceId, created.sessionId, oneShot, "invalid")).rejects.toThrow("one-shot");
    await expect(manager.interruptSubagent(service.serviceId, created.sessionId, oneShot)).rejects.toThrow("one-shot");
  });

  it("clears stale interactions before replay after a control reconnect", async () => {
    const service = await manager.startService({ workspace });
    const created = await manager.createSession(service.serviceId) as { sessionId: string };
    await manager.queueSessionMessage(service.serviceId, created.sessionId, "needs approval");
    await vi.waitFor(() => expect(manager.listPendingInteractions(service.serviceId)).toHaveLength(1));

    await fetch(`${service.webUrl}/test/disconnect?resolve=true`, { method: "POST" });
    await vi.waitFor(() => expect(manager.listServices()[0]).toMatchObject({ controlConnected: true }));
    await vi.waitFor(() => expect(manager.listPendingInteractions(service.serviceId)).toEqual([]));
  });

  it("reopens persisted sessions after restarting the workspace service", async () => {
    const firstService = await manager.startService({ workspace });
    const created = await manager.createSession(firstService.serviceId) as { sessionId: string };
    const queued = await manager.queueSessionMessage(firstService.serviceId, created.sessionId, "persisted") as { afterSeq: number };
    await manager.waitSession(firstService.serviceId, created.sessionId, queued.afterSeq, 2_000);
    await manager.close();
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

    const secondService = await manager.startService({ workspace });
    expect(secondService.serviceId).not.toBe(firstService.serviceId);
    expect(await manager.listSessions(secondService.serviceId)).toMatchObject({
      items: [expect.objectContaining({ sessionId: created.sessionId })],
    });
    expect(await manager.readSession(secondService.serviceId, created.sessionId)).toMatchObject({ events: expect.any(Array) });
  });

  it("rejects relative and out-of-policy workspaces", async () => {
    await expect(manager.startService({ workspace: "." })).rejects.toThrow("absolute path");
    const outside = await mkdtemp(join(tmpdir(), "deepseek-harness-outside-"));
    try {
      await expect(manager.startService({ workspace: outside })).rejects.toThrow("outside DSH_MCP_WORKSPACE_ROOTS");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
