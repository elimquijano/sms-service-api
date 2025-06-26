// --- Dependencias ---
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const url = require("url");
require("dotenv").config();
const logger = require("./logger");

// --- Configuración y Constantes ---
const PORT = process.env.PORT || 3000;
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;
const WEBSOCKET_TOKEN = process.env.WEBSOCKET_TOKEN;
const QUEUE_FILE_PATH = "./queue.json";
const SEND_INTERVAL_MS = 5000;

// NUEVO: Límite de caracteres para un solo mensaje.
const MAX_MESSAGE_LENGTH = 250;

// --- Estado en Memoria y Persistencia ---
let phoneSocket = null;
let pendingTasks = [];

function loadPendingTasks() {
  try {
    if (fs.existsSync(QUEUE_FILE_PATH)) {
      const data = fs.readFileSync(QUEUE_FILE_PATH);
      pendingTasks = JSON.parse(data.toString() || "[]");
      logger.info(
        `Se cargaron ${pendingTasks.length} tareas pendientes desde queue.json.`
      );
    } else {
      logger.info("No se encontró queue.json. Iniciando con una cola vacía.");
    }
  } catch (error) {
    logger.error(`Error al cargar la cola de tareas: ${error.message}`, {
      error,
    });
    pendingTasks = [];
  }
}

function savePendingTasks() {
  try {
    fs.writeFileSync(QUEUE_FILE_PATH, JSON.stringify(pendingTasks, null, 2));
  } catch (error) {
    logger.error(
      `Error crítico al guardar la cola de tareas: ${error.message}`,
      { error }
    );
  }
}

function parseNumbers(input) {
  if (!input) return [];
  const numbers = input
    .split(",")
    .map((num) => num.trim())
    .filter((num) => /^\d{9}$/.test(num));
  const formattedNumbers = numbers.map((num) => `+51${num}`);
  return formattedNumbers.length > 0 ? formattedNumbers : [];
}

const basicAuthMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Acceso restringido"');
    return res.status(401).send("Autenticación requerida.");
  }
  const [type, credentials] = authHeader.split(" ");
  if (type !== "Basic") {
    logger.warn(
      `Intento de autenticación con tipo no soportado desde ${req.ip}`
    );
    return res.status(401).send("Tipo de autenticación no soportado.");
  }
  const [username, password] = Buffer.from(credentials, "base64")
    .toString()
    .split(":");
  if (username === BASIC_AUTH_USER && password === BASIC_AUTH_PASS) {
    return next();
  }
  logger.warn(
    `Intento de autenticación fallido para el usuario '${username}' desde ${req.ip}`
  );
  res.setHeader("WWW-Authenticate", 'Basic realm="Acceso restringido"');
  res.status(401).send("Credenciales inválidas.");
};

const app = express();
app.use(express.json());

// MODIFICADO: Se añade la validación de longitud del mensaje.
app.post("/send-sms", basicAuthMiddleware, (req, res) => {
  const { numeros, mensaje } = req.body;
  logger.info("Recibida solicitud /send-sms");

  if (!numeros || !mensaje) {
    logger.warn("Solicitud /send-sms con campos faltantes.", {
      body: req.body,
    });
    return res
      .status(400)
      .json({ error: 'Los campos "numeros" y "mensaje" son obligatorios.' });
  }

  // NUEVO: Validar la longitud del mensaje.
  if (mensaje.length > MAX_MESSAGE_LENGTH) {
    logger.warn(
      `Solicitud /send-sms rechazada por exceder el límite de caracteres. Longitud: ${mensaje.length}`
    );
    // 413 Payload Too Large es el código de estado semánticamente correcto.
    return res.status(413).json({
      error: `El mensaje excede el límite de ${MAX_MESSAGE_LENGTH} caracteres.`,
      longitud_enviada: mensaje.length,
      limite_permitido: MAX_MESSAGE_LENGTH,
    });
  }

  const arrayNumeros = parseNumbers(numeros);
  if (arrayNumeros.length === 0) {
    logger.warn("Solicitud /send-sms con formato de números inválido.");
    return res.status(400).json({
      error:
        'El campo "numeros" debe ser un string con números separados por comas.',
    });
  }

  const taskIds = [];

  arrayNumeros.forEach((numero, index) => {
    const task = {
      taskId: `sms_${Date.now()}_${index}`,
      numero,
      mensaje,
      attempts: 1,
    };
    pendingTasks.push(task);
    taskIds.push(task.taskId);
  });

  savePendingTasks();
  logger.info(
    `${arrayNumeros.length} tareas nuevas añadidas a la cola. Total pendiente: ${pendingTasks.length}`
  );

  res.status(202).json({
    message: `Enviando ${arrayNumeros.length} solicitud${
      arrayNumeros.length == 1 ? "" : "es"
    } de SMS.`,
    taskIds: taskIds,
  });
});

app.get("/status", basicAuthMiddleware, (req, res) => {
  res.status(200).json({
    phone_connected: !!phoneSocket,
    pending_tasks_count: pendingTasks.length,
    pending_tasks: pendingTasks,
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const parsedUrl = url.parse(request.url, true);
  const token = parsedUrl.query.token;
  if (token === WEBSOCKET_TOKEN) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    logger.warn(
      `Intento de conexión WebSocket con token inválido desde ${request.socket.remoteAddress}`
    );
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  logger.info(
    `Teléfono conectado exitosamente desde ${req.socket.remoteAddress}.`
  );
  phoneSocket = ws;

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      logger.info(`Mensaje recibido del teléfono: ${message}`);

      if (data.type === "STATUS_UPDATE") {
        if (data.status === "SENT") {
          logger.info(`Confirmación de envío para la tarea ${data.taskId}.`);
        } else if (data.status === "FAILED") {
          logger.error(
            `Fallo reportado para la tarea ${data.taskId}. Detalles: ${data.details}. Re-encolando.`
          );
          if (data.task) {
            pendingTasks.push(data.task);
            savePendingTasks();
          } else {
            logger.error(
              `No se pudo re-encolar la tarea ${data.taskId} porque no se incluyó el objeto de la tarea.`
            );
          }
        }
      }
    } catch (error) {
      logger.error(`Error procesando mensaje del teléfono: ${error.message}`, {
        error,
      });
    }
  });

  ws.on("close", () => {
    logger.warn("El teléfono se ha desconectado.");
    phoneSocket = null;
  });

  ws.on("error", (error) => {
    logger.error(
      `Error en la conexión WebSocket del teléfono: ${error.message}`,
      { error }
    );
  });
});

async function startSenderLoop() {
  logger.info(
    `Bucle de envío iniciado. Verificando tareas cada segundo. Intervalo de envío: ${
      SEND_INTERVAL_MS / 1000
    }s.`
  );

  while (true) {
    if (
      phoneSocket &&
      phoneSocket.readyState === WebSocket.OPEN &&
      pendingTasks.length > 0
    ) {
      const task = pendingTasks.shift();
      savePendingTasks();

      logger.info(
        `Despachando tarea ${task.taskId} desde la cola. Tareas restantes: ${pendingTasks.length}`
      );
      phoneSocket.send(JSON.stringify({ type: "NEW_TASK", payload: task }));

      await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

server.listen(PORT, "0.0.0.0", () => {
  loadPendingTasks();
  logger.info(`Servidor HTTP y WebSocket iniciado en puerto ${PORT}`);
  logger.info(`Token de WebSocket configurado.`);
  startSenderLoop();
});
