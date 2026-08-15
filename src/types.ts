/** Lifecycle state for one task submitted through the Harness Web service. */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** Lifecycle state for a local Harness Web service. */
export type ServiceStatus = "starting" | "running" | "stopped" | "failed";

/** Why a bounded wait returned control to its MCP caller. */
export type WaitReason = "complete" | "attention" | "service-failed" | "timeout";

/** One approval or question currently awaiting a human response. */
export type PendingInteraction = {
  kind: "approval";
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  responseSubmitted: boolean;
} | {
  kind: "question";
  rpcId: string;
  sessionId: string;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
    intent?: { kind: "plan-review"; approve: string };
  }>;
  responseSubmitted: boolean;
};

/** One answer supplied for a Harness question item. */
export interface HarnessQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string | undefined;
}

/** Authoritative transient queue state observed from the Mux stream. */
export interface SessionQueueSnapshot {
  serviceId: string;
  sessionId: string;
  observed: boolean;
  items: unknown[];
}

/** Public state of one local Harness Web service. */
export interface ServiceSnapshot {
  serviceId: string;
  workspace: string;
  status: ServiceStatus;
  webUrl: string | null;
  browserOpened: boolean;
  browserError: string | null;
  harnessVersion: string | null;
  controlConnected: boolean;
  controlError: string | null;
  startedAt: string;
  stoppedAt: string | null;
  processId: number | null;
  logTail: string;
}

/** Public state returned to MCP clients for one visible Web session task. */
export interface RunSnapshot {
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  task: string;
  workspace: string;
  webUrl: string;
  status: RunStatus;
  cancelRequested: boolean;
  startedAt: string;
  finishedAt: string | null;
  assistantText: string;
  lastEventSeq: number;
  error: string | null;
  pendingInteractions: PendingInteraction[];
  waitReason?: WaitReason;
}

/** Inputs needed to start a visible Harness task. */
export interface StartRunInput {
  task: string;
  workspace: string;
  sessionId?: string | undefined;
  openBrowser?: boolean | undefined;
}

/** Inputs needed to start or reuse a local Harness Web service. */
export interface StartServiceInput {
  workspace: string;
  openBrowser?: boolean | undefined;
}
