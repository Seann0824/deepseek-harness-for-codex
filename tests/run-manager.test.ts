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
      commandFactory: ({ workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture],
        cwd,
        env: { ...process.env },
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
    expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.browserOpened).toBe(true);
    expect(openBrowser).toHaveBeenCalledWith(service.webUrl);
    expect((await fetch(service.webUrl!)).status).toBe(200);
  });

  it("submits the task into the visible Web session", async () => {
    const started = await manager.start({ task: "implement feature", workspace, openBrowser: true });
    expect(started.status).toBe("running");
    expect(started.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started.sessionId).toBe("session-1");

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
    expect(openBrowser).toHaveBeenCalledTimes(2);
  });

  it("cancels a run but keeps its Web service alive", async () => {
    const started = await manager.start({ task: "long task", workspace, openBrowser: false });
    const cancelled = await manager.cancel(started.runId);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequested).toBe(true);
    expect(manager.listServices()[0]?.status).toBe("running");
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
