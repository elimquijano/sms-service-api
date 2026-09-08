const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  IdempotencyConflictError,
  JsonStore,
  QueueFullError,
  QueueStorageLimitError,
} = require("../src/store");

const logger = { info() {}, warn() {}, error() {} };
const retryConfig = {
  maxAttempts: 3,
  retryBaseMs: 1000,
  retryMaxMs: 10_000,
  retryFailedTasks: true,
  ackTimeoutMs: 5000,
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sms-json-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { filename: path.join(directory, "state.json"), store: new JsonStore(path.join(directory, "state.json"), logger) };
}

function enqueue(store, overrides = {}) {
  return store.enqueueBatch({
    clientId: "client-a",
    idempotencyKey: "request-1",
    payloadHash: "hash-a",
    recipients: ["+51987654321"],
    message: "hola",
    maxQueueSize: 10,
    now: 1000,
    ...overrides,
  });
}

test("persiste solicitudes y tareas al reiniciar", (t) => {
  const { filename, store } = fixture(t);
  const created = enqueue(store);
  const restarted = new JsonStore(filename, logger);
  const request = restarted.getRequest(created.requestId, "client-a");
  assert.equal(request.status, "QUEUED");
  assert.deepEqual(request.taskIds, created.taskIds);
  assert.equal(request.tasks[0].numero, "+51987654321");
});

test("la idempotencia devuelve el mismo lote y detecta conflictos", (t) => {
  const { store } = fixture(t);
  const first = enqueue(store);
  const duplicate = enqueue(store);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.requestId, first.requestId);
  assert.deepEqual(duplicate.taskIds, first.taskIds);
  assert.throws(() => enqueue(store, { payloadHash: "different" }), IdempotencyConflictError);
});

test("rechaza el lote completo cuando la cola no tiene capacidad", (t) => {
  const { store } = fixture(t);
  enqueue(store, { idempotencyKey: "one", recipients: ["+51911111111", "+51922222222"] });
  assert.throws(
    () => enqueue(store, { idempotencyKey: "two", recipients: ["+51933333333"], maxQueueSize: 2 }),
    QueueFullError
  );
  assert.equal(store.getActiveCount(), 2);
});

test("limita los bytes de mensajes activos", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => enqueue(store, { message: "á".repeat(10), maxQueuedBytes: 10 }),
    QueueStorageLimitError
  );
  assert.equal(store.getActiveCount(), 0);
});

test("persiste eventos antes de deduplicarlos y reintenta fallos", (t) => {
  const { filename, store } = fixture(t);
  const created = enqueue(store);
  const taskId = created.taskIds[0];
  const claimed = store.claimNext(1000, retryConfig.ackTimeoutMs);
  assert.equal(claimed.attempts, 1);

  const processing = {
    type: "STATUS_UPDATE",
    eventId: "event-processing",
    taskId,
    status: "PROCESSING",
    timestamp: 1500,
  };
  assert.equal(store.recordEvent(processing, retryConfig, 1500).status, "PROCESSING");
  assert.equal(store.recordEvent(processing, retryConfig, 1600).duplicate, true);
  assert.throws(() => store.recordEvent({ ...processing, taskId: "otro-task" }, retryConfig, 1600));

  const failed = store.recordEvent({
    type: "STATUS_UPDATE",
    eventId: "event-failed",
    taskId,
    status: "FAILED",
    details: "sin servicio",
    timestamp: 2000,
  }, retryConfig, 2000);
  assert.equal(failed.status, "RETRY_WAIT");

  const restarted = new JsonStore(filename, logger);
  assert.equal(restarted.recordEvent(processing, retryConfig, 3000).duplicate, true);
  assert.equal(restarted.getTask(taskId, "client-a").status, "RETRY_WAIT");

  const retried = restarted.claimNext(20_000, retryConfig.ackTimeoutMs);
  assert.equal(retried.taskId, taskId);
  assert.equal(retried.attempts, 2);
  restarted.recordEvent({
    type: "STATUS_UPDATE",
    eventId: "event-sent",
    taskId,
    status: "SENT",
    timestamp: 21_000,
  }, retryConfig, 21_000);
  assert.equal(restarted.getTask(taskId, "client-a").status, "SENT");
});

test("recupera el respaldo si el JSON principal está dañado", (t) => {
  const { filename, store } = fixture(t);
  enqueue(store, { idempotencyKey: "first" });
  enqueue(store, { idempotencyKey: "second", payloadHash: "hash-b" });
  store.close();
  fs.writeFileSync(filename, "{archivo truncado", "utf8");
  const recovered = new JsonStore(filename, logger);
  assert.equal(Object.keys(recovered.state.requests).length, 2);
});

test("un timeout libera la cola y permite despachar la siguiente tarea", (t) => {
  const { store } = fixture(t);
  const created = enqueue(store, {
    recipients: ["+51911111111", "+51922222222"],
    idempotencyKey: "timeout-batch",
  });
  assert.equal(store.claimNext(1000, 5000).taskId, created.taskIds[0]);
  const expired = store.requeueExpired(retryConfig, 6001);
  assert.deepEqual(expired, [created.taskIds[0]]);
  assert.equal(store.claimNext(6001, 5000).taskId, created.taskIds[1]);
});

test("un error permanente no se reintenta", (t) => {
  const { store } = fixture(t);
  const created = enqueue(store, { idempotencyKey: "permanent-error" });
  store.claimNext(1000, 5000);
  const result = store.recordEvent({
    type: "STATUS_UPDATE",
    eventId: "permanent-event",
    taskId: created.taskIds[0],
    status: "FAILED",
    details: "error Android 109",
  }, retryConfig, 2000, {
    code: 109,
    category: "RIL_ENCODING_ERROR",
    retryable: false,
    retryAfterMs: 0,
  });
  assert.equal(result.status, "FAILED");
  const task = store.getTask(created.taskIds[0], "client-a");
  assert.equal(task.attempts, 1);
  assert.equal(task.lastErrorCode, 109);
  assert.equal(task.lastErrorCategory, "RIL_ENCODING_ERROR");
});

test("importa queue.json legado una sola vez conservando taskId", (t) => {
  const { filename, store } = fixture(t);
  const legacyFilename = path.join(path.dirname(filename), "queue.json");
  fs.writeFileSync(legacyFilename, JSON.stringify([
    { taskId: "sms_legacy_1", numero: "+51987654321", mensaje: "pendiente", attempts: 1 },
  ]));
  assert.equal(store.importLegacyQueue(legacyFilename, "client-a", 1000), 1);
  assert.equal(store.importLegacyQueue(legacyFilename, "client-a", 2000), 0);
  assert.equal(store.getTask("sms_legacy_1", "client-a").status, "QUEUED");
  const restarted = new JsonStore(filename, logger);
  assert.equal(restarted.importLegacyQueue(legacyFilename, "client-a", 3000), 0);
});
