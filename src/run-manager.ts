import { createHash, randomUUID } from "node:crypto";
import { realpath, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  buildHarnessWebCommand,
  resolveAllowedRoots,
  resolveDataDirectory,
  resolveProcessInvocation,
  type HarnessCommand,
} from "./runtime.js";
import { HarnessClient, type MuxRequest } from "./harness-client.js";
import type {
  HarnessQuestionAnswer,
  PendingInteraction,
  RunSnapshot,
  RunStatus,
  ServiceSnapshot,
  ServiceStatus,
  SessionQueueSnapshot,
  StartRunInput,
  StartServiceInput,
  WaitReason,
} from "./types.js";

const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 120_000;
const CANCEL_GRACE_MS = 5_000;
const MAX_LOG_CHARACTERS = 100_000;
const MAX_HISTORY_MESSAGES = 100;
const CONTROL_RECONNECT_MAX_MS = 2_000;

interface ServiceRecord {
  serviceId: string;
  workspace: string;
  status: ServiceStatus;
  webUrl: string | null;
  browserOpened: boolean;
  browserError: string | null;
  startedAt: Date;
  stoppedAt: Date | null;
  child: ChildProcess;
  log: string;
  client: HarnessClient | null;
  harnessVersion: string | null;
  controlConnected: boolean;
  controlError: string | null;
  controlAbort: AbortController | null;
  controlTask: Promise<void> | null;
  queues: Map<string, { observed: boolean; items: unknown[] }>;
  pendingInteractions: Map<string, PendingInteraction>;
  submittingInteractions: Set<string>;
}

interface RunRecord {
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  startEventSeq: number;
  task: string;
  workspace: string;
  webUrl: string;
  status: RunStatus;
  cancelRequested: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  assistantText: string;
  lastEventSeq: number;
  error: string | null;
}

interface SessionSummary {
  sessionId: string;
  running: boolean;
  blank: boolean;
}

interface HistoryEvent {
  event: { type: string; seq: number; data: unknown };
  view?: unknown;
}

interface HistoryResult {
  events: HistoryEvent[];
  hasMore: boolean;
  projections?: unknown;
}

interface SubagentEntry {
  kind: "child" | "diagnostic";
  id: string;
  mode?: "one-shot" | "continuable";
  [key: string]: unknown;
}

/** Options for replacing process, browser, and Web command creation in tests. */
export interface RunManagerOptions {
  dataDirectory?: string;
  allowedRoots?: string[];
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  commandFactory?: (input: { workspace: string; serviceHome: string }) => HarnessCommand;
  spawnProcess?: (command: HarnessCommand) => ChildProcess;
  openBrowser?: (url: string) => Promise<void>;
}

function defaultSpawnProcess(command: HarnessCommand): ChildProcess {
  const invocation = resolveProcessInvocation(command.command, command.args, command.env);
  return spawn(invocation.command, invocation.args, {
    cwd: command.cwd,
    env: command.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${String(code)}`)));
  });
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : null;
}

function assistantText(events: HistoryEvent[]): string {
  const blocks: string[] = [];
  for (const { event } of events) {
    if (event.type !== "assistant/message" || typeof event.data !== "object" || event.data === null) continue;
    const message = (event.data as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") blocks.push(text);
      }
    }
  }
  return blocks.join("\n");
}

/** Owns visible local Harness Web services and tasks submitted into their sessions. */
export class RunManager {
  private readonly services = new Map<string, ServiceRecord>();
  private readonly serviceByWorkspace = new Map<string, string>();
  private readonly starts = new Map<string, Promise<ServiceRecord>>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly activeSessions = new Set<string>();
  private readonly dataDirectory: string;
  private readonly allowedRoots: string[];
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly commandFactory: NonNullable<RunManagerOptions["commandFactory"]>;
  private readonly spawnProcess: NonNullable<RunManagerOptions["spawnProcess"]>;
  private readonly openBrowserImpl: NonNullable<RunManagerOptions["openBrowser"]>;

  public constructor(options: RunManagerOptions = {}) {
    this.dataDirectory = resolve(options.dataDirectory ?? resolveDataDirectory());
    this.allowedRoots = (options.allowedRoots ?? resolveAllowedRoots()).map((root) => resolve(root));
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    this.commandFactory = options.commandFactory ?? ((input) => buildHarnessWebCommand(input));
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.openBrowserImpl = options.openBrowser ?? defaultOpenBrowser;
  }

  /** Starts or reuses the Harness Web service for an absolute workspace. */
  public async startService(input: StartServiceInput): Promise<ServiceSnapshot> {
    const workspace = await this.resolveWorkspace(input.workspace);
    let service = this.serviceForWorkspace(workspace);
    if (service === undefined) {
      const pending = this.starts.get(workspace) ?? this.launchService(workspace);
      this.starts.set(workspace, pending);
      try {
        service = await pending;
      } finally {
        this.starts.delete(workspace);
      }
    }
    if ((input.openBrowser ?? false) && service.webUrl !== null) {
      try {
        await this.openBrowserImpl(service.webUrl);
        service.browserOpened = true;
        service.browserError = null;
      } catch (error) {
        service.browserError = errorText(error);
      }
    }
    return this.serviceSnapshot(service);
  }

  /** Opens an already running service in the user's default browser. */
  public async openService(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.requireService(serviceId);
    if (service.status !== "running" || service.webUrl === null) throw new Error("Harness Web service is not running.");
    await this.openBrowserImpl(service.webUrl);
    service.browserOpened = true;
    service.browserError = null;
    return this.serviceSnapshot(service);
  }

  /** Lists services owned by the current MCP server. */
  public listServices(): ServiceSnapshot[] {
    return [...this.services.values()].map((service) => this.serviceSnapshot(service));
  }

  /** Creates an ordinary session in a running service's workspace. */
  public async createSession(serviceId: string, agentPreset?: string): Promise<object> {
    const service = this.requireRunningService(serviceId);
    const workspace = await this.call<{ workspace: { workspaceId: string } }>(service, "workspace.create", { path: service.workspace });
    const payload: { workspaceId: string; agentPreset?: string } = { workspaceId: workspace.workspace.workspaceId };
    if (agentPreset !== undefined) payload.agentPreset = agentPreset;
    return this.call<object>(service, "session.create", payload);
  }

  /** Lists all persisted ordinary sessions visible to a running service. */
  public async listSessions(serviceId: string): Promise<object> {
    return this.call<object>(this.requireRunningService(serviceId), "session.list", {});
  }

  /** Reads one raw, message-aligned history page with tool views and projections intact. */
  public async readSession(serviceId: string, sessionId: string, beforeSeq?: number, maxMessages = 20): Promise<object> {
    const payload: { sessionId: string; beforeSeq?: number; maxMessages: number } = {
      sessionId,
      maxMessages: Math.min(Math.max(maxMessages, 1), MAX_HISTORY_MESSAGES),
    };
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq;
    return this.call<object>(this.requireRunningService(serviceId), "session.history", payload);
  }

  /** Queues text for an ordinary session's next turn and returns the pre-call history cursor. */
  public async queueSessionMessage(serviceId: string, sessionId: string, text: string): Promise<object> {
    const service = this.requireRunningService(serviceId);
    const history = await this.call<HistoryResult>(service, "session.history", { sessionId, maxMessages: 1 });
    const afterSeq = history.events.reduce((highest, entry) => Math.max(highest, entry.event.seq), -1);
    const receipt = await this.call<object>(service, "session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
    return { ...receipt, afterSeq };
  }

  /** Steers only the currently active turn; Harness rejects idle sessions. */
  public async steerSession(serviceId: string, sessionId: string, text: string): Promise<object> {
    return this.call<object>(this.requireRunningService(serviceId), "session.prompt", {
      sessionId,
      mode: "steer",
      content: [{ type: "text", text }],
    });
  }

  /** Waits for a turn boundary, pending interaction, service failure, or timeout. */
  public async waitSession(serviceId: string, sessionId: string, afterSeq: number, timeoutMs: number): Promise<object> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 30_000);
    while (true) {
      const service = this.requireService(serviceId);
      if (service.status !== "running") {
        return { serviceId, sessionId, afterSeq, events: [], pendingInteractions: [], waitReason: "service-failed" satisfies WaitReason };
      }
      const pendingInteractions = this.pendingForSession(service, sessionId);
      if (pendingInteractions.length > 0) {
        const history = await this.historyAfter(service, sessionId, afterSeq);
        return { serviceId, sessionId, afterSeq, ...history, pendingInteractions, waitReason: "attention" satisfies WaitReason };
      }
      const [list, history] = await Promise.all([
        this.call<{ items: SessionSummary[] }>(service, "session.list", {}),
        this.historyAfter(service, sessionId, afterSeq),
      ]);
      const summary = list.items.find((item) => item.sessionId === sessionId);
      if (summary === undefined) throw new Error(`Unknown sessionId: ${sessionId}`);
      const agentFailed = history.events.some((entry) => entry.event.type === "agent/error");
      const turnEnded = history.events.some((entry) => entry.event.type === "turn/end");
      if (agentFailed) {
        return { serviceId, sessionId, afterSeq, ...history, pendingInteractions: [], waitReason: "service-failed" satisfies WaitReason };
      }
      if (turnEnded || (!summary.running && history.events.length > 0)) {
        return { serviceId, sessionId, afterSeq, ...history, pendingInteractions: [], waitReason: "complete" satisfies WaitReason };
      }
      if (Date.now() >= deadline) {
        return { serviceId, sessionId, afterSeq, ...history, pendingInteractions: [], waitReason: "timeout" satisfies WaitReason };
      }
      await this.pause(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  /** Cancels an ordinary session's active turn without stopping its Web service. */
  public async cancelSession(serviceId: string, sessionId: string): Promise<object> {
    return this.call<object>(this.requireRunningService(serviceId), "session.cancel", { sessionId });
  }

  /** Forks an ordinary session at a completed-turn boundary. */
  public async forkSession(serviceId: string, sessionId: string, atSeq?: number): Promise<object> {
    const payload: { sessionId: string; atSeq?: number } = { sessionId };
    if (atSeq !== undefined) payload.atSeq = atSeq;
    return this.call<object>(this.requireRunningService(serviceId), "session.fork", payload);
  }

  /** Returns the most recent authoritative Mux queue snapshot. */
  public readSessionQueue(serviceId: string, sessionId: string): SessionQueueSnapshot {
    const service = this.requireRunningService(serviceId);
    const queue = service.queues.get(sessionId);
    return { serviceId, sessionId, observed: queue?.observed ?? false, items: [...(queue?.items ?? [])] };
  }

  /** Edits one pending queued message. */
  public async editQueuedMessage(serviceId: string, sessionId: string, itemId: string, text: string): Promise<object> {
    return this.updateQueue(serviceId, sessionId, itemId, { kind: "edit", content: [{ type: "text", text }] });
  }

  /** Removes one pending queued message. */
  public async removeQueuedMessage(serviceId: string, sessionId: string, itemId: string): Promise<object> {
    return this.updateQueue(serviceId, sessionId, itemId, { kind: "remove" });
  }

  /** Changes one queued message to strict steering placement. */
  public async steerQueuedMessage(serviceId: string, sessionId: string, itemId: string): Promise<object> {
    return this.updateQueue(serviceId, sessionId, itemId, { kind: "steer" });
  }

  /** Lists durable direct children of one parent session. */
  public async listSubagents(serviceId: string, parentSessionId: string): Promise<object> {
    return this.call<object>(this.requireRunningService(serviceId), "subagent.list", { parentSessionId });
  }

  /** Reads one direct child's raw paginated history after resolving its durable mode. */
  public async readSubagent(serviceId: string, parentSessionId: string, childSessionId: string, beforeSeq?: number, maxMessages = 20): Promise<object> {
    const service = this.requireRunningService(serviceId);
    const child = await this.requireSubagent(service, parentSessionId, childSessionId);
    const payload: { parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable"; beforeSeq?: number; maxMessages: number } = {
      parentSessionId,
      childSessionId,
      mode: child.mode,
      maxMessages: Math.min(Math.max(maxMessages, 1), MAX_HISTORY_MESSAGES),
    };
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq;
    return this.call<object>(service, "subagent.history", payload);
  }

  /** Delivers text only to a continuable direct child. */
  public async sendSubagentMessage(serviceId: string, parentSessionId: string, childSessionId: string, text: string): Promise<object> {
    const service = this.requireRunningService(serviceId);
    await this.requireContinuableSubagent(service, parentSessionId, childSessionId);
    return this.call<object>(service, "subagent.prompt", {
      parentSessionId,
      childSessionId,
      mode: "continuable",
      content: [{ type: "text", text }],
    });
  }

  /** Interrupts a live continuable child; one-shot children are never targeted. */
  public async interruptSubagent(serviceId: string, parentSessionId: string, childSessionId: string): Promise<object> {
    const service = this.requireRunningService(serviceId);
    await this.requireContinuableSubagent(service, parentSessionId, childSessionId);
    return this.call<object>(service, "subagent.interrupt", { parentSessionId, childSessionId, mode: "continuable" });
  }

  /** Lists pending approval and question requests replayed by the service Mux stream. */
  public listPendingInteractions(serviceId: string, sessionId?: string): PendingInteraction[] {
    const service = this.requireRunningService(serviceId);
    const interactions = [...service.pendingInteractions.values()];
    return sessionId === undefined ? interactions : interactions.filter((interaction) => interaction.sessionId === sessionId);
  }

  /** Submits an explicit one-time approval and waits for a later resolved frame to remove it. */
  public async approveHarnessAction(serviceId: string, sessionId: string, approvalId: string): Promise<PendingInteraction> {
    return this.respondToApproval(serviceId, sessionId, approvalId, "allowed-once");
  }

  /** Rejects one pending Harness approval. */
  public async rejectHarnessAction(serviceId: string, sessionId: string, approvalId: string): Promise<PendingInteraction> {
    return this.respondToApproval(serviceId, sessionId, approvalId, "rejected");
  }

  /** Answers one pending Harness question batch. */
  public async answerHarnessQuestion(serviceId: string, sessionId: string, rpcId: string, answers: HarnessQuestionAnswer[]): Promise<PendingInteraction> {
    const service = this.requireRunningService(serviceId);
    const key = `question:${rpcId}`;
    const interaction = service.pendingInteractions.get(key);
    if (interaction?.kind !== "question" || interaction.sessionId !== sessionId || interaction.responseSubmitted || service.submittingInteractions.has(key)) {
      throw new Error(`not-pending: Harness question ${rpcId} is not awaiting a response.`);
    }
    service.submittingInteractions.add(key);
    try {
      await this.requireClient(service).respond(rpcId, { sessionId, answer: { answers } });
      const submitted = { ...interaction, responseSubmitted: true };
      if (service.pendingInteractions.get(key)?.rpcId === rpcId) service.pendingInteractions.set(key, submitted);
      return submitted;
    } finally {
      service.submittingInteractions.delete(key);
    }
  }

  /** Stops one Web service and its active sessions. */
  public async stopService(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.requireService(serviceId);
    if (service.status === "running" || service.status === "starting") {
      for (const run of this.runs.values()) {
        if (run.serviceId === serviceId && run.status === "running") await this.cancel(run.runId);
      }
      await this.terminate(service);
    }
    return this.serviceSnapshot(service);
  }

  /** Starts or continues a Web session and submits the task through Harness RPC. */
  public async start(input: StartRunInput): Promise<RunSnapshot> {
    const task = input.task.trim();
    if (!task) throw new Error("task must not be empty.");
    if (task.length > 100_000) throw new Error("task exceeds the 100,000 character limit.");
    const serviceSnapshot = await this.startService({ workspace: input.workspace, openBrowser: false });
    if (serviceSnapshot.webUrl === null) throw new Error("Harness Web service did not provide a URL.");
    const service = this.requireService(serviceSnapshot.serviceId);
    const workspaceResult = await this.call<{ workspace: { workspaceId: string } }>(service, "workspace.create", { path: service.workspace });
    const requestedSessionId = input.sessionId?.trim();
    let sessionId: string;
    let startEventSeq = -1;
    if (requestedSessionId === undefined || requestedSessionId === "") {
      const session = await this.call<{ sessionId: string }>(service, "session.create", {
        workspaceId: workspaceResult.workspace.workspaceId,
      });
      sessionId = session.sessionId;
    } else {
      const [list, history] = await Promise.all([
        this.call<{ items: SessionSummary[] }>(service, "session.list", {}),
        this.call<HistoryResult>(service, "session.history", { sessionId: requestedSessionId, maxMessages: 50 }),
      ]);
      const summary = list.items.find((item) => item.sessionId === requestedSessionId);
      if (summary === undefined) throw new Error(`Unknown sessionId for this workspace: ${requestedSessionId}`);
      if (summary.running) throw new Error(`Harness session is still running: ${requestedSessionId}`);
      sessionId = requestedSessionId;
      startEventSeq = history.events.reduce((highest, entry) => Math.max(highest, entry.event.seq), -1);
    }
    const activeSessionKey = `${service.serviceId}:${sessionId}`;
    if (this.activeSessions.has(activeSessionKey)) throw new Error(`Harness session already has an active MCP run: ${sessionId}`);
    this.activeSessions.add(activeSessionKey);
    try {
      await this.call<{ accepted: true }>(service, "session.prompt", {
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: task }],
      });
    } catch (error) {
      this.activeSessions.delete(activeSessionKey);
      throw error;
    }
    if (input.openBrowser ?? false) {
      try {
        await this.openService(service.serviceId);
      } catch (error) {
        service.browserError = errorText(error);
      }
    }
    const run: RunRecord = {
      runId: randomUUID(),
      serviceId: service.serviceId,
      sessionId,
      sessionReused: requestedSessionId !== undefined && requestedSessionId !== "",
      startEventSeq,
      task,
      workspace: service.workspace,
      webUrl: serviceSnapshot.webUrl,
      status: "running",
      cancelRequested: false,
      startedAt: new Date(),
      finishedAt: null,
      assistantText: "",
      lastEventSeq: startEventSeq,
      error: null,
    };
    this.runs.set(run.runId, run);
    return this.refresh(run);
  }

  /** Lists runs and refreshes their observable Web session state. */
  public async list(): Promise<RunSnapshot[]> {
    return Promise.all([...this.runs.values()].map(async (run) => this.refresh(run)));
  }

  /** Reads a run from the same Web session shown to the user. */
  public async get(runId: string): Promise<RunSnapshot> {
    return this.refresh(this.requireRun(runId));
  }

  /** Polls the Web session for up to 30 seconds. */
  public async wait(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    const run = this.requireRun(runId);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 30_000);
    let snapshot = await this.refresh(run);
    while (snapshot.status === "running" && snapshot.pendingInteractions.length === 0 && Date.now() < deadline) {
      await this.pause(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
      snapshot = await this.refresh(run);
    }
    const waitReason: WaitReason = snapshot.pendingInteractions.length > 0
      ? "attention"
      : snapshot.status === "running" ? "timeout" : "complete";
    return { ...snapshot, waitReason };
  }

  /** Cancels the Harness agent turn without stopping the visible Web service. */
  public async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.requireRun(runId);
    if (run.status === "running") {
      run.cancelRequested = true;
      const service = this.requireService(run.serviceId);
      await this.call<{ accepted: true }>(service, "session.cancel", { sessionId: run.sessionId });
    }
    return this.refresh(run);
  }

  /** Stops all Web services before the MCP server exits. */
  public async close(): Promise<void> {
    await Promise.all([...this.services.values()].map(async (service) => {
      if (service.status === "running" || service.status === "starting") await this.terminate(service);
    }));
  }

  private async launchService(workspace: string): Promise<ServiceRecord> {
    const serviceId = randomUUID();
    const workspaceKey = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
    const serviceHome = join(this.dataDirectory, "services", workspaceKey);
    await mkdir(serviceHome, { recursive: true, mode: 0o700 });
    const command = this.commandFactory({ workspace, serviceHome });
    const child = this.spawnProcess(command);
    const service: ServiceRecord = {
      serviceId,
      workspace,
      status: "starting",
      webUrl: null,
      browserOpened: false,
      browserError: null,
      startedAt: new Date(),
      stoppedAt: null,
      child,
      log: "",
      client: null,
      harnessVersion: null,
      controlConnected: false,
      controlError: null,
      controlAbort: null,
      controlTask: null,
      queues: new Map(),
      pendingInteractions: new Map(),
      submittingInteractions: new Set(),
    };
    this.services.set(serviceId, service);
    this.serviceByWorkspace.set(workspace, serviceId);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Harness Web service did not become ready within ${String(this.startupTimeoutMs)}ms.`)), this.startupTimeoutMs);
      const onChunk = (chunk: string): void => {
        service.log = `${service.log}${chunk}`.slice(-MAX_LOG_CHARACTERS);
        const url = READY_PATTERN.exec(service.log)?.[1];
        if (url !== undefined && service.status === "starting" && service.webUrl === null) {
          clearTimeout(timer);
          service.webUrl = url;
          resolveReady();
        }
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.once("error", (error) => {
        clearTimeout(timer);
        service.status = "failed";
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        service.stoppedAt = new Date();
        service.controlAbort?.abort();
        if (service.status === "starting") {
          service.status = "failed";
          reject(new Error(`Harness Web service exited before readiness (code ${String(code)}, signal ${String(signal)}). ${service.log}`));
        } else if (service.status === "running") {
          service.status = code === 0 ? "stopped" : "failed";
          service.controlConnected = false;
        }
      });
    });
    try {
      await ready;
      if (service.webUrl === null) throw new Error("Harness Web service did not provide a URL.");
      service.client = new HarnessClient(service.webUrl);
      const description = await service.client.rpc<{ version: string }>("host.describe", {});
      service.harnessVersion = description.version;
      await this.startControl(service);
      if (service.child.exitCode !== null || service.status === "failed") {
        throw new Error("Harness Web service exited while its control stream was connecting.");
      }
      service.status = "running";
      return service;
    } catch (error) {
      this.serviceByWorkspace.delete(workspace);
      if (child.exitCode === null) await this.terminate(service);
      service.status = "failed";
      throw error;
    }
  }

  private async refresh(run: RunRecord): Promise<RunSnapshot> {
    if (run.status !== "running") return this.runSnapshot(run);
    const service = this.requireService(run.serviceId);
    if (service.status !== "running") {
      run.status = "failed";
      run.error = "Harness Web service stopped before the task completed.";
      run.finishedAt = new Date();
      this.releaseSession(run);
      return this.runSnapshot(run);
    }
    try {
      const [list, history] = await Promise.all([
        this.call<{ items: SessionSummary[] }>(service, "session.list", {}),
        this.historyAfter(service, run.sessionId, run.startEventSeq),
      ]);
      const summary = list.items.find((item) => item.sessionId === run.sessionId);
      const events = history.events.filter((entry) => entry.event.seq > run.startEventSeq);
      run.lastEventSeq = events.reduce((highest, entry) => Math.max(highest, entry.event.seq), run.lastEventSeq);
      run.assistantText = assistantText(events);
      const agentError = [...events].reverse().find((entry) => entry.event.type === "agent/error");
      const turnEnded = events.some((entry) => entry.event.type === "turn/end");
      if (agentError !== undefined) {
        run.status = "failed";
        run.error = recordText(agentError.event.data) ?? "DeepSeek Harness reported an agent error.";
        run.finishedAt = new Date();
      } else if (run.cancelRequested && (summary === undefined || !summary.running)) {
        run.status = "cancelled";
        run.finishedAt = new Date();
      } else if (turnEnded && (summary === undefined || !summary.running)) {
        run.status = "succeeded";
        run.finishedAt = new Date();
      }
      if (run.status !== "running") this.releaseSession(run);
    } catch (error) {
      run.error = errorText(error);
    }
    return this.runSnapshot(run);
  }

  private async call<T>(service: ServiceRecord, method: string, payload: unknown): Promise<T> {
    return this.requireClient(service).rpc<T>(method, payload);
  }

  private async startControl(service: ServiceRecord): Promise<void> {
    const controller = new AbortController();
    service.controlAbort = controller;
    let resolveOpen: (() => void) | undefined;
    const firstOpen = new Promise<void>((resolvePromise) => { resolveOpen = resolvePromise; });
    service.controlTask = this.monitorControl(service, controller.signal, () => resolveOpen?.());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        firstOpen,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Harness control stream did not connect within ${String(this.startupTimeoutMs)}ms.`)),
            this.startupTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      controller.abort();
      await service.controlTask;
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async monitorControl(service: ServiceRecord, signal: AbortSignal, onFirstOpen: () => void): Promise<void> {
    let delayMs = 100;
    let opened = false;
    while (!signal.aborted) {
      service.queues.clear();
      service.pendingInteractions.clear();
      try {
        await this.requireClient(service).readMux(
          signal,
          () => {
            service.controlConnected = true;
            service.controlError = null;
            delayMs = 100;
            if (!opened) {
              opened = true;
              onFirstOpen();
            }
          },
          (request) => this.acceptMuxFrame(service, request),
        );
        if (!signal.aborted) throw new Error("Harness control stream closed.");
      } catch (error) {
        if (signal.aborted) return;
        service.controlConnected = false;
        service.controlError = errorText(error);
        service.queues.clear();
        service.pendingInteractions.clear();
        await this.pauseUntilAbort(delayMs, signal);
        delayMs = Math.min(delayMs * 2, CONTROL_RECONNECT_MAX_MS);
      }
    }
  }

  private acceptMuxFrame(service: ServiceRecord, request: MuxRequest): void {
    const frame = request.payload;
    switch (frame.type) {
      case "session/subscribed":
        service.queues.set(frame.sessionId, { observed: true, items: [] });
        return;
      case "session/queue":
        service.queues.set(frame.sessionId, { observed: true, items: frame.items });
        return;
      case "approval/requested": {
        const interaction: PendingInteraction = {
          kind: "approval",
          rpcId: request.rpcId,
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          responseSubmitted: false,
        };
        if (frame.callId !== undefined) interaction.callId = frame.callId;
        if (frame.reason !== undefined) interaction.reason = frame.reason;
        service.pendingInteractions.set(`approval:${frame.approvalId}`, interaction);
        return;
      }
      case "approval/resolved":
        service.pendingInteractions.delete(`approval:${frame.approvalId}`);
        return;
      case "question/requested":
        service.pendingInteractions.set(`question:${request.rpcId}`, {
          kind: "question",
          rpcId: request.rpcId,
          sessionId: frame.sessionId,
          questions: frame.questions,
          responseSubmitted: false,
        });
        return;
      case "question/resolved":
        service.pendingInteractions.delete(`question:${frame.questionRpcId}`);
        return;
      default:
        return;
    }
  }

  private async historyAfter(service: ServiceRecord, sessionId: string, afterSeq: number): Promise<HistoryResult> {
    const tail = await this.call<HistoryResult>(service, "session.history", { sessionId, maxMessages: MAX_HISTORY_MESSAGES });
    let events = tail.events;
    let hasMore = tail.hasMore;
    let firstSeq = events[0]?.event.seq;
    while (hasMore && firstSeq !== undefined && firstSeq > afterSeq + 1) {
      const older = await this.call<HistoryResult>(service, "session.history", {
        sessionId,
        beforeSeq: firstSeq,
        maxMessages: MAX_HISTORY_MESSAGES,
      });
      if (older.events.length === 0) break;
      events = [...older.events, ...events];
      hasMore = older.hasMore;
      firstSeq = events[0]?.event.seq;
    }
    return { ...tail, hasMore, events: events.filter((entry) => entry.event.seq > afterSeq) };
  }

  private pendingForSession(service: ServiceRecord, sessionId: string): PendingInteraction[] {
    return [...service.pendingInteractions.values()].filter((interaction) => interaction.sessionId === sessionId);
  }

  private async updateQueue(serviceId: string, sessionId: string, itemId: string, action: object): Promise<object> {
    return this.call<object>(this.requireRunningService(serviceId), "session.updateQueue", { sessionId, itemId, action });
  }

  private async requireSubagent(service: ServiceRecord, parentSessionId: string, childSessionId: string): Promise<{ mode: "one-shot" | "continuable" }> {
    const catalog = await this.call<{ entries: SubagentEntry[] }>(service, "subagent.list", { parentSessionId });
    const child = catalog.entries.find((entry) => entry.kind === "child" && entry.id === childSessionId);
    if (child === undefined || child.kind !== "child" || child.mode === undefined) {
      throw new Error(`Unknown or unavailable subagent: ${childSessionId}`);
    }
    return { mode: child.mode };
  }

  private async requireContinuableSubagent(service: ServiceRecord, parentSessionId: string, childSessionId: string): Promise<void> {
    const child = await this.requireSubagent(service, parentSessionId, childSessionId);
    if (child.mode !== "continuable") throw new Error(`Subagent ${childSessionId} is one-shot and cannot be controlled.`);
  }

  private async respondToApproval(
    serviceId: string,
    sessionId: string,
    approvalId: string,
    outcome: "allowed-once" | "rejected",
  ): Promise<PendingInteraction> {
    const service = this.requireRunningService(serviceId);
    const key = `approval:${approvalId}`;
    const interaction = service.pendingInteractions.get(key);
    if (interaction?.kind !== "approval" || interaction.sessionId !== sessionId || interaction.responseSubmitted || service.submittingInteractions.has(key)) {
      throw new Error(`not-pending: Harness approval ${approvalId} is not awaiting a response.`);
    }
    service.submittingInteractions.add(key);
    try {
      await this.requireClient(service).respond(interaction.rpcId, { sessionId, approvalId, outcome });
      const submitted = { ...interaction, responseSubmitted: true };
      if (service.pendingInteractions.get(key)?.rpcId === interaction.rpcId) service.pendingInteractions.set(key, submitted);
      return submitted;
    } finally {
      service.submittingInteractions.delete(key);
    }
  }

  private requireClient(service: ServiceRecord): HarnessClient {
    if (service.client === null) throw new Error("Harness Web control client is not initialized.");
    return service.client;
  }

  private requireRunningService(serviceId: string): ServiceRecord {
    const service = this.requireService(serviceId);
    if (service.status !== "running" || !service.controlConnected) {
      throw new Error(`Harness Web service control is unavailable: ${service.controlError ?? service.status}`);
    }
    return service;
  }

  private async pause(milliseconds: number): Promise<void> {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  }

  private async pauseUntilAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async resolveWorkspace(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("workspace must be an absolute path.");
    const workspace = await realpath(input);
    if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must point to a directory.");
    if (this.allowedRoots.length > 0) {
      const roots = await Promise.all(this.allowedRoots.map(async (root) => realpath(root)));
      if (!roots.some((root) => isWithin(root, workspace))) throw new Error("workspace is outside DSH_MCP_WORKSPACE_ROOTS.");
    }
    return workspace;
  }

  private serviceForWorkspace(workspace: string): ServiceRecord | undefined {
    const id = this.serviceByWorkspace.get(workspace);
    const service = id === undefined ? undefined : this.services.get(id);
    return service?.status === "running" ? service : undefined;
  }

  private requireService(serviceId: string): ServiceRecord {
    const service = this.services.get(serviceId);
    if (service === undefined) throw new Error(`Unknown serviceId: ${serviceId}`);
    return service;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`Unknown runId: ${runId}`);
    return run;
  }

  private releaseSession(run: RunRecord): void {
    this.activeSessions.delete(`${run.serviceId}:${run.sessionId}`);
  }

  private async terminate(service: ServiceRecord): Promise<void> {
    service.controlAbort?.abort();
    await service.controlTask;
    service.controlConnected = false;
    service.queues.clear();
    service.pendingInteractions.clear();
    service.submittingInteractions.clear();
    if (service.child.exitCode !== null) {
      service.status = service.status === "failed" ? "failed" : "stopped";
      this.serviceByWorkspace.delete(service.workspace);
      return;
    }
    const closed = new Promise<void>((resolveClose) => service.child.once("close", () => resolveClose()));
    if (process.platform !== "win32" && service.child.pid !== undefined) {
      try { process.kill(-service.child.pid, "SIGTERM"); } catch { service.child.kill("SIGTERM"); }
    } else {
      service.child.kill("SIGTERM");
    }
    await Promise.race([closed, new Promise<void>((resolveWait) => setTimeout(resolveWait, CANCEL_GRACE_MS))]);
    if (service.child.exitCode === null) service.child.kill("SIGKILL");
    service.status = "stopped";
    service.stoppedAt = new Date();
    this.serviceByWorkspace.delete(service.workspace);
  }

  private serviceSnapshot(service: ServiceRecord): ServiceSnapshot {
    return {
      serviceId: service.serviceId,
      workspace: service.workspace,
      status: service.status,
      webUrl: service.webUrl,
      browserOpened: service.browserOpened,
      browserError: service.browserError,
      harnessVersion: service.harnessVersion,
      controlConnected: service.controlConnected,
      controlError: service.controlError,
      startedAt: service.startedAt.toISOString(),
      stoppedAt: service.stoppedAt?.toISOString() ?? null,
      processId: service.child.pid ?? null,
      logTail: service.log.slice(-4_000),
    };
  }

  private runSnapshot(run: RunRecord): RunSnapshot {
    return {
      runId: run.runId,
      serviceId: run.serviceId,
      sessionId: run.sessionId,
      sessionReused: run.sessionReused,
      task: run.task,
      workspace: run.workspace,
      webUrl: run.webUrl,
      status: run.status,
      cancelRequested: run.cancelRequested,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      assistantText: run.assistantText,
      lastEventSeq: run.lastEventSeq,
      error: run.error,
      pendingInteractions: this.pendingForSession(this.requireService(run.serviceId), run.sessionId),
    };
  }
}
