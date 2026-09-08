const path = require("node:path");
const os = require("node:os");

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} debe ser true o false`);
}

function csv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function loadConfig() {
  const root = path.resolve(__dirname, "..");
  const production = process.env.NODE_ENV === "production";
  const androidSmsRpm = integer("ANDROID_SMS_RPM", 20, { min: 1, max: 30 });
  const requestedSendInterval = integer("SEND_INTERVAL_MS", 1500, { min: 250 });
  const config = {
    env: process.env.NODE_ENV || "development",
    instanceId: process.env.SERVICE_INSTANCE_ID || os.hostname(),
    port: integer("PORT", 3000, { min: 1, max: 65535 }),
    host: process.env.HOST || "0.0.0.0",
    trustProxy: boolean("TRUST_PROXY", false),
    requireHttps: boolean("REQUIRE_HTTPS", production),
    apiKeys: process.env.API_KEYS || "",
    basicAuthUser: process.env.BASIC_AUTH_USER || "",
    basicAuthPass: process.env.BASIC_AUTH_PASS || "",
    websocketToken: process.env.WEBSOCKET_TOKEN || "",
    websocketOrigins: csv("WEBSOCKET_ALLOWED_ORIGINS"),
    stateFile: path.resolve(root, process.env.SMS_STATE_FILE || "data/sms-state.json"),
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || "+51",
    maxBodyBytes: integer("MAX_BODY_BYTES", 262_144, { min: 1024, max: 10_485_760 }),
    maxMessageLength: integer("MAX_MESSAGE_LENGTH", 300, { min: 1, max: 300 }),
    maxRecipientsPerRequest: integer("MAX_RECIPIENTS_PER_REQUEST", 500, { min: 1, max: 5000 }),
    maxQueueSize: integer("MAX_QUEUE_SIZE", 5000, { min: 1 }),
    maxQueuedBytes: integer("MAX_QUEUED_MESSAGE_BYTES", 5_000_000, { min: 1024 }),
    ipRatePerMinute: integer("IP_RATE_PER_MINUTE", 300, { min: 10 }),
    requestRatePerMinute: integer("REQUEST_RATE_PER_MINUTE", 60, { min: 1 }),
    recipientRatePerMinute: integer("RECIPIENT_RATE_PER_MINUTE", 1000, { min: 1 }),
    androidSmsRpm,
    sendIntervalMs: Math.max(requestedSendInterval, Math.ceil(60_000 / androidSmsRpm)),
    burstSize: integer("BURST_SIZE", 10, { min: 1 }),
    burstPauseMs: integer("BURST_PAUSE_MS", 10_000, { min: 0 }),
    ackTimeoutMs: integer("ACK_TIMEOUT_MS", 30_000, { min: 5000 }),
    reconnectRetryMs: integer("RECONNECT_RETRY_MS", 3000, { min: 500 }),
    maxRetries: integer("MAX_RETRIES", 2, { min: 0, max: 2 }),
    retryBaseMs: integer("RETRY_BASE_MS", 5000, { min: 500 }),
    retryMaxMs: integer("RETRY_MAX_MS", 30_000, { min: 500 }),
    retryFailedTasks: boolean("RETRY_FAILED_TASKS", true),
    modemErrorPauseMs: integer("MODEM_ERROR_PAUSE_MS", 60_000, { min: 5000 }),
    networkErrorPauseMs: integer("NETWORK_ERROR_PAUSE_MS", 30_000, { min: 5000 }),
    rateLimitPauseMs: integer("RATE_LIMIT_PAUSE_MS", 120_000, { min: 30_000 }),
    heartbeatMs: integer("HEARTBEAT_MS", 30_000, { min: 5000 }),
    wsMessagesPerMinute: integer("WS_MESSAGES_PER_MINUTE", 240, { min: 10 }),
    wsUpgradeRatePerMinute: integer("WS_UPGRADE_RATE_PER_MINUTE", 30, { min: 1 }),
    shutdownTimeoutMs: integer("SHUTDOWN_TIMEOUT_MS", 15_000, { min: 1000 }),
    retentionDays: integer("RETENTION_DAYS", 365, { min: 1, max: 3650 }),
    logLevel: process.env.LOG_LEVEL || "info",
  };
  // Dos reintentos significan un máximo total de tres intentos.
  config.maxAttempts = config.maxRetries + 1;

  if (!/^\+\d{1,4}$/.test(config.defaultCountryCode)) {
    throw new Error("DEFAULT_COUNTRY_CODE debe tener formato +<código>");
  }
  if (config.retryMaxMs < config.retryBaseMs) {
    throw new Error("RETRY_MAX_MS no puede ser menor que RETRY_BASE_MS");
  }
  if (!config.websocketToken) {
    throw new Error("WEBSOCKET_TOKEN es obligatorio");
  }
  if (!config.apiKeys && !(config.basicAuthUser && config.basicAuthPass)) {
    throw new Error("Configura API_KEYS o BASIC_AUTH_USER/BASIC_AUTH_PASS");
  }
  if (production && config.websocketToken.length < 32) {
    throw new Error("WEBSOCKET_TOKEN debe tener al menos 32 caracteres en producción");
  }
  if (production && config.apiKeys) {
    for (const entry of config.apiKeys.split(",")) {
      const secret = entry.slice(entry.indexOf(":") + 1).trim();
      if (secret.length < 32) throw new Error("Cada secreto de API_KEYS debe tener al menos 32 caracteres en producción");
    }
  }
  if (production && config.basicAuthUser && config.basicAuthPass.length < 32) {
    throw new Error("BASIC_AUTH_PASS debe tener al menos 32 caracteres en producción");
  }

  return Object.freeze(config);
}

module.exports = { loadConfig };
