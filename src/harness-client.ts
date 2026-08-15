import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MuxFrame } from "@deepseek-ai/dsh-host-apiproxy/api";

const rpcErrorSchema = z.object({ code: z.string(), message: z.string() }).passthrough();
const responseSchema = z.object({
  type: z.literal("server-response"),
  rpcId: z.string(),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: rpcErrorSchema }),
  ]),
});
const receiptSchema = z.object({
  accepted: z.boolean(),
  reason: z.enum(["not-pending", "bad-response"]).optional(),
});
const muxEnvelopeSchema = z.object({
  type: z.literal("server-request"),
  rpcId: z.string(),
  payload: z.object({ type: z.string() }).passthrough(),
});
const historyEntrySchema = z.object({
  event: z.object({ type: z.string(), seq: z.number().int(), data: z.unknown() }).passthrough(),
  view: z.unknown().optional(),
}).passthrough();
const historySchema = z.object({
  events: z.array(historyEntrySchema),
  hasMore: z.boolean(),
  projections: z.unknown().optional(),
}).passthrough();
const acceptedSchema = z.object({ accepted: z.literal(true) }).passthrough();
const unaryValueSchemas: Record<string, z.ZodType> = {
  "host.describe": z.object({ version: z.string(), cwd: z.string(), attachedSessions: z.number().int(), canOpenPath: z.boolean() }).passthrough(),
  "workspace.create": z.object({ workspace: z.object({ workspaceId: z.string() }).passthrough(), created: z.boolean() }).passthrough(),
  "session.create": z.object({ sessionId: z.string(), agentPreset: z.string().optional() }).passthrough(),
  "session.list": z.object({ items: z.array(z.object({ sessionId: z.string(), running: z.boolean(), blank: z.boolean() }).passthrough()) }).passthrough(),
  "session.history": historySchema,
  "session.fork": z.object({ sessionId: z.string() }).passthrough(),
  "session.prompt": acceptedSchema,
  "session.updateQueue": acceptedSchema,
  "session.cancel": acceptedSchema,
  "subagent.list": z.object({
    entries: z.array(z.object({ kind: z.enum(["child", "diagnostic"]), id: z.string() }).passthrough()),
    parentAvailable: z.boolean(),
  }).passthrough(),
  "subagent.history": historySchema,
  "subagent.prompt": z.object({ messageId: z.string() }).passthrough(),
  "subagent.interrupt": acceptedSchema,
};
const questionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  intent: z.object({ kind: z.literal("plan-review"), approve: z.string() }).optional(),
});
const muxFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session/event"), sessionId: z.string(), event: historyEntrySchema.shape.event, view: z.unknown().optional() }),
  z.object({ type: z.literal("session/subscribed"), sessionId: z.string(), lastSeq: z.number().int() }),
  z.object({ type: z.literal("session/queue"), sessionId: z.string(), items: z.array(z.unknown()) }),
  z.object({ type: z.literal("approval/requested"), sessionId: z.string(), approvalId: z.string(), toolName: z.string(), callId: z.string().optional(), reason: z.string().optional() }),
  z.object({ type: z.literal("approval/resolved"), sessionId: z.string(), approvalId: z.string(), outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]) }),
  z.object({ type: z.literal("question/requested"), sessionId: z.string(), questions: z.array(questionSchema).min(1) }),
  z.object({ type: z.literal("question/resolved"), sessionId: z.string(), questionRpcId: z.string(), outcome: z.enum(["answered", "cancelled"]) }),
  z.object({ type: z.literal("session/jobs"), sessionId: z.string(), jobs: z.array(z.unknown()) }),
  z.object({ type: z.literal("session/projection"), sessionId: z.string(), key: z.string(), value: z.unknown(), seq: z.number().int() }),
  z.object({ type: z.literal("stream/error"), error: rpcErrorSchema }),
]);

/** A request received from the Harness Mux stream. */
export interface MuxRequest {
  rpcId: string;
  payload: MuxFrame;
}

/** Typed transport for one running Harness Web service. */
export class HarnessClient {
  public constructor(private readonly baseUrl: string, private readonly timeoutMs = 15_000) {}

  /** Calls one rc.6 unary Web API and validates its envelope and correlation id. */
  public async rpc<T>(method: string, payload: unknown): Promise<T> {
    const rpcId = `mcp-${randomUUID()}`;
    const response = await this.postJson(`/api/${method}`, {
      type: "client-request",
      rpcId,
      method,
      payload,
    });
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`${method} returned an invalid Harness response: ${z.prettifyError(parsed.error)}`);
    if (parsed.data.rpcId !== rpcId) throw new Error(`${method} returned a mismatched rpcId.`);
    if (!parsed.data.result.ok) {
      throw new Error(`${method} failed: ${parsed.data.result.error.code}: ${parsed.data.result.error.message}`);
    }
    const valueSchema = unaryValueSchemas[method];
    if (valueSchema === undefined) throw new Error(`No Harness response validator is registered for ${method}.`);
    const value = valueSchema.safeParse(parsed.data.result.value);
    if (!value.success) throw new Error(`${method} returned invalid result fields: ${z.prettifyError(value.error)}`);
    return value.data as T;
  }

  /** Responds once to a pending server-request and validates the carrier receipt. */
  public async respond(rpcId: string, value: unknown): Promise<void> {
    const response = await this.postJson("/api/respond", {
      type: "client-response",
      rpcId,
      result: { ok: true, value },
    });
    const parsed = receiptSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`Harness returned an invalid interaction receipt: ${z.prettifyError(parsed.error)}`);
    if (!parsed.data.accepted) throw new Error(`Harness interaction response failed: ${parsed.data.reason ?? "not-pending"}.`);
  }

  /** Reads and validates the long-lived rc.6 Mux SSE stream until it closes or is aborted. */
  public async readMux(signal: AbortSignal, onOpen: () => void, onFrame: (request: MuxRequest) => void): Promise<void> {
    const response = await fetch(new URL("/api/events.mux", this.baseUrl), { signal });
    if (!response.ok || response.body === null) {
      throw new Error(`events.mux failed over HTTP ${String(response.status)}: ${await response.text()}`);
    }
    onOpen();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("");
          if (data !== "") this.acceptMuxData(data, onFrame);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private acceptMuxData(data: string, onFrame: (request: MuxRequest) => void): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      throw new Error("events.mux returned malformed JSON.");
    }
    const parsed = muxEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new Error(`events.mux returned an invalid frame: ${z.prettifyError(parsed.error)}`);
    const frame = muxFrameSchema.safeParse(parsed.data.payload);
    if (!frame.success) throw new Error(`events.mux returned invalid payload fields: ${z.prettifyError(frame.error)}`);
    onFrame({ rpcId: parsed.data.rpcId, payload: frame.data as MuxFrame });
  }

  private async postJson(path: string, body: unknown): Promise<Response> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`${path} failed over HTTP ${String(response.status)}: ${await response.text()}`);
    return response;
  }
}
