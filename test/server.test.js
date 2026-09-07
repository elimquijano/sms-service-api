const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const { createSmsService } = require("../server");

const logger = { info() {}, warn() {}, error() {} };

function config(stateFile) {
  return {
    env: "test",
    host: "127.0.0.1",
    port: 0,
    trustProxy: false,
    requireHttps: false,
    apiKeys: "integration:integration-secret-123456789",
    basicAuthUser: "",
    basicAuthPass: "",
    websocketToken: "websocket-secret-123456789",
    websocketOrigins: [],
    stateFile,
    defaultCountryCode: "+51",
    maxBodyBytes: 32_768,
    maxMessageLength: 4000,
    maxRecipientsPerRequest: 10,
    maxQueueSize: 100,
    maxQueuedBytes: 1_000_000,
    ipRatePerMinute: 1000,
    requestRatePerMinute: 100,
    recipientRatePerMinute: 100,
    sendIntervalMs: 100,
    burstSize: 10,
    burstPauseMs: 100,
    ackTimeoutMs: 10_000,
    reconnectRetryMs: 1000,
    maxAttempts: 3,
    retryBaseMs: 1000,
    retryMaxMs: 5000,
    retryFailedTasks: true,
    heartbeatMs: 5000,
    wsMessagesPerMinute: 100,
    wsUpgradeRatePerMinute: 100,
    shutdownTimeoutMs: 2000,
    retentionDays: 365,
    logLevel: "error",
  };
}

function nextJson(ws, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No llegó ${expectedType}`)), 3000);
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== expectedType) return;
      clearTimeout(timeout);
      ws.off("message", handler);
      resolve(message);
    };
    ws.on("message", handler);
  });
}

test("flujo HTTP -> Android -> ACK -> consulta final", { timeout: 10_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sms-server-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = createSmsService(config(path.join(directory, "state.json")), logger);
  service.dispatcher.start();
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const port = service.server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/android`, {
    headers: { Authorization: "Bearer websocket-secret-123456789" },
  });
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "CLIENT_READY", protocolVersion: 1, pendingStatuses: 0 }));

  const newTaskPromise = nextJson(ws, "NEW_TASK");
  const body = { numeros: ["987654321"], mensaje: "prueba integral" };
  const accepted = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer integration-secret-123456789",
      "Content-Type": "application/json",
      "Idempotency-Key": "integration-request-1",
    },
    body: JSON.stringify(body),
  });
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json();

  const task = await newTaskPromise;
  assert.equal(task.payload.taskId, acceptedBody.taskIds[0]);
  assert.equal(task.payload.numero, "+51987654321");
  assert.equal(task.payload.attempts, 0);

  const ackPromise = nextJson(ws, "STATUS_ACK");
  ws.send(JSON.stringify({
    type: "STATUS_UPDATE",
    eventId: "integration-event-1",
    taskId: task.payload.taskId,
    status: "SENT",
    details: "enviado al módem",
    timestamp: Date.now(),
  }));
  const ack = await ackPromise;
  assert.equal(ack.payload.eventId, "integration-event-1");

  const statusResponse = await fetch(`http://127.0.0.1:${port}${acceptedBody.statusUrl}`, {
    headers: { Authorization: "Bearer integration-secret-123456789" },
  });
  const status = await statusResponse.json();
  assert.equal(status.status, "COMPLETED");
  assert.equal(status.tasks[0].status, "SENT");

  const duplicate = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer integration-secret-123456789",
      "Content-Type": "application/json",
      "Idempotency-Key": "integration-request-1",
    },
    body: JSON.stringify(body),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).requestId, acceptedBody.requestId);

  const closed = once(ws, "close");
  ws.close();
  await closed;
  await service.close();
});
