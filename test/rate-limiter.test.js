const assert = require("node:assert/strict");
const test = require("node:test");

const { TokenBucketLimiter } = require("../src/rate-limiter");

test("limita ráfagas y repone capacidad con el tiempo", () => {
  const limiter = new TokenBucketLimiter({ capacity: 2, refillPerMinute: 60 });
  assert.equal(limiter.consume("client", 1, 1000).allowed, true);
  assert.equal(limiter.consume("client", 1, 1000).allowed, true);
  const blocked = limiter.consume("client", 1, 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 1000);
  assert.equal(limiter.consume("client", 1, 2000).allowed, true);
});
