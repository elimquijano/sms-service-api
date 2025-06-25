const winston = require("winston");
const path = require("path");
require("winston-daily-rotate-file");

const logDir = path.join(__dirname, "logs");

// Define el formato del log
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

// Transport para rotación diaria de archivos
const dailyRotateFileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDir, "log-%DATE%.log"),
  datePattern: "YYYY-MM-DD",
  zippedArchive: true, // Comprime los logs antiguos
  maxSize: "20m", // Rota el archivo si alcanza 20MB
  maxFiles: "14d", // Conserva los logs de los últimos 14 días
});

const logger = winston.createLogger({
  level: "info", // Nivel mínimo de log a registrar
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(), // Añade colores a la consola
        logFormat
      ),
    }),
    dailyRotateFileTransport,
  ],
  exitOnError: false,
});

module.exports = logger;
