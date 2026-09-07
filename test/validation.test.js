const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ValidationError,
  normalizePhone,
  validateIdempotencyKey,
  validateMessageBody,
  validateStatusUpdate,
} = require("../src/validation");

const config = { defaultCountryCode: "+51", maxMessageLength: 300, maxRecipientsPerRequest: 3 };

test("normaliza números locales y conserva E.164", () => {
  assert.equal(normalizePhone("987654321", "+51"), "+51987654321");
  assert.equal(normalizePhone("+14155552671", "+51"), "+14155552671");
  assert.throws(() => normalizePhone("+51 987", "+51"), ValidationError);
});

test("valida lotes, mensaje y límite de destinatarios", () => {
  const result = validateMessageBody({ numeros: "987654321,+51911111111", mensaje: "hola" }, config);
  assert.deepEqual(result.recipients, ["+51987654321", "+51911111111"]);
  assert.deepEqual(result.sms, {
    encoding: "GSM-7",
    units: 4,
    singlePartLimit: 160,
    multipartPartLimit: 153,
    parts: 1,
  });
  assert.throws(() => validateMessageBody({ numeros: [], mensaje: "hola" }, config), ValidationError);
  assert.throws(
    () => validateMessageBody({ numeros: ["111111", "222222", "333333", "444444"], mensaje: "hola" }, config),
    ValidationError
  );
  assert.throws(() => validateMessageBody({ numeros: "987654321", mensaje: "" }, config), ValidationError);
  assert.throws(
    () => validateMessageBody({ numeros: "987654321", mensaje: "x".repeat(301) }, config),
    ValidationError
  );
  assert.throws(
    () => validateMessageBody({ numeros: "987654321", mensaje: "x".repeat(161) }, config),
    /requiere 2 partes GSM-7/
  );
  assert.throws(
    () => validateMessageBody({ numeros: "987654321", mensaje: "á".repeat(71) }, config),
    /requiere 2 partes UCS-2/
  );
  assert.equal(validateMessageBody({ numeros: "987654321", mensaje: "^".repeat(80) }, config).sms.parts, 1);
  assert.throws(
    () => validateMessageBody({ numeros: "987654321", mensaje: "^".repeat(81) }, config),
    /requiere 2 partes GSM-7/
  );
});

test("valida claves y eventos del protocolo", () => {
  assert.equal(validateIdempotencyKey("orden-123"), "orden-123");
  assert.throws(() => validateIdempotencyKey("x".repeat(129)), ValidationError);
  assert.equal(validateStatusUpdate({
    type: "STATUS_UPDATE",
    eventId: "event-1",
    taskId: "task-1",
    status: "SENT",
    timestamp: 1000,
  }).status, "SENT");
  assert.throws(() => validateStatusUpdate({
    type: "STATUS_UPDATE",
    eventId: "event-1",
    taskId: "task-1",
    status: "DELIVERED",
  }), ValidationError);
});
