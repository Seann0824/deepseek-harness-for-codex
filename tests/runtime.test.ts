import { describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  buildHarnessWebCommand,
  inspectRuntime,
  resolveProcessInvocation,
  validateRuntimeEnvironment,
} from "../src/runtime.js";

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

  it("routes Windows .cmd launchers through cmd.exe without enabling a shell", () => {
    expect(resolveProcessInvocation(
      "npx.cmd",
      ["--yes", "--package=@deepseek-ai/dsh@version", "--", "dsh", "web"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    )).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npx.cmd", "--yes", "--package=@deepseek-ai/dsh@version", "--", "dsh", "web"],
    });
  });

  it("rejects newline-bearing launcher configuration before probing the environment", () => {
    expect(validateRuntimeEnvironment({ DSH_MCP_NPX_COMMAND: "npx.cmd\n--version" }, "win32")).toEqual([
      "DSH_MCP_NPX_COMMAND must be a command path without CMD control characters.",
    ]);

    const report = inspectRuntime({ DSH_MCP_NPX_COMMAND: "npx.cmd\n--version" }, "win32");
    expect(report).toMatchObject({
      ready: false,
      environmentValid: false,
      environmentIssues: ["DSH_MCP_NPX_COMMAND must be a command path without CMD control characters."],
      npxAvailable: false,
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects package specs that could be interpreted as CMD syntax", () => {
    expect(validateRuntimeEnvironment({ DSH_MCP_HARNESS_PACKAGE: "@scope/pkg&whoami" }, "win32")).toEqual([
      "DSH_MCP_HARNESS_PACKAGE must not contain CMD control characters.",
    ]);
    expect(() => buildHarnessWebCommand(
      { workspace: "/workspace", serviceHome: "/data/service" },
      { DSH_MCP_HARNESS_PACKAGE: "@scope/pkg&whoami" },
      "win32",
    )).toThrow("DSH_MCP_HARNESS_PACKAGE must not contain CMD control characters.");
  });

  it("reports a successful Windows npx probe through the configured command shell", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "11.17.0\n", stderr: "", error: undefined });

    const report = inspectRuntime({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");

    expect(report).toMatchObject({
      ready: true,
      environmentValid: true,
      npxAvailable: true,
      npxVersion: "11.17.0",
      npxCommand: "npx.cmd",
      npxLauncher: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "npx.cmd", "--version"],
      { encoding: "utf8", shell: false, timeout: 5_000 },
    );
  });
});
