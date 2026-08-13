import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inspectRuntime } from "./runtime.js";
import { RunManager } from "./run-manager.js";

const runIdSchema = z.string().uuid().describe("Run identifier returned by start_run.");
const cursorSchema = z.number().int().nonnegative().optional();

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
    { name: "deepseek-harness-mcp", version: "0.1.0" },
    {
      instructions:
        "Start scoped coding tasks in a local DeepSeek Harness process. Poll with wait_run, inspect workspace changes independently, and use a fresh run for corrections.",
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
    "start_run",
    {
      title: "Start a local DeepSeek Harness run",
      description: "Start one fresh headless DeepSeek Harness process in an existing absolute workspace. The call returns immediately with a runId.",
      inputSchema: {
        task: z.string().min(1).max(100_000).describe("Complete implementation task, constraints, and acceptance checks for DeepSeek Harness."),
        workspace: z.string().min(1).describe("Absolute path of the repository DeepSeek Harness may inspect and modify."),
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
      description: "Return current state and output after optional stdout and stderr cursors without waiting.",
      inputSchema: {
        runId: runIdSchema,
        stdoutCursor: cursorSchema,
        stderrCursor: cursorSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(manager.get(input.runId, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "wait_run",
    {
      title: "Wait for DeepSeek Harness output",
      description: "Wait up to 30 seconds for completion, then return any output after the supplied cursors. Reuse the returned nextCursor values.",
      inputSchema: {
        runId: runIdSchema,
        timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
        stdoutCursor: cursorSchema,
        stderrCursor: cursorSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.wait(input.runId, input.timeoutMs, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "List local DeepSeek Harness runs",
      description: "List runs started by the current MCP server process without repeating retained output.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ runs: manager.list() }),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel a local DeepSeek Harness run",
      description: "Terminate a running DeepSeek Harness process tree. Completed runs are left unchanged.",
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
