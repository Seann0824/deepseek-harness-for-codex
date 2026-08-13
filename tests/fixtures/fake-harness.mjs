import { createServer } from "node:http";

let nextWorkspace = 1;
let nextSession = 1;
const sessions = new Map();

function ok(rpcId, value) {
  return { type: "server-response", rpcId, result: { ok: true, value } };
}

const server = createServer((request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>Fake DeepSeek Harness Web</body></html>");
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const message = JSON.parse(body);
    const { method, payload, rpcId } = message;
    let value;
    if (method === "workspace.create") {
      value = { workspace: { workspaceId: `workspace-${nextWorkspace++}` }, created: true };
    } else if (method === "session.create") {
      const sessionId = `session-${nextSession++}`;
      sessions.set(sessionId, { running: false, events: [], task: "" });
      value = { sessionId };
    } else if (method === "session.prompt") {
      const session = sessions.get(payload.sessionId);
      session.running = true;
      session.task = payload.content[0].text;
      session.events.push({ event: { type: "turn/start", seq: session.events.length, data: {} } });
      setTimeout(() => {
        session.events.push({
          event: {
            type: "assistant/message",
            seq: session.events.length,
            data: { message: { content: [{ type: "text", text: `completed:${session.task}` }] } },
          },
        });
        session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: "stop" } } });
        session.running = false;
      }, 40);
      value = { accepted: true };
    } else if (method === "session.list") {
      value = { items: [...sessions].map(([sessionId, session]) => ({ sessionId, running: session.running, blank: session.events.length === 0 })) };
    } else if (method === "session.history") {
      value = { events: sessions.get(payload.sessionId)?.events ?? [], hasMore: false };
    } else if (method === "session.cancel") {
      const session = sessions.get(payload.sessionId);
      session.running = false;
      session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: "cancelled" } } });
      value = { accepted: true };
    } else {
      value = {};
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(ok(rpcId, value)));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`dsh web: http://127.0.0.1:${address.port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
