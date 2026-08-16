import { describe, expect, it } from "vitest";
import { buildHarnessWebCommand } from "../src/runtime.js";

describe("Harness Web command", () => {
  it("installs the Harness package explicitly before invoking its dsh executable", () => {
    const command = buildHarnessWebCommand(
      { workspace: "/workspace", serviceHome: "/data/service" },
      {
        DSH_MCP_NPX_COMMAND: "test-npx",
        DSH_MCP_HARNESS_PACKAGE: "@deepseek-ai/dsh@test-version",
      },
    );

    expect(command.command).toBe("test-npx");
    expect(command.args).toEqual([
      "--yes",
      "--package=@deepseek-ai/dsh@test-version",
      "--",
      "dsh",
      "web",
      "--port",
      "0",
    ]);
  });
});
