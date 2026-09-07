const fs = require("node:fs");
const path = require("node:path");
const winston = require("winston");
require("winston-daily-rotate-file");

function createLogger(level = "info") {
  const logDir = path.join(__dirname, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  return winston.createLogger({
    level,
    defaultMeta: { service: "sms-service-api" },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: false }),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
          winston.format.printf(({ timestamp, level: logLevel, message, ...meta }) => {
            const details = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
            return `${timestamp} ${logLevel}: ${message}${details}`;
          })
        ),
      }),
      new winston.transports.DailyRotateFile({
        filename: path.join(logDir, "sms-%DATE%.json.log"),
        datePattern: "YYYY-MM-DD",
        zippedArchive: true,
        maxSize: "20m",
        maxFiles: "14d",
      }),
    ],
    exitOnError: false,
  });
}

module.exports = { createLogger };
