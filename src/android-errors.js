const ERROR_POLICIES = new Map([
  [1, ["GENERIC_FAILURE", true, "modem"]],
  [2, ["RADIO_OFF", true, "network"]],
  [3, ["NULL_PDU", false, null]],
  [4, ["NO_SERVICE", true, "network"]],
  [5, ["ANDROID_RATE_LIMIT", true, "rate"]],
  [6, ["FDN_CHECK_FAILURE", false, null]],
  [7, ["SHORT_CODE_NOT_ALLOWED", false, null]],
  [8, ["SHORT_CODE_NEVER_ALLOWED", false, null]],
  [100, ["RIL_RADIO_NOT_AVAILABLE", true, "network"]],
  [101, ["RIL_SEND_FAIL_RETRY", true, "network"]],
  [102, ["RIL_NETWORK_REJECT", true, "network"]],
  [103, ["RIL_INVALID_STATE", true, "modem"]],
  [104, ["RIL_INVALID_ARGUMENTS", false, null]],
  [105, ["RIL_NO_MEMORY", true, "modem"]],
  [106, ["RIL_REQUEST_RATE_LIMITED", true, "rate"]],
  [107, ["RIL_INVALID_SMS_FORMAT", false, null]],
  [108, ["RIL_SYSTEM_ERROR", true, "modem"]],
  [109, ["RIL_ENCODING_ERROR", false, null]],
  [110, ["RIL_INVALID_SMSC_ADDRESS", false, null]],
  [111, ["RIL_MODEM_ERROR", true, "modem"]],
  [112, ["RIL_NETWORK_ERROR", true, "network"]],
  [113, ["RIL_INTERNAL_ERROR", true, "modem"]],
  [114, ["RIL_REQUEST_NOT_SUPPORTED", false, null]],
  [115, ["RIL_INVALID_MODEM_STATE", true, "modem"]],
  [116, ["RIL_NETWORK_NOT_READY", true, "network"]],
  [117, ["RIL_OPERATION_NOT_ALLOWED", false, null]],
  [118, ["RIL_NO_RESOURCES", true, "modem"]],
  [119, ["RIL_CANCELLED", true, "modem"]],
  [120, ["RIL_SIM_ABSENT", false, null]],
  [121, ["RIL_SMS_BLOCKED_DURING_CALL", true, "network"]],
  [122, ["RIL_ACCESS_BARRED", false, null]],
  [123, ["RIL_BLOCKED_DUE_TO_CALL", true, "network"]],
  [124, ["RIL_GENERIC_ERROR", true, "modem"]],
  [125, ["RIL_INVALID_RESPONSE", true, "modem"]],
  [126, ["RIL_SIM_PIN2", false, null]],
  [127, ["RIL_SIM_PUK2", false, null]],
  [128, ["RIL_SUBSCRIPTION_NOT_AVAILABLE", false, null]],
  [129, ["RIL_SIM_ERROR", true, "network"]],
  [130, ["RIL_INVALID_SIM_STATE", false, null]],
  [131, ["RIL_NO_SMS_TO_ACK", true, "modem"]],
  [132, ["RIL_SIM_BUSY", true, "network"]],
  [133, ["RIL_SIM_FULL", false, null]],
  [134, ["RIL_NO_SUBSCRIPTION", false, null]],
  [135, ["RIL_NO_NETWORK_FOUND", true, "network"]],
  [136, ["RIL_DEVICE_IN_USE", true, "modem"]],
  [137, ["RIL_ABORTED", true, "modem"]],
]);

function extractAndroidErrorCode(details) {
  if (typeof details !== "string") return null;
  const match = details.match(/(?:error\s+android|android\s*(?:error)?\s*[:=#-]?)\s*(\d{1,4})/i);
  return match ? Number(match[1]) : null;
}

function classifyAndroidFailure(details, config) {
  const code = extractAndroidErrorCode(details);
  const definition = ERROR_POLICIES.get(code);
  if (!definition) {
    return { code, category: code === null ? "UNKNOWN" : "ANDROID_UNKNOWN", retryable: true, retryAfterMs: 0, gatewayPauseMs: 0 };
  }
  const [category, retryable, cooldown] = definition;
  const pause = cooldown === "rate"
    ? config.rateLimitPauseMs
    : cooldown === "modem"
      ? config.modemErrorPauseMs
      : cooldown === "network"
        ? config.networkErrorPauseMs
        : 0;
  return { code, category, retryable, retryAfterMs: pause, gatewayPauseMs: pause };
}

module.exports = { classifyAndroidFailure, extractAndroidErrorCode };
