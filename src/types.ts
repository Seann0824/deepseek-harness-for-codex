/** Lifecycle state for one locally launched DeepSeek Harness process. */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** A bounded output delta and the cursor for the next read. */
export interface OutputDelta {
  text: string;
  nextCursor: number;
  retainedFromCursor: number;
  truncated: boolean;
}

/** Public state returned to MCP clients for a delegated run. */
export interface RunSnapshot {
  runId: string;
  task: string;
  workspace: string;
  status: RunStatus;
  cancelRequested: boolean;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: OutputDelta;
  stderr: OutputDelta;
}

/** Inputs needed to start a local Harness task. */
export interface StartRunInput {
  task: string;
  workspace: string;
}

/** Optional output cursors used for incremental reads. */
export interface RunCursors {
  stdoutCursor?: number | undefined;
  stderrCursor?: number | undefined;
}
