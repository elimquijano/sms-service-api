const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

class QueueFullError extends Error {
  constructor(limit) {
    super(`La cola alcanzó su capacidad de ${limit} tareas`);
    this.name = "QueueFullError";
    this.limit = limit;
  }
}

class IdempotencyConflictError extends Error {
  constructor() {
    super("La clave de idempotencia ya fue usada con un contenido diferente");
    this.name = "IdempotencyConflictError";
  }
}

class QueueStorageLimitError extends Error {
  constructor(limit) {
    super(`La cola alcanzó su límite de almacenamiento de ${limit} bytes`);
    this.name = "QueueStorageLimitError";
    this.limit = limit;
  }
}

const TERMINAL = new Set(["SENT", "FAILED", "DEAD_LETTER", "CANCELLED"]);
const ACTIVE = new Set(["QUEUED", "RETRY_WAIT", "DISPATCHED", "PROCESSING"]);

class JsonStore {
  constructor(filename, logger = console) {
    this.filename = filename;
    this.backupFilename = `${filename}.bak`;
    this.logger = logger;
    this.lastBackupAt = 0;
    this.backupIntervalMs = 5000;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.state = this.load();
  }

  emptyState() {
    return {
      version: 1,
      sequence: 0,
      migrations: { legacyQueueImported: false },
      requests: {},
      tasks: {},
      events: {},
    };
  }

  load() {
    if (!fs.existsSync(this.filename)) {
      const initial = this.emptyState();
      this.persist(initial);
      return initial;
    }
    try {
      return this.validate(JSON.parse(fs.readFileSync(this.filename, "utf8")));
    } catch (error) {
      this.logger.error("El estado JSON principal está dañado; intentando recuperar el respaldo", {
        error: error.message,
      });
      if (!fs.existsSync(this.backupFilename)) throw error;
      const recovered = this.validate(JSON.parse(fs.readFileSync(this.backupFilename, "utf8")));
      this.persist(recovered, false);
      return recovered;
    }
  }

  validate(state) {
    if (
      !state || state.version !== 1 || !Number.isSafeInteger(state.sequence) ||
      typeof state.requests !== "object" || typeof state.tasks !== "object" ||
      typeof state.events !== "object"
    ) {
      throw new Error("Formato de estado JSON inválido o incompatible");
    }
    if (!state.migrations) state.migrations = { legacyQueueImported: false };
    return state;
  }

  importLegacyQueue(filename, clientId, now = Date.now()) {
    if (this.state.migrations.legacyQueueImported || !fs.existsSync(filename)) return 0;
    const legacy = JSON.parse(fs.readFileSync(filename, "utf8") || "[]");
    if (!Array.isArray(legacy)) throw new Error("queue.json legado no contiene un arreglo");
    for (const task of legacy) {
      if (
        !task || typeof task !== "object" ||
        typeof task.numero !== "string" || !/^\+?\d{6,20}$/.test(task.numero) ||
        typeof task.mensaje !== "string" || !task.mensaje.length || task.mensaje.length > 4000
      ) {
        throw new Error("queue.json legado contiene una tarea inválida");
      }
    }
    return this.transaction((state) => {
      state.migrations.legacyQueueImported = true;
      if (!legacy.length) return 0;
      const requestId = `legacy-${crypto.randomUUID()}`;
      const taskIds = [];
      for (const oldTask of legacy) {
        let taskId = typeof oldTask.taskId === "string" && oldTask.taskId.length <= 128
          ? oldTask.taskId
          : `sms-${crypto.randomUUID()}`;
        if (state.tasks[taskId]) taskId = `sms-${crypto.randomUUID()}`;
        state.sequence += 1;
        state.tasks[taskId] = {
          taskId,
          requestId,
          clientId,
          numero: oldTask.numero,
          mensaje: oldTask.mensaje,
          status: "QUEUED",
          attempts: Math.max(0, Number.isSafeInteger(oldTask.attempts) ? oldTask.attempts : 0),
          availableAt: now,
          leaseUntil: null,
          lastError: "Importada desde queue.json",
          lastEventId: null,
          providerTimestamp: null,
          createdAt: now,
          updatedAt: now,
          sequence: state.sequence,
        };
        taskIds.push(taskId);
      }
      state.requests[requestId] = {
        requestId,
        clientId,
        idempotencyKey: null,
        payloadHash: "legacy-import",
        total: taskIds.length,
        createdAt: now,
      };
      return taskIds.length;
    });
  }

  persist(nextState, makeBackup = true, forceBackup = false) {
    const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(nextState)}\n`, {
        encoding: "utf8",
        flag: "wx",
        flush: true,
      });
      const backupDue = forceBackup || Date.now() - this.lastBackupAt >= this.backupIntervalMs;
      if (makeBackup && backupDue && fs.existsSync(this.filename)) {
        fs.copyFileSync(this.filename, this.backupFilename);
        this.lastBackupAt = Date.now();
      }
      fs.renameSync(temporary, this.filename);
    } finally {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {
        // El próximo inicio ignora temporales incompletos.
      }
    }
  }

  transaction(mutator) {
    const next = structuredClone(this.state);
    const result = mutator(next);
    this.persist(next);
    this.state = next;
    return result;
  }

  findRequestByIdempotency(clientId, idempotencyKey, payloadHash) {
    if (!idempotencyKey) return null;
    const existing = Object.values(this.state.requests).find(
      (request) => request.clientId === clientId && request.idempotencyKey === idempotencyKey
    );
    if (!existing) return null;
    if (existing.payloadHash !== payloadHash) throw new IdempotencyConflictError();
    return { ...this.getRequestUnsafe(existing.requestId), duplicate: true };
  }

  enqueueBatch({
    clientId,
    idempotencyKey,
    payloadHash,
    recipients,
    message,
    sms,
    maxQueueSize,
    maxQueuedBytes = Number.MAX_SAFE_INTEGER,
    now = Date.now(),
  }) {
    const existing = idempotencyKey
      ? Object.values(this.state.requests).find(
          (request) => request.clientId === clientId && request.idempotencyKey === idempotencyKey
        )
      : null;
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new IdempotencyConflictError();
      return { ...this.getRequestUnsafe(existing.requestId), duplicate: true };
    }
    if (this.getActiveCount() + recipients.length > maxQueueSize) {
      throw new QueueFullError(maxQueueSize);
    }
    const incomingBytes = Buffer.byteLength(message, "utf8") * recipients.length;
    if (this.getActiveBytes() + incomingBytes > maxQueuedBytes) {
      throw new QueueStorageLimitError(maxQueuedBytes);
    }

    return this.transaction((state) => {
      const requestId = crypto.randomUUID();
      const taskIds = [];
      state.requests[requestId] = {
        requestId,
        clientId,
        idempotencyKey,
        payloadHash,
        total: recipients.length,
        createdAt: now,
      };
      for (const phone of recipients) {
        const taskId = `sms-${crypto.randomUUID()}`;
        state.sequence += 1;
        state.tasks[taskId] = {
          taskId,
          requestId,
          clientId,
          numero: phone,
          mensaje: message,
          smsEncoding: sms?.encoding || "UNKNOWN",
          smsParts: sms?.parts || 1,
          status: "QUEUED",
          attempts: 0,
          availableAt: now,
          leaseUntil: null,
          lastError: null,
          lastErrorCode: null,
          lastErrorCategory: null,
          lastEventId: null,
          providerTimestamp: null,
          createdAt: now,
          updatedAt: now,
          sequence: state.sequence,
        };
        taskIds.push(taskId);
      }
      return { requestId, clientId, total: recipients.length, taskIds, duplicate: false, createdAt: now };
    });
  }

  getRequestUnsafe(requestId) {
    const request = this.state.requests[requestId];
    if (!request) return null;
    const tasks = Object.values(this.state.tasks)
      .filter((task) => task.requestId === requestId)
      .sort((left, right) => left.sequence - right.sequence);
    return this.mapRequest(request, tasks);
  }

  getRequest(requestId, clientId) {
    const request = this.state.requests[requestId];
    if (!request || request.clientId !== clientId) return null;
    return this.getRequestUnsafe(requestId);
  }

  mapRequest(request, tasks) {
    const counts = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
    let status = "PROCESSING";
    if (tasks.length && tasks.every((task) => task.status === "SENT")) status = "COMPLETED";
    else if (tasks.length && tasks.every((task) => TERMINAL.has(task.status))) {
      status = counts.SENT ? "PARTIAL" : "FAILED";
    } else if (tasks.every((task) => task.status === "QUEUED")) status = "QUEUED";
    return {
      requestId: request.requestId,
      clientId: request.clientId,
      status,
      total: request.total,
      counts,
      taskIds: tasks.map((task) => task.taskId),
      tasks: tasks.map(publicTask),
      createdAt: request.createdAt,
    };
  }

  getTask(taskId, clientId) {
    const task = this.state.tasks[taskId];
    if (!task || task.clientId !== clientId) return null;
    return publicTask(task);
  }

  claimNext(now, leaseMs) {
    const candidate = Object.values(this.state.tasks)
      .filter((task) => ["QUEUED", "RETRY_WAIT"].includes(task.status) && task.availableAt <= now)
      .sort((left, right) => left.availableAt - right.availableAt || left.sequence - right.sequence)[0];
    if (!candidate) return null;
    return this.transaction((state) => {
      const task = state.tasks[candidate.taskId];
      task.status = "DISPATCHED";
      task.attempts += 1;
      task.leaseUntil = now + leaseMs;
      task.updatedAt = now;
      return structuredClone(task);
    });
  }

  releaseTask(taskId, delayMs, reason, now = Date.now()) {
    const current = this.state.tasks[taskId];
    if (!current || !["DISPATCHED", "PROCESSING"].includes(current.status)) return false;
    return this.transaction((state) => {
      const task = state.tasks[taskId];
      task.status = "RETRY_WAIT";
      task.availableAt = now + delayMs;
      task.leaseUntil = null;
      task.lastError = reason;
      task.updatedAt = now;
      return true;
    });
  }

  requeueInflight(delayMs, reason, now = Date.now()) {
    const ids = Object.values(this.state.tasks)
      .filter((task) => ["DISPATCHED", "PROCESSING"].includes(task.status))
      .map((task) => task.taskId);
    if (!ids.length) return [];
    return this.transaction((state) => {
      for (const id of ids) {
        Object.assign(state.tasks[id], {
          status: "RETRY_WAIT",
          availableAt: now + delayMs,
          leaseUntil: null,
          lastError: reason,
          updatedAt: now,
        });
      }
      return ids;
    });
  }

  requeueExpired(config, now = Date.now()) {
    const ids = Object.values(this.state.tasks)
      .filter((task) => ["DISPATCHED", "PROCESSING"].includes(task.status) && task.leaseUntil <= now)
      .map((task) => task.taskId);
    if (!ids.length) return [];
    return this.transaction((state) => {
      for (const id of ids) {
        const task = state.tasks[id];
        task.status = task.attempts < config.maxAttempts ? "RETRY_WAIT" : "DEAD_LETTER";
        task.availableAt = now + retryDelay(task.attempts, config);
        task.leaseUntil = null;
        task.lastError = "Tiempo de confirmación agotado";
        task.updatedAt = now;
        if (task.status === "DEAD_LETTER") task.mensaje = null;
      }
      return ids;
    });
  }

  recordEvent(data, config, now = Date.now(), failurePolicy = null) {
    const existingEvent = this.state.events[data.eventId];
    const currentTask = this.state.tasks[data.taskId];
    if (existingEvent) {
      if (existingEvent.taskId !== data.taskId || existingEvent.status !== data.status) {
        throw new Error("eventId reutilizado con un estado o taskId diferente");
      }
      return { duplicate: true, orphan: !currentTask, task: currentTask, terminal: TERMINAL.has(currentTask?.status) };
    }

    return this.transaction((state) => {
      state.events[data.eventId] = {
        eventId: data.eventId,
        taskId: data.taskId,
        status: data.status,
        details: data.details || null,
        providerTimestamp: data.timestamp || null,
        receivedAt: now,
      };
      const task = state.tasks[data.taskId];
      if (!task) return { duplicate: false, orphan: true, task: null, terminal: false };
      if (TERMINAL.has(task.status) && !(task.status === "DEAD_LETTER" && data.status === "SENT")) {
        return { duplicate: false, orphan: false, task, terminal: true };
      }

      task.lastEventId = data.eventId;
      task.providerTimestamp = data.timestamp || null;
      task.updatedAt = now;
      if (data.status === "PROCESSING") {
        task.status = "PROCESSING";
        task.leaseUntil = now + config.ackTimeoutMs;
        return { duplicate: false, orphan: false, task, terminal: false, status: task.status };
      }
      if (data.status === "SENT") {
        task.status = "SENT";
        task.leaseUntil = null;
        task.lastError = null;
        task.lastErrorCode = null;
        task.lastErrorCategory = null;
        task.mensaje = null;
        return { duplicate: false, orphan: false, task, terminal: true, status: task.status };
      }

      const shouldRetry = config.retryFailedTasks &&
        failurePolicy?.retryable !== false &&
        task.attempts < config.maxAttempts;
      task.status = shouldRetry ? "RETRY_WAIT" : "FAILED";
      const retryAfterMs = Math.max(retryDelay(task.attempts, config), failurePolicy?.retryAfterMs || 0);
      task.availableAt = shouldRetry ? now + retryAfterMs : now;
      task.leaseUntil = null;
      task.lastError = data.details || "Fallo reportado por Android";
      task.lastErrorCode = failurePolicy?.code ?? null;
      task.lastErrorCategory = failurePolicy?.category || "UNKNOWN";
      if (!shouldRetry) task.mensaje = null;
      return { duplicate: false, orphan: false, task, terminal: !shouldRetry, status: task.status };
    });
  }

  cancelTask(taskId, clientId, now = Date.now()) {
    const current = this.state.tasks[taskId];
    if (!current || current.clientId !== clientId || !["QUEUED", "RETRY_WAIT"].includes(current.status)) {
      return false;
    }
    return this.transaction((state) => {
      const task = state.tasks[taskId];
      task.status = "CANCELLED";
      task.leaseUntil = null;
      task.mensaje = null;
      task.updatedAt = now;
      return true;
    });
  }

  getCounts() {
    const counts = {};
    for (const task of Object.values(this.state.tasks)) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return counts;
  }

  getActiveCount() {
    return Object.values(this.state.tasks).filter((task) => ACTIVE.has(task.status)).length;
  }

  getActiveBytes() {
    return Object.values(this.state.tasks)
      .filter((task) => ACTIVE.has(task.status))
      .reduce((total, task) => total + Buffer.byteLength(task.mensaje, "utf8"), 0);
  }

  cleanup(retentionDays, now = Date.now()) {
    const cutoff = now - retentionDays * 86_400_000;
    const taskIds = Object.values(this.state.tasks)
      .filter((task) => TERMINAL.has(task.status) && task.updatedAt < cutoff)
      .map((task) => task.taskId);
    const eventIds = Object.values(this.state.events)
      .filter((event) => event.receivedAt < cutoff)
      .map((event) => event.eventId);
    if (!taskIds.length && !eventIds.length) return { tasks: 0, events: 0, requests: 0 };
    return this.transaction((state) => {
      for (const id of taskIds) delete state.tasks[id];
      for (const id of eventIds) delete state.events[id];
      const liveRequestIds = new Set(Object.values(state.tasks).map((task) => task.requestId));
      let requests = 0;
      for (const request of Object.values(state.requests)) {
        if (!liveRequestIds.has(request.requestId) && request.createdAt < cutoff) {
          delete state.requests[request.requestId];
          requests += 1;
        }
      }
      return { tasks: taskIds.length, events: eventIds.length, requests };
    });
  }

  close() {
    this.persist(this.state, true, true);
  }
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    requestId: task.requestId,
    numero: task.numero,
    status: task.status,
    attempts: task.attempts,
    availableAt: task.availableAt,
    lastError: task.lastError,
    lastErrorCode: task.lastErrorCode ?? null,
    lastErrorCategory: task.lastErrorCategory || null,
    lastEventId: task.lastEventId,
    providerTimestamp: task.providerTimestamp,
    smsEncoding: task.smsEncoding || "UNKNOWN",
    smsParts: task.smsParts || 1,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function retryDelay(attempts, config) {
  const exponential = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.max(0, attempts - 1));
  return exponential + Math.floor(exponential * 0.2 * Math.random());
}

module.exports = {
  IdempotencyConflictError,
  JsonStore,
  QueueFullError,
  QueueStorageLimitError,
  retryDelay,
};
