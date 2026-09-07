class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

function normalizePhone(value, defaultCountryCode) {
  if (typeof value !== "string") throw new ValidationError("Debe ser texto", "numeros");
  const trimmed = value.trim();
  if (/^\d{9}$/.test(trimmed)) return `${defaultCountryCode}${trimmed}`;
  if (!/^\+?\d{6,20}$/.test(trimmed)) {
    throw new ValidationError("Cada número debe contener entre 6 y 20 dígitos y puede iniciar con +", "numeros");
  }
  return trimmed;
}

function parseRecipients(input, config) {
  let values;
  if (Array.isArray(input)) values = input;
  else if (typeof input === "string") values = input.split(",");
  else throw new ValidationError('El campo "numeros" debe ser un texto o arreglo', "numeros");

  if (values.length === 0) throw new ValidationError("Incluye al menos un destinatario", "numeros");
  if (values.length > config.maxRecipientsPerRequest) {
    throw new ValidationError(`Máximo ${config.maxRecipientsPerRequest} destinatarios por solicitud`, "numeros");
  }
  return values.map((value) => normalizePhone(value, config.defaultCountryCode));
}

function validateMessageBody(body, config) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("El cuerpo debe ser un objeto JSON");
  }
  const message = body.mensaje;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new ValidationError('El campo "mensaje" debe ser texto no vacío', "mensaje");
  }
  if (message.length > config.maxMessageLength) {
    throw new ValidationError(`El mensaje excede ${config.maxMessageLength} caracteres`, "mensaje");
  }
  return { recipients: parseRecipients(body.numeros, config), message };
}

function validateIdempotencyKey(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[\x21-\x7E]{1,128}$/.test(value)) {
    throw new ValidationError("Idempotency-Key debe tener entre 1 y 128 caracteres ASCII visibles");
  }
  return value;
}

function validateStatusUpdate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("Mensaje WebSocket inválido");
  }
  if (data.type !== "STATUS_UPDATE") throw new ValidationError("Tipo de mensaje no soportado");
  if (typeof data.eventId !== "string" || data.eventId.length < 1 || data.eventId.length > 128) {
    throw new ValidationError("eventId inválido");
  }
  if (typeof data.taskId !== "string" || data.taskId.length < 1 || data.taskId.length > 128) {
    throw new ValidationError("taskId inválido");
  }
  if (!["PROCESSING", "SENT", "FAILED"].includes(data.status)) {
    throw new ValidationError("status inválido");
  }
  if (data.details !== undefined && (typeof data.details !== "string" || data.details.length > 4000)) {
    throw new ValidationError("details inválido");
  }
  if (data.timestamp !== undefined && (!Number.isSafeInteger(data.timestamp) || data.timestamp < 0)) {
    throw new ValidationError("timestamp inválido");
  }
  return data;
}

module.exports = {
  ValidationError,
  normalizePhone,
  validateIdempotencyKey,
  validateMessageBody,
  validateStatusUpdate,
};
