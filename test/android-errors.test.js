const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyAndroidFailure, extractAndroidErrorCode } = require("../src/android-errors");

const config = {
  modemErrorPauseMs: 60_000,
  networkErrorPauseMs: 30_000,
  rateLimitPauseMs: 120_000,
};

test("extrae y clasifica el error genérico RIL 124", () => {
  assert.equal(extractAndroidErrorCode("parte 0: error Android 124"), 124);
  assert.deepEqual(classifyAndroidFailure("parte 0: error Android 124", config), {
    code: 124,
    category: "RIL_GENERIC_ERROR",
    retryable: true,
    retryAfterMs: 60_000,
    gatewayPauseMs: 60_000,
  });
});

test("distingue rate limit y errores permanentes", () => {
  assert.equal(classifyAndroidFailure("error Android 106", config).gatewayPauseMs, 120_000);
  assert.equal(classifyAndroidFailure("error Android 109", config).retryable, false);
  assert.equal(classifyAndroidFailure("fallo sin código", config).category, "UNKNOWN");
});
