import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

let nextWorkspace = 1;
let nextSession = 1;
let nextQueueItem = 1;
let nextRpc = 1;
const sessions = new Map();
const muxClients = new Set();
const pending = new Map();
const stateFile = process.env.FAKE_HARNESS_STATE_FILE;

if (stateFile !== undefined && existsSync(stateFile)) {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"));
  for (const [sessionId, session] of saved.sessions) sessions.set(sessionId, { ...session, running: false, queue: [] });
  nextSession = saved.nextSession;
}

function save() {
  if (stateFile === undefined) return;
  const serializable = [...sessions].map(([sessionId, session]) => [sessionId, { ...session, timer: undefined, queue: [] }]);
  writeFileSync(stateFile, JSON.stringify({ nextSession, sessions: serializable }));
}

function ok(rpcId, value) {
  return { type: "server-response", rpcId, result: { ok: true, value } };
}

function failed(rpcId, code, message) {
  return { type: "server-response", rpcId, result: { ok: false, error: { code, message, details: {} } } };
}

function writeJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function push(payload, rpcId = `server-${nextRpc++}`) {
  const body = `data: ${JSON.stringify({ type: "server-request", rpcId, payload })}\n\n`;
  for (const response of muxClients) response.write(body);
}

function queueFrame(sessionId, session) {
  push({ type: "session/queue", sessionId, items: session.queue });
}

function append(sessionId, session, type, data) {
  const event = { type, seq: session.events.length, data };
  session.events.push({ event });
  save();
  push({ type: "session/event", sessionId, event });
}

function complete(sessionId, session, text) {
  if (!session.running) return;
  append(sessionId, session, "assistant/message", { message: { content: [{ type: "text", text: `completed:${text}` }] } });
  append(sessionId, session, "turn/end", { reason: "stop" });
  session.running = false;
  session.timer = undefined;
}

function beginTurn(sessionId, session, text) {
  session.running = true;
  session.task = text;
  append(sessionId, session, "turn/start", {});
  if (text.includes("needs approval")) {
    const rpcId = `approval-rpc-${nextRpc++}`;
    const approvalId = `approval-${nextRpc++}`;
    const request = { type: "approval/requested", sessionId, approvalId, toolName: "shell", callId: "call-1", reason: "test action" };
    pending.set(rpcId, { kind: "approval", request, sessionId, text });
    push(request, rpcId);
    return;
  }
  if (text.includes("needs question")) {
    const rpcId = `question-rpc-${nextRpc++}`;
    const request = {
      type: "question/requested",
      sessionId,
      questions: [{ id: "choice", question: "Continue?", options: [{ label: "yes" }, { label: "no" }] }],
    };
    pending.set(rpcId, { kind: "question", request, sessionId, text });
    push(request, rpcId);
    return;
  }
  session.timer = setTimeout(() => complete(sessionId, session, text), 40);
}

function sessionSummary([sessionId, session]) {
  return {
    sessionId,
    updatedAt: Date.now(),
    running: session.running,
    blank: session.events.length === 0,
    agentPreset: session.agentPreset,
    projections: { asOfSeq: session.events.length - 1, values: { title: `Session ${sessionId}` } },
  };
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(JSON.parse(body)));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/events.mux") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": open\n\n");
    muxClients.add(response);
    for (const [sessionId, session] of sessions) {
      push({ type: "session/subscribed", sessionId, lastSeq: session.events.length - 1 });
      queueFrame(sessionId, session);
    }
    for (const [rpcId, interaction] of pending) push(interaction.request, rpcId);
    request.on("close", () => muxClients.delete(response));
    return;
  }
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>Fake DeepSeek Harness Web</body></html>");
    return;
  }

  if (url.pathname === "/test/disconnect") {
    for (const client of muxClients) client.end();
    muxClients.clear();
    if (url.searchParams.get("resolve") === "true") pending.clear();
    writeJson(response, { disconnected: true });
    return;
  }

  const message = await readBody(request);
  if (url.pathname === "/api/respond") {
    const interaction = pending.get(message.rpcId);
    if (interaction === undefined) {
      writeJson(response, { accepted: false, reason: "not-pending" });
      return;
    }
    pending.delete(message.rpcId);
    const session = sessions.get(interaction.sessionId);
    if (interaction.kind === "approval") {
      const outcome = message.result.value.outcome;
      push({ type: "approval/resolved", sessionId: interaction.sessionId, approvalId: interaction.request.approvalId, outcome });
      if (outcome === "allowed-once") session.timer = setTimeout(() => complete(interaction.sessionId, session, interaction.text), 20);
      else {
        append(interaction.sessionId, session, "turn/end", { reason: "rejected" });
        session.running = false;
      }
    } else {
      push({ type: "question/resolved", sessionId: interaction.sessionId, questionRpcId: message.rpcId, outcome: "answered" });
      session.timer = setTimeout(() => complete(interaction.sessionId, session, interaction.text), 20);
    }
    writeJson(response, { accepted: true });
    return;
  }

  const { method, payload, rpcId } = message;
  let value;
  if (method === "host.describe") {
    value = { version: "0.1.0-rc.6", cwd: process.cwd(), attachedSessions: sessions.size, canOpenPath: false };
  } else if (method === "workspace.create") {
    value = { workspace: { workspaceId: `workspace-${nextWorkspace++}` }, created: true };
  } else if (method === "session.create") {
    const sessionId = `session-${nextSession++}`;
    sessions.set(sessionId, { running: false, events: [], task: "", queue: [], agentPreset: payload.agentPreset });
    save();
    value = { sessionId, ...(payload.agentPreset === undefined ? {} : { agentPreset: payload.agentPreset }) };
    push({ type: "session/subscribed", sessionId, lastSeq: -1 });
  } else if (method === "session.prompt") {
    const session = sessions.get(payload.sessionId);
    if (session === undefined) {
      writeJson(response, failed(rpcId, "session-not-found", "session not found"));
      return;
    }
    const text = payload.content[0].text;
    if (payload.mode === "steer") {
      if (!session.running) {
        writeJson(response, failed(rpcId, "agent-busy", "steering requires an active turn"));
        return;
      }
      append(payload.sessionId, session, "user/message", { message: { content: payload.content }, placement: "steering" });
    } else if (session.running) {
      session.queue.push({
        id: `queue-${nextQueueItem++}`,
        placement: "queued",
        message: { id: `message-${nextQueueItem++}`, role: "user", content: payload.content, source: { kind: "user-rpc" } },
      });
      queueFrame(payload.sessionId, session);
    } else {
      beginTurn(payload.sessionId, session, text);
    }
    value = { accepted: true };
  } else if (method === "session.list") {
    value = { items: [...sessions].map(sessionSummary) };
  } else if (method === "session.history") {
    const session = sessions.get(payload.sessionId);
    if (session === undefined) {
      writeJson(response, failed(rpcId, "session-not-found", "session not found"));
      return;
    }
    const beforeSeq = payload.beforeSeq ?? Number.POSITIVE_INFINITY;
    value = {
      events: session.events.filter((entry) => entry.event.seq < beforeSeq),
      hasMore: false,
      ...(payload.beforeSeq === undefined ? { projections: { asOfSeq: session.events.length - 1, values: { title: `Session ${payload.sessionId}` } } } : {}),
    };
  } else if (method === "session.cancel") {
    const session = sessions.get(payload.sessionId);
    if (session === undefined) {
      writeJson(response, failed(rpcId, "session-not-found", "session not found"));
      return;
    }
    if (session.timer !== undefined) clearTimeout(session.timer);
    for (const [pendingRpcId, interaction] of pending) {
      if (interaction.sessionId !== payload.sessionId) continue;
      pending.delete(pendingRpcId);
      if (interaction.kind === "approval") {
        push({ type: "approval/resolved", sessionId: payload.sessionId, approvalId: interaction.request.approvalId, outcome: "cancelled" });
      } else {
        push({ type: "question/resolved", sessionId: payload.sessionId, questionRpcId: pendingRpcId, outcome: "cancelled" });
      }
    }
    session.running = false;
    append(payload.sessionId, session, "turn/end", { reason: "cancelled" });
    value = { accepted: true };
  } else if (method === "session.fork") {
    const source = sessions.get(payload.sessionId);
    if (source === undefined) {
      writeJson(response, failed(rpcId, "session-not-found", "session not found"));
      return;
    }
    const sessionId = `session-${nextSession++}`;
    sessions.set(sessionId, { ...source, running: false, events: [...source.events], queue: [] });
    save();
    value = { sessionId };
    push({ type: "session/subscribed", sessionId, lastSeq: source.events.length - 1 });
  } else if (method === "session.updateQueue") {
    const session = sessions.get(payload.sessionId);
    const index = session?.queue.findIndex((item) => item.id === payload.itemId) ?? -1;
    if (session === undefined || index < 0) {
      writeJson(response, failed(rpcId, "queue-item-not-found", "queue item not found"));
      return;
    }
    if (payload.action.kind === "remove") session.queue.splice(index, 1);
    else if (payload.action.kind === "steer") session.queue[index].placement = "steering";
    else session.queue[index].message.content = payload.action.content;
    queueFrame(payload.sessionId, session);
    value = { accepted: true };
  } else if (method === "subagent.list") {
    value = {
      entries: [
        { kind: "child", id: `${payload.parentSessionId}-continuable`, activity: "running", hasChildren: false, mode: "continuable", label: "worker" },
        { kind: "child", id: `${payload.parentSessionId}-one-shot`, activity: "inactive", hasChildren: false, mode: "one-shot" },
      ],
      parentAvailable: true,
    };
  } else if (method === "subagent.history") {
    value = { events: [{ event: { type: "assistant/message", seq: 0, data: { message: { content: [{ type: "text", text: payload.childSessionId }] } } } }], hasMore: false };
  } else if (method === "subagent.prompt") {
    value = { messageId: `subagent-message-${nextQueueItem++}` };
  } else if (method === "subagent.interrupt") {
    value = { accepted: true };
  } else {
    writeJson(response, failed(rpcId, "bad-request", `unsupported method: ${method}`));
    return;
  }
  writeJson(response, ok(rpcId, value));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`dsh web: http://127.0.0.1:${address.port}\n`);
});

process.on("SIGTERM", () => {
  for (const response of muxClients) response.end();
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
