const crypto = require("node:crypto");

function safeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function parseApiKeys(raw) {
  const keys = [];
  for (const entry of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error("API_KEYS debe usar el formato cliente:secreto[,cliente:secreto]");
    }
    const clientId = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(clientId) || secret.length < 16) {
      throw new Error("API_KEYS contiene un cliente inválido o un secreto menor de 16 caracteres");
    }
    keys.push({ clientId, secret });
  }
  return keys;
}

function parseBasic(header) {
  try {
    const encoded = header.slice(6).trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function createHttpAuth(config, logger) {
  const apiKeys = parseApiKeys(config.apiKeys);

  return function httpAuth(req, res, next) {
    const authorization = req.headers.authorization || "";
    let clientId = null;

    if (authorization.startsWith("Bearer ")) {
      const supplied = authorization.slice(7).trim();
      const match = apiKeys.find(({ secret }) => safeEqual(secret, supplied));
      if (match) clientId = match.clientId;
    } else if (
      authorization.startsWith("Basic ") &&
      config.basicAuthUser &&
      config.basicAuthPass
    ) {
      const credentials = parseBasic(authorization);
      if (
        credentials &&
        safeEqual(config.basicAuthUser, credentials.username) &&
        safeEqual(config.basicAuthPass, credentials.password)
      ) {
        clientId = config.basicAuthUser;
      }
    }

    if (!clientId) {
      logger.warn("Autenticación HTTP rechazada", { ip: req.ip });
      res.setHeader("WWW-Authenticate", 'Bearer realm="sms-api", Basic realm="sms-api"');
      return res.status(401).json({ error: "unauthorized", message: "Credenciales inválidas" });
    }

    req.clientId = clientId;
    next();
  };
}

function bearerToken(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

function securityHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}

module.exports = { bearerToken, createHttpAuth, safeEqual, securityHeaders };
