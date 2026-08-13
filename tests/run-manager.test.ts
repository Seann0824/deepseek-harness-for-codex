import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunManager } from "../src/run-manager.js";
import type { HarnessCommand } from "../src/runtime.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");

describe("RunManager", () => {
  let temporaryRoot: string;
  let workspace: string;
  let managers: RunManager[];

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deep-seek-harness-mcp-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    managers = [];
  });

  afterEach(async () => {
    await Promise.all(managers.map(async (manager) => manager.close()));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function createManager(behavior: string, options: { maxRetainedCharacters?: number } = {}): RunManager {
    const manager = new RunManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      cancelGraceMs: 100,
      ...(options.maxRetainedCharacters === undefined
        ? {}
        : { maxRetainedCharacters: options.maxRetainedCharacters }),
      commandFactory: ({ task, workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture, behavior, task],
        cwd,
        env: { ...process.env },
      }),
    });
    managers.push(manager);
    return manager;
  }

  it("starts a local process and exposes incremental output", async () => {
    const manager = createManager("success");
    const started = await manager.start({ task: "implement feature", workspace });

    expect(started.status).toBe("running");
    const completed = await manager.wait(started.runId, 2_000);

    expect(completed.status).toBe("succeeded");
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout.text).toBe("completed:implement feature\n");
    expect(completed.stderr.text).toBe("diagnostic\n");
    expect(
      manager.get(started.runId, {
        stdoutCursor: completed.stdout.nextCursor,
        stderrCursor: completed.stderr.nextCursor,
      }).stdout.text,
    ).toBe("");
  });

  it("reports a failed process and its stderr", async () => {
    const manager = createManager("fail");
    const started = await manager.start({ task: "broken task", workspace });
    const completed = await manager.wait(started.runId, 2_000);

    expect(completed.status).toBe("failed");
    expect(completed.exitCode).toBe(7);
    expect(completed.stderr.text).toBe("failed:broken task\n");
  });

  it("cancels the detached process group", async () => {
    const manager = createManager("hang");
    const started = await manager.start({ task: "long task", workspace });
    await manager.wait(started.runId, 100);

    const cancelled = await manager.cancel(started.runId);

    expect(cancelled.cancelRequested).toBe(true);
    expect(cancelled.status).toBe("cancelled");
  });

  it("bounds retained output and marks an old cursor as truncated", async () => {
    const manager = createManager("large", { maxRetainedCharacters: 5 });
    const started = await manager.start({ task: "output", workspace });
    await manager.wait(started.runId, 2_000);

    const snapshot = manager.get(started.runId, { stdoutCursor: 0 });
    expect(snapshot.stdout).toEqual({
      text: "fghij",
      nextCursor: 10,
      retainedFromCursor: 5,
      truncated: true,
    });
  });

  it("rejects relative and out-of-policy workspaces", async () => {
    const manager = createManager("success");
    await expect(manager.start({ task: "task", workspace: "." })).rejects.toThrow("absolute path");

    const outside = await mkdtemp(join(tmpdir(), "deep-seek-harness-outside-"));
    try {
      await expect(manager.start({ task: "task", workspace: outside })).rejects.toThrow("outside DSH_MCP_WORKSPACE_ROOTS");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
