#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RunManager } from "./run-manager.js";
import { createMcpServer } from "./server.js";

const manager = new RunManager();
const server = createMcpServer(manager);
const transport = new StdioServerTransport();
let closing = false;

async function close(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  await manager.close();
  await server.close();
}

server.server.onclose = () => void manager.close();
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGHUP", () => void close());
process.once("beforeExit", () => void manager.close());

try {
  await server.connect(transport);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
