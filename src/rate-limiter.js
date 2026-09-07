class TokenBucketLimiter {
  constructor({ capacity, refillPerMinute, ttlMs = 10 * 60_000 }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMinute / 60_000;
    this.ttlMs = ttlMs;
    this.buckets = new Map();
    this.lastSweep = Date.now();
  }

  consume(key, amount = 1, now = Date.now()) {
    this.sweep(now);
    const bucket = this.buckets.get(key) || { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;

    if (amount > bucket.tokens) {
      this.buckets.set(key, bucket);
      const retryAfterMs = Math.ceil((amount - bucket.tokens) / this.refillPerMs);
      return { allowed: false, retryAfterMs };
    }

    bucket.tokens -= amount;
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }

  sweep(now) {
    if (now - this.lastSweep < this.ttlMs) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > this.ttlMs) this.buckets.delete(key);
    }
    this.lastSweep = now;
  }
}

function rateLimitMiddleware(limiter, cost = () => 1) {
  return (req, res, next) => {
    const result = limiter.consume(`${req.clientId}:${req.ip}`, cost(req));
    if (!result.allowed) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
      return res.status(429).json({
        error: "rate_limit_exceeded",
        message: "Demasiadas solicitudes. Intenta nuevamente más tarde.",
      });
    }
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    next();
  };
}

module.exports = { TokenBucketLimiter, rateLimitMiddleware };
