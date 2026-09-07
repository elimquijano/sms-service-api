const crypto = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const { loadConfig } = require("./src/config");
const { Dispatcher } = require("./src/dispatcher");
const { TokenBucketLimiter, rateLimitMiddleware } = require("./src/rate-limiter");
const { bearerToken, createHttpAuth, safeEqual, securityHeaders } = require("./src/security");
const {
  IdempotencyConflictError,
  JsonStore,
  QueueFullError,
  QueueStorageLimitError,
} = require("./src/store");
const {
  ValidationError,
  validateIdempotencyKey,
  validateMessageBody,
  validateStatusUpdate,
} = require("./src/validation");
const { createLogger } = require("./logger");

function createSmsService(config, logger = createLogger(config.logLevel)) {
  const store = new JsonStore(config.stateFile, logger);
  const legacyClientId = config.basicAuthUser || config.apiKeys.split(",")[0]?.split(":")[0] || "legacy";
  const imported = store.importLegacyQueue(path.join(__dirname, "queue.json"), legacyClientId);
  if (imported) logger.info("Cola JSON anterior importada", { count: imported });
  const dispatcher = new Dispatcher({ store, config, logger });
  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use((req, res, next) => {
    const suppliedId = req.headers["x-request-id"] || "";
    req.requestId = /^[A-Za-z0-9._-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const startedAt = Date.now();
    res.on("finish", () => logger.info("Solicitud HTTP", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
    next();
  });
  const ipLimiter = new TokenBucketLimiter({
    capacity: config.ipRatePerMinute,
    refillPerMinute: config.ipRatePerMinute,
  });
  app.use((req, res, next) => {
    const rate = ipLimiter.consume(req.ip);
    if (rate.allowed) return next();
    res.setHeader("Retry-After", Math.max(1, Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "ip_rate_limit_exceeded", message: "Demasiadas solicitudes" });
  });
  app.use((req, res, next) => {
    if (!config.requireHttps || req.secure) return next();
    return res.status(426).json({ error: "https_required", message: "Usa HTTPS" });
  });
  app.use(express.json({ limit: config.maxBodyBytes, strict: true, type: "application/json" }));

  app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/health/ready", (_req, res) => {
    const gateway = dispatcher.status();
    const ready = gateway.connected && gateway.ready;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "degraded",
      gatewayConnected: gateway.connected,
    });
  });

  const authenticate = createHttpAuth(config, logger);
  const requestLimiter = new TokenBucketLimiter({
    capacity: config.requestRatePerMinute,
    refillPerMinute: config.requestRatePerMinute,
  });
  const recipientLimiter = new TokenBucketLimiter({
    capacity: config.recipientRatePerMinute,
    refillPerMinute: config.recipientRatePerMinute,
  });
  const protectedRoute = [authenticate, rateLimitMiddleware(requestLimiter)];

  function enqueue(req, res, next) {
    try {
      const { recipients, message } = validateMessageBody(req.body, config);
      const idempotencyKey = validateIdempotencyKey(req.headers["idempotency-key"]);
      const payloadHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ recipients, message }))
        .digest("hex");
      let result = store.findRequestByIdempotency(req.clientId, idempotencyKey, payloadHash);
      if (!result) {
        const recipientRate = recipientLimiter.consume(`${req.clientId}:${req.ip}`, recipients.length);
        if (!recipientRate.allowed) {
          res.setHeader("Retry-After", Math.max(1, Math.ceil(recipientRate.retryAfterMs / 1000)));
          return res.status(429).json({
            error: "recipient_rate_limit_exceeded",
            message: "La cantidad de destinatarios excede el límite temporal",
          });
        }
        result = store.enqueueBatch({
          clientId: req.clientId,
          idempotencyKey,
          payloadHash,
          recipients,
          message,
          maxQueueSize: config.maxQueueSize,
          maxQueuedBytes: config.maxQueuedBytes,
        });
      }
      dispatcher.schedule(0);
      const location = `/v1/requests/${result.requestId}`;
      res.setHeader("Location", location);
      return res.status(result.duplicate ? 200 : 202).json({
        requestId: result.requestId,
        accepted: result.total,
        duplicate: result.duplicate,
        taskIds: result.taskIds,
        statusUrl: location,
      });
    } catch (error) {
      next(error);
    }
  }

  app.post("/v1/messages", ...protectedRoute, enqueue);
  app.post("/send-sms", ...protectedRoute, enqueue);

  app.get("/v1/requests/:requestId", ...protectedRoute, (req, res) => {
    const request = store.getRequest(req.params.requestId, req.clientId);
    if (!request) return res.status(404).json({ error: "not_found", message: "Solicitud no encontrada" });
    return res.json(request);
  });

  app.get("/v1/tasks/:taskId", ...protectedRoute, (req, res) => {
    const task = store.getTask(req.params.taskId, req.clientId);
    if (!task) return res.status(404).json({ error: "not_found", message: "Tarea no encontrada" });
    return res.json(task);
  });

  app.post("/v1/tasks/:taskId/cancel", ...protectedRoute, (req, res) => {
    if (!store.cancelTask(req.params.taskId, req.clientId)) {
      return res.status(409).json({
        error: "not_cancellable",
        message: "La tarea no existe, ya fue despachada o alcanzó un estado final",
      });
    }
    return res.status(200).json({ taskId: req.params.taskId, status: "CANCELLED" });
  });

  app.get("/status", ...protectedRoute, (_req, res) => {
    const gateway = dispatcher.status();
    const counts = store.getCounts();
    res.json({
      phone_connected: gateway.connected,
      phone_ready: gateway.ready,
      inflight_task_id: gateway.inflightTaskId,
      pending_tasks_count: Object.entries(counts)
        .filter(([status]) => ["QUEUED", "RETRY_WAIT", "DISPATCHED", "PROCESSING"].includes(status))
        .reduce((total, [, count]) => total + count, 0),
      queue_capacity: config.maxQueueSize,
      queued_message_bytes: store.getActiveBytes(),
      queued_message_bytes_capacity: config.maxQueuedBytes,
      counts,
    });
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found", message: "Endpoint no encontrado" }));
  app.use((error, req, res, _next) => {
    logger.warn("Solicitud HTTP rechazada", { requestId: req.requestId, error: error.message });
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: "validation_error", message: error.message, field: error.field });
    }
    if (error instanceof IdempotencyConflictError) {
      return res.status(409).json({ error: "idempotency_conflict", message: error.message });
    }
    if (error instanceof QueueFullError || error instanceof QueueStorageLimitError) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil(config.sendIntervalMs / 1000)));
      return res.status(503).json({ error: "queue_full", message: error.message });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "payload_too_large", message: "Cuerpo de solicitud demasiado grande" });
    }
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ error: "invalid_json", message: "JSON inválido" });
    }
    return res.status(500).json({ error: "internal_error", message: "Error interno" });
  });

  const server = http.createServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;

  const wss = new WebSocket.Server({
    noServer: true,
    clientTracking: false,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const wsUpgradeLimiter = new TokenBucketLimiter({
    capacity: config.wsUpgradeRatePerMinute,
    refillPerMinute: config.wsUpgradeRatePerMinute,
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      const upgradeRate = wsUpgradeLimiter.consume(request.socket.remoteAddress || "unknown");
      if (!upgradeRate.allowed) {
        rejectUpgrade(socket, 429, "Too Many Requests");
        return;
      }
      const parsed = new URL(request.url, "http://localhost");
      const forwardedProto = request.headers["x-forwarded-proto"]?.split(",")[0].trim();
      const secure = Boolean(request.socket.encrypted) || (config.trustProxy && forwardedProto === "https");
      const origin = request.headers.origin;
      const validOrigin = !origin || !config.websocketOrigins.length || config.websocketOrigins.includes(origin);
      const validToken = safeEqual(config.websocketToken, bearerToken(request.headers.authorization));
      if (
        parsed.pathname !== "/android" || parsed.searchParams.has("token") ||
        !validToken || !validOrigin || (config.requireHttps && !secure)
      ) {
        logger.warn("Upgrade WebSocket rechazado", { remoteAddress: request.socket.remoteAddress });
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } catch (error) {
      logger.warn("Upgrade WebSocket inválido", { error: error.message });
      rejectUpgrade(socket, 400, "Bad Request");
    }
  });

  wss.on("connection", (ws, request) => {
    const connection = dispatcher.attach(ws, request.socket.remoteAddress);
    ws.on("message", (raw, isBinary) => {
      try {
        if (isBinary) throw new ValidationError("Los mensajes binarios no son compatibles");
        const rate = connection.limiter.consume("gateway");
        if (!rate.allowed) {
          ws.close(1008, "Límite de mensajes excedido");
          return;
        }
        const data = JSON.parse(raw.toString("utf8"));
        if (data.type === "CLIENT_READY") {
          dispatcher.markReady(connection, data);
          return;
        }
        if (!connection.ready) throw new ValidationError("CLIENT_READY es obligatorio antes de enviar estados");
        dispatcher.handleStatus(connection, validateStatusUpdate(data));
      } catch (error) {
        connection.invalidMessages += 1;
        logger.warn("Mensaje WebSocket rechazado", { error: error.message });
        dispatcher.send(ws, { type: "ERROR", payload: { code: "INVALID_MESSAGE", message: error.message } });
        if (connection.invalidMessages >= 3) ws.close(1008, "Demasiados mensajes inválidos");
      }
    });
  });

  let closing = false;
  function close() {
    if (closing) return Promise.resolve();
    closing = true;
    const gatewaySocket = dispatcher.connection?.ws;
    dispatcher.stop();
    return new Promise((resolve) => {
      const force = setTimeout(() => {
        gatewaySocket?.terminate();
        server.closeAllConnections?.();
        resolve();
      }, config.shutdownTimeoutMs);
      force.unref();
      server.close(() => {
        clearTimeout(force);
        try { store.close(); } catch (error) { logger.error("No se pudo cerrar el estado JSON", { error: error.message }); }
        resolve();
      });
    });
  }

  return { app, close, dispatcher, server, store, wss };
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`Configuración inválida: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const logger = createLogger(config.logLevel);
  const service = createSmsService(config, logger);
  service.dispatcher.start();
  service.server.listen(config.port, config.host, () => {
    logger.info("Servidor SMS iniciado", { host: config.host, port: config.port, env: config.env });
  });

  const shutdown = (signal) => {
    logger.info("Apagado ordenado iniciado", { signal });
    service.close().then(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error("Excepción no controlada", { error: error.message });
    shutdown("uncaughtException").finally(() => { process.exitCode = 1; });
  });
  process.on("unhandledRejection", (error) => {
    logger.error("Promesa rechazada sin manejar", { error: String(error) });
    shutdown("unhandledRejection").finally(() => { process.exitCode = 1; });
  });
}

if (require.main === module) main();

module.exports = { createSmsService, main };
