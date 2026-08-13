import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { buildHarnessCommand, resolveAllowedRoots, resolveDataDirectory, type HarnessCommand } from "./runtime.js";
import type { OutputDelta, RunCursors, RunSnapshot, RunStatus, StartRunInput } from "./types.js";

const DEFAULT_MAX_RETAINED_CHARACTERS = 1_000_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;

interface RunRecord {
  runId: string;
  task: string;
  workspace: string;
  status: RunStatus;
  cancelRequested: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: RetainedOutput;
  stderr: RetainedOutput;
  child: ChildProcess;
  done: Promise<void>;
  resolveDone: () => void;
  killTimer?: NodeJS.Timeout;
}

/** Options for replacing process and command creation in tests or embedded use. */
export interface RunManagerOptions {
  dataDirectory?: string;
  allowedRoots?: string[];
  maxRetainedCharacters?: number;
  cancelGraceMs?: number;
  commandFactory?: (input: { task: string; workspace: string; runHome: string }) => HarnessCommand;
  spawnProcess?: (command: HarnessCommand) => ChildProcess;
}

class RetainedOutput {
  private text = "";
  private retainedFromCursor = 0;
  private nextCursor = 0;

  public constructor(private readonly maxCharacters: number) {}

  /** Appends output while keeping cursor offsets monotonic. */
  public append(chunk: string): void {
    this.text += chunk;
    this.nextCursor += chunk.length;
    if (this.text.length > this.maxCharacters) {
      const discarded = this.text.length - this.maxCharacters;
      this.text = this.text.slice(discarded);
      this.retainedFromCursor += discarded;
    }
  }

  /** Reads output after a cursor and reports whether older data was discarded. */
  public read(cursor?: number): OutputDelta {
    const requested = cursor ?? this.retainedFromCursor;
    const effective = Math.min(Math.max(requested, this.retainedFromCursor), this.nextCursor);
    return {
      text: this.text.slice(effective - this.retainedFromCursor),
      nextCursor: this.nextCursor,
      retainedFromCursor: this.retainedFromCursor,
      truncated: requested < this.retainedFromCursor,
    };
  }
}

function defaultSpawnProcess(command: HarnessCommand): ChildProcess {
  return spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function processError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Owns local DeepSeek Harness child processes for the lifetime of one MCP server. */
export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly dataDirectory: string;
  private readonly allowedRoots: string[];
  private readonly maxRetainedCharacters: number;
  private readonly cancelGraceMs: number;
  private readonly commandFactory: NonNullable<RunManagerOptions["commandFactory"]>;
  private readonly spawnProcess: NonNullable<RunManagerOptions["spawnProcess"]>;

  public constructor(options: RunManagerOptions = {}) {
    this.dataDirectory = resolve(options.dataDirectory ?? resolveDataDirectory());
    this.allowedRoots = (options.allowedRoots ?? resolveAllowedRoots()).map((root) => resolve(root));
    this.maxRetainedCharacters = options.maxRetainedCharacters ?? DEFAULT_MAX_RETAINED_CHARACTERS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.commandFactory = options.commandFactory ?? ((input) => buildHarnessCommand(input));
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  /** Starts one fresh headless Harness process in an existing absolute workspace. */
  public async start(input: StartRunInput): Promise<RunSnapshot> {
    const task = input.task.trim();
    if (!task) {
      throw new Error("task must not be empty.");
    }
    if (task.length > 100_000) {
      throw new Error("task exceeds the 100,000 character limit.");
    }
    const workspace = await this.resolveWorkspace(input.workspace);
    const runId = randomUUID();
    const runHome = join(this.dataDirectory, "runs", runId);
    await mkdir(runHome, { recursive: true, mode: 0o700 });
    const command = this.commandFactory({ task, workspace, runHome });
    const child = this.spawnProcess(command);

    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    const record: RunRecord = {
      runId,
      task,
      workspace,
      status: "running",
      cancelRequested: false,
      startedAt: new Date(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      stdout: new RetainedOutput(this.maxRetainedCharacters),
      stderr: new RetainedOutput(this.maxRetainedCharacters),
      child,
      done,
      resolveDone,
    };
    this.runs.set(runId, record);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => record.stdout.append(chunk));
    child.stderr?.on("data", (chunk: string) => record.stderr.append(chunk));
    child.once("error", (error) => {
      record.stderr.append(`${processError(error)}\n`);
      this.finish(record, null, null);
    });
    child.once("close", (exitCode, signal) => this.finish(record, exitCode, signal));

    return this.snapshot(record);
  }

  /** Lists current-process runs in newest-first order. */
  public list(): RunSnapshot[] {
    return [...this.runs.values()]
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
      .map((record) => this.snapshot(record, { stdoutCursor: Number.MAX_SAFE_INTEGER, stderrCursor: Number.MAX_SAFE_INTEGER }));
  }

  /** Reads run state and output after optional cursors. */
  public get(runId: string, cursors: RunCursors = {}): RunSnapshot {
    return this.snapshot(this.requireRun(runId), cursors);
  }

  /** Waits for completion or a bounded timeout, then returns incremental output. */
  public async wait(runId: string, timeoutMs: number, cursors: RunCursors = {}): Promise<RunSnapshot> {
    const record = this.requireRun(runId);
    const boundedTimeout = Math.min(Math.max(timeoutMs, 0), 30_000);
    if (record.status === "running" && boundedTimeout > 0) {
      await Promise.race([
        record.done,
        new Promise<void>((resolvePromise) => {
          const timer = setTimeout(resolvePromise, boundedTimeout);
          timer.unref();
        }),
      ]);
    }
    return this.snapshot(record, cursors);
  }

  /** Requests cancellation of a run and returns its latest state. */
  public async cancel(runId: string): Promise<RunSnapshot> {
    const record = this.requireRun(runId);
    if (record.status !== "running") {
      return this.snapshot(record);
    }
    record.cancelRequested = true;
    this.terminate(record, "SIGTERM");
    record.killTimer = setTimeout(() => {
      if (record.status === "running") {
        this.terminate(record, "SIGKILL");
      }
    }, this.cancelGraceMs);
    record.killTimer.unref();
    await Promise.race([
      record.done,
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, Math.min(this.cancelGraceMs, 1_000));
        timer.unref();
      }),
    ]);
    return this.snapshot(record);
  }

  /** Cancels all active children before the MCP server exits. */
  public async close(): Promise<void> {
    const active = [...this.runs.values()].filter((record) => record.status === "running");
    await Promise.all(active.map(async (record) => this.cancel(record.runId)));
  }

  private async resolveWorkspace(input: string): Promise<string> {
    if (!isAbsolute(input)) {
      throw new Error("workspace must be an absolute path.");
    }
    const workspace = await realpath(input);
    const details = await stat(workspace);
    if (!details.isDirectory()) {
      throw new Error("workspace must point to a directory.");
    }
    if (this.allowedRoots.length > 0) {
      const roots = await Promise.all(this.allowedRoots.map(async (root) => realpath(root)));
      if (!roots.some((root) => isWithin(root, workspace))) {
        throw new Error("workspace is outside DSH_MCP_WORKSPACE_ROOTS.");
      }
    }
    return workspace;
  }

  private requireRun(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) {
      throw new Error(`Unknown runId: ${runId}`);
    }
    return record;
  }

  private finish(record: RunRecord, exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (record.status !== "running") {
      return;
    }
    if (record.killTimer) {
      clearTimeout(record.killTimer);
    }
    record.exitCode = exitCode;
    record.signal = signal;
    record.finishedAt = new Date();
    record.status = record.cancelRequested ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
    record.resolveDone();
  }

  private terminate(record: RunRecord, signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
      if (signal === "SIGKILL" && record.child.pid) {
        spawn("taskkill", ["/pid", String(record.child.pid), "/T", "/F"], {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
        return;
      }
      record.child.kill(signal === "SIGKILL" ? undefined : signal);
      return;
    }
    if (record.child.pid) {
      try {
        process.kill(-record.child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          record.stderr.append(`${processError(error)}\n`);
        }
      }
    }
    record.child.kill(signal);
  }

  private snapshot(record: RunRecord, cursors: RunCursors = {}): RunSnapshot {
    return {
      runId: record.runId,
      task: record.task,
      workspace: record.workspace,
      status: record.status,
      cancelRequested: record.cancelRequested,
      startedAt: record.startedAt.toISOString(),
      finishedAt: record.finishedAt?.toISOString() ?? null,
      exitCode: record.exitCode,
      signal: record.signal,
      stdout: record.stdout.read(cursors.stdoutCursor),
      stderr: record.stderr.read(cursors.stderrCursor),
    };
  }
}
