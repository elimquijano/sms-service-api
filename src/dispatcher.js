const { TokenBucketLimiter } = require("./rate-limiter");

class Dispatcher {
  constructor({ store, config, logger }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.connection = null;
    this.timer = null;
    this.reaper = null;
    this.heartbeat = null;
    this.cleanupTimer = null;
    this.nextAllowedAt = 0;
    this.burstCount = 0;
    this.stopped = false;
  }

  start() {
    const recovered = this.store.requeueInflight(
      this.config.reconnectRetryMs,
      "Recuperada después del reinicio del servidor"
    );
    if (recovered.length) this.logger.warn("Tareas en vuelo recuperadas al iniciar", { count: recovered.length });
    const cleaned = this.store.cleanup(this.config.retentionDays);
    if (cleaned.tasks || cleaned.events || cleaned.requests) {
      this.logger.info("Historial JSON antiguo depurado", cleaned);
    }

    this.reaper = setInterval(() => {
      try {
        const expired = this.store.requeueExpired(this.config);
        if (expired.length) {
          this.logger.warn("Tareas sin confirmación movidas para reintento", { count: expired.length });
          if (expired.includes(this.connection?.inflightTaskId)) this.connection.inflightTaskId = null;
          this.schedule(0);
        }
      } catch (error) {
        this.logger.error("No se pudieron recuperar tareas vencidas", { error: error.message });
      }
    }, Math.min(10_000, Math.max(1000, Math.floor(this.config.ackTimeoutMs / 4))));
    this.reaper.unref();

    this.heartbeat = setInterval(() => this.checkHeartbeat(), this.config.heartbeatMs);
    this.heartbeat.unref();
    this.cleanupTimer = setInterval(() => {
      try {
        const result = this.store.cleanup(this.config.retentionDays);
        if (result.tasks || result.events || result.requests) {
          this.logger.info("Historial JSON antiguo depurado", result);
        }
      } catch (error) {
        this.logger.error("No se pudo depurar el historial JSON", { error: error.message });
      }
    }, 86_400_000);
    this.cleanupTimer.unref();
  }

  attach(ws, remoteAddress) {
    if (this.connection?.ws && this.connection.ws.readyState === 1) {
      this.connection.ws.close(1012, "Nueva conexión autenticada");
    }
    const connection = {
      ws,
      remoteAddress,
      ready: false,
      alive: true,
      inflightTaskId: null,
      invalidMessages: 0,
      limiter: new TokenBucketLimiter({
        capacity: this.config.wsMessagesPerMinute,
        refillPerMinute: this.config.wsMessagesPerMinute,
      }),
    };
    this.connection = connection;
    ws.on("pong", () => { connection.alive = true; });
    ws.on("close", () => this.onClose(connection));
    ws.on("error", (error) => this.logger.error("Error del WebSocket Android", { error: error.message }));
    this.logger.info("Gateway Android conectado", { remoteAddress });
    return connection;
  }

  markReady(connection, message) {
    if (connection !== this.connection) return;
    if (message.protocolVersion !== 1 || !Number.isSafeInteger(message.pendingStatuses) || message.pendingStatuses < 0) {
      connection.ws.close(1002, "CLIENT_READY inválido");
      return;
    }
    connection.ready = true;
    this.logger.info("Gateway Android listo", { pendingStatuses: message.pendingStatuses });
    this.schedule(0);
  }

  handleStatus(connection, data) {
    if (connection !== this.connection) return;
    const result = this.store.recordEvent(data, this.config);

    // El ACK se envía solamente después de que el evento quedó persistido en JSON.
    this.send(connection.ws, {
      type: "STATUS_ACK",
      payload: { eventId: data.eventId },
    });

    if (result.orphan) {
      this.logger.error("Estado recibido para una tarea desconocida", {
        eventId: data.eventId,
        taskId: data.taskId,
      });
    } else if (!result.duplicate) {
      this.logger.info("Estado de tarea persistido", {
        taskId: data.taskId,
        status: data.status,
        nextStatus: result.status,
      });
    }

    if (["SENT", "FAILED"].includes(data.status) && connection.inflightTaskId === data.taskId) {
      connection.inflightTaskId = null;
      this.schedule();
    }
    return result;
  }

  schedule(delay) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const wait = delay ?? Math.max(0, this.nextAllowedAt - Date.now());
    this.timer = setTimeout(() => this.dispatch(), wait);
    this.timer.unref();
  }

  dispatch() {
    const connection = this.connection;
    if (
      this.stopped || !connection || !connection.ready ||
      connection.ws.readyState !== 1 || connection.inflightTaskId
    ) return;

    const now = Date.now();
    if (now < this.nextAllowedAt) return this.schedule(this.nextAllowedAt - now);

    let task;
    try {
      task = this.store.claimNext(now, this.config.ackTimeoutMs);
    } catch (error) {
      this.logger.error("No se pudo reservar la siguiente tarea", { error: error.message });
      return this.schedule(1000);
    }
    if (!task) return this.schedule(1000);

    connection.inflightTaskId = task.taskId;
    this.burstCount += 1;
    this.nextAllowedAt = now + this.config.sendIntervalMs;
    if (this.burstCount >= this.config.burstSize) {
      this.nextAllowedAt = Math.max(this.nextAllowedAt, now + this.config.burstPauseMs);
      this.burstCount = 0;
      this.logger.info("Pausa de ráfaga programada", { durationMs: this.config.burstPauseMs });
    }

    const payload = {
      type: "NEW_TASK",
      payload: {
        taskId: task.taskId,
        numero: task.numero,
        mensaje: task.mensaje,
        attempts: Math.max(0, task.attempts - 1),
      },
    };

    try {
      connection.ws.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        this.logger.error("Falló la escritura de una tarea al WebSocket", {
          taskId: task.taskId,
          error: error.message,
        });
        this.releaseConnectionTask(connection, "Falló la escritura al WebSocket", task.taskId);
      });
      this.logger.info("Tarea despachada al gateway Android", {
        taskId: task.taskId,
        attempt: task.attempts,
      });
    } catch (error) {
      this.logger.error("No se pudo despachar una tarea", { taskId: task.taskId, error: error.message });
      this.releaseConnectionTask(connection, "Falló el despacho al WebSocket", task.taskId);
    }
  }

  releaseConnectionTask(connection, reason, expectedTaskId = null) {
    if (!connection.inflightTaskId) return;
    if (expectedTaskId && connection.inflightTaskId !== expectedTaskId) return;
    try {
      this.store.releaseTask(connection.inflightTaskId, this.config.reconnectRetryMs, reason);
    } catch (error) {
      this.logger.error("No se pudo liberar la tarea en vuelo", { error: error.message });
    }
    connection.inflightTaskId = null;
    this.schedule(this.config.reconnectRetryMs);
  }

  send(ws, message) {
    if (ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.error("No se pudo responder al gateway Android", { error: error.message });
      return false;
    }
  }

  checkHeartbeat() {
    const connection = this.connection;
    if (!connection || connection.ws.readyState !== 1) return;
    if (!connection.alive) {
      this.logger.warn("Gateway Android sin heartbeat; cerrando conexión");
      connection.ws.terminate();
      return;
    }
    connection.alive = false;
    try {
      connection.ws.ping();
    } catch (error) {
      this.logger.warn("No se pudo enviar ping al gateway", { error: error.message });
      connection.ws.terminate();
    }
  }

  status() {
    const connection = this.connection;
    return {
      connected: Boolean(connection && connection.ws.readyState === 1),
      ready: Boolean(connection && connection.ready && connection.ws.readyState === 1),
      inflightTaskId: connection?.inflightTaskId || null,
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.reaper);
    clearInterval(this.heartbeat);
    clearInterval(this.cleanupTimer);
    const connection = this.connection;
    if (connection) {
      this.releaseConnectionTask(connection, "Apagado ordenado del servidor");
      try { connection.ws.close(1001, "Servidor apagándose"); } catch { /* Ya estaba cerrado. */ }
    }
    this.connection = null;
  }

  onClose(connection) {
    this.logger.warn("Gateway Android desconectado", { remoteAddress: connection.remoteAddress });
    this.releaseConnectionTask(connection, "Gateway Android desconectado");
    if (this.connection === connection) this.connection = null;
  }
}

module.exports = { Dispatcher };
