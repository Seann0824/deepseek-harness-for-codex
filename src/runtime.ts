import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const DEFAULT_HARNESS_PACKAGE = "@deepseek-ai/dsh@0.1.0-rc.6";
const DEFAULT_NPX_COMMAND = "npx";
const WINDOWS_NPX_COMMAND = "npx.cmd";
const WINDOWS_COMMAND_CONTROL_CHARACTERS = /[\r\n"&|<>^()%]/;

/** A child-process command after applying the host platform's launcher rules. */
export interface ProcessInvocation {
  command: string;
  args: string[];
}

/** A shell-free command specification for one local Harness process. */
export interface HarnessCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Values required to construct a local Harness Web command. */
export interface HarnessWebCommandInput {
  workspace: string;
  serviceHome: string;
}

/** Resolves the configured npx command for a host platform. */
export function resolveNpxCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.DSH_MCP_NPX_COMMAND?.trim();
  if (platform === "win32" && configured !== undefined && WINDOWS_COMMAND_CONTROL_CHARACTERS.test(configured)) {
    throw new Error("DSH_MCP_NPX_COMMAND must be a command path without CMD control characters.");
  }
  return configured || (platform === "win32" ? WINDOWS_NPX_COMMAND : DEFAULT_NPX_COMMAND);
}

/** Validates environment values that affect local Harness process startup. */
export function validateRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const issues: string[] = [];
  try {
    resolveNpxCommand(env, platform);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim();
  if (harnessPackage !== undefined) {
    if (harnessPackage.startsWith("-")) {
      issues.push("DSH_MCP_HARNESS_PACKAGE must be an npm package specifier, not an option.");
    } else if (platform === "win32" && WINDOWS_COMMAND_CONTROL_CHARACTERS.test(harnessPackage)) {
      issues.push("DSH_MCP_HARNESS_PACKAGE must not contain CMD control characters.");
    }
  }

  if (platform === "win32") {
    for (const [name, value] of [["ComSpec", env.ComSpec], ["Comspec", env.Comspec]] as const) {
      if (value !== undefined && WINDOWS_COMMAND_CONTROL_CHARACTERS.test(value)) {
        issues.push(`${name} must be a command path without CMD control characters.`);
      }
    }
  }
  return issues;
}

/** Applies the platform launcher while keeping Node's shell option disabled. */
export function resolveProcessInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ProcessInvocation {
  if (platform !== "win32") return { command, args };
  return { command: resolveWindowsShell(env), args: ["/d", "/s", "/c", command, ...args] };
}

function resolveWindowsShell(env: NodeJS.ProcessEnv): string {
  return env.ComSpec?.trim() || env.Comspec?.trim() || "cmd.exe";
}

/** Resolves the persistent data directory used for local Web service state. */
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_MCP_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim();
  return configured || join(homedir(), ".deep-seek-harness-mcp");
}

/** Resolves optional workspace roots that the MCP server may modify. */
export function resolveAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DSH_MCP_WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Builds the argv and environment for the published Harness Web UI. */
export function buildHarnessWebCommand(
  input: HarnessWebCommandInput,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HarnessCommand {
  const environmentIssues = validateRuntimeEnvironment(env, platform);
  if (environmentIssues.length > 0) {
    throw new Error(environmentIssues.join(" "));
  }
  const command = resolveNpxCommand(env, platform);
  const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE;

  return {
    command,
    args: ["--yes", `--package=${harnessPackage}`, "--", "dsh", "web", "--port", "0"],
    cwd: input.workspace,
    env: {
      ...env,
      DSH_CWD: input.workspace,
      DSH_HOME: input.serviceHome,
      DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE?.trim() || "workspace-write",
      DSH_TELEMETRY_DISABLED: env.DSH_TELEMETRY_DISABLED?.trim() || "1",
      NO_COLOR: "1",
      npm_config_yes: "true",
    },
  };
}

/** Returns local prerequisites without making a network request. */
export function inspectRuntime(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  const environmentIssues = validateRuntimeEnvironment(env, platform);
  let command = platform === "win32" ? WINDOWS_NPX_COMMAND : DEFAULT_NPX_COMMAND;
  try {
    command = resolveNpxCommand(env, platform);
  } catch {
    // The validation result below contains the actionable configuration error.
  }
  const invocation = resolveProcessInvocation(command, ["--version"], env, platform);
  const probe = environmentIssues.length === 0
    ? spawnSync(invocation.command, invocation.args, { encoding: "utf8", shell: false, timeout: 5_000 })
    : null;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const npxAvailable = probe?.status === 0;
  const npxVersion = npxAvailable && typeof probe?.stdout === "string" ? probe.stdout.trim() : null;
  const npxError = probe?.error instanceof Error
    ? probe.error.message
    : probe !== null && probe?.status !== 0
      ? (typeof probe?.stderr === "string" && probe.stderr.trim()) || `npx exited with code ${String(probe?.status)}.`
      : null;

  return {
    ready: nodeMajor >= 22 && environmentIssues.length === 0 && npxAvailable,
    environmentValid: environmentIssues.length === 0,
    environmentIssues,
    nodeVersion: process.versions.node,
    nodeSupported: nodeMajor >= 22,
    platform,
    architecture: process.arch,
    npxCommand: command,
    npxLauncher: invocation.command,
    npxAvailable,
    npxVersion,
    npxError,
    harnessPackage: env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE,
    apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    dataDirectory: resolveDataDirectory(env),
    allowedWorkspaceRoots: resolveAllowedRoots(env),
    surface: "web",
  };
}
