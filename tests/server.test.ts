import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunManager } from "../src/run-manager.js";
import type { HarnessCommand } from "../src/runtime.js";
import { createMcpServer } from "../src/server.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");

describe("MCP server", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: RunManager;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deep-seek-harness-mcp-server-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    manager = new RunManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      commandFactory: ({ task, workspace: cwd }): HarnessCommand => ({
        command: process.execPath,
        args: [fixture, "success", task],
        cwd,
        env: { ...process.env },
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
      "cancel_run",
      "doctor",
      "get_run",
      "list_runs",
      "start_run",
      "wait_run",
    ]);
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
      exitCode: 0,
      stdout: { text: "completed:MCP task\n" },
    });
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
});
