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

// --- Estado en Memoria y Persistencia ---
let phoneSocket = null; // Almacenará el socket del único teléfono conectado
let pendingTasks = []; // La cola de tareas ahora es un simple array

// Carga las tareas pendientes de un archivo al iniciar
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

// Guarda las tareas pendientes en un archivo
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

// --- Lógica de Procesamiento de Tareas ---
function processAndSendTask(task) {
  if (phoneSocket && phoneSocket.readyState === WebSocket.OPEN) {
    phoneSocket.send(JSON.stringify({ type: "NEW_TASK", payload: task }));
    logger.info(`Tarea ${task.taskId} enviada en tiempo real al teléfono.`);
  } else {
    pendingTasks.push(task);
    savePendingTasks();
    logger.warn(
      `Teléfono no conectado. Tarea ${task.taskId} encolada. Tareas pendientes: ${pendingTasks.length}`
    );
  }
}

// --- Función para Parsear Números ---

function parseNumbers(input) {
  // Verificamos si la entrada es una cadena vacía
  if (!input) {
    return [];
  }

  // Dividimos la cadena por comas y filtramos los elementos que son números de 9 caracteres
  const numbers = input
    .split(",")
    .map((num) => num.trim())
    .filter((num) => /^\d{9}$/.test(num)); // Verificamos que tenga exactamente 9 dígitos

  // Añadimos el prefijo "+51" a cada número válido
  const formattedNumbers = numbers.map((num) => `+51${num}`);

  // Retornamos el array de números formateados solo si hay números válidos
  return formattedNumbers.length > 0 ? formattedNumbers : [];
}

// --- Middleware de Autenticación Básica para la API ---
const basicAuthMiddleware = (req, res, next) => {
  // ... (el código del middleware es el mismo que en la versión anterior)
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

// --- Servidor Express (API HTTP) ---
const app = express();
app.use(express.json());

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

  const arrayNumeros = parseNumbers(numeros);
  if (arrayNumeros.length === 0) {
    logger.warn("Solicitud /send-sms con formato de números inválido.");
    return res.status(400).json({
      error:
        'El campo "numeros" debe ser un string con números separados por comas.',
    });
  }

  // Crear un arreglo para almacenar los taskIds
  const taskIds = [];

  // Crear una tarea para cada número
  arrayNumeros.forEach((numero) => {
    const task = {
      taskId: `sms_${Date.now()}`,
      numero,
      mensaje,
      attempts: 1, // Contador de intentos
    };

    // Procesar la tarea de forma asíncrona
    processAndSendTask(task);

    // Almacenar el taskId
    taskIds.push(task.taskId);
  });

  // Responder inmediatamente con todos los taskIds
  res.status(202).json({
    message: "Solicitud de SMS aceptada y en proceso.",
    taskIds: taskIds, // Enviar todos los taskIds
  });
});

app.get("/status", basicAuthMiddleware, (req, res) => {
  res.status(200).json({
    phone_connected: !!phoneSocket,
    pending_tasks_count: pendingTasks.length,
    pending_tasks: pendingTasks,
  });
});

// --- Servidor WebSocket ---
const server = http.createServer(app);
const wss = new WebSocket.Server({
  noServer: true, // Usaremos el hook 'upgrade' para la autenticación
});

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

  // Al conectar, enviar todas las tareas pendientes
  if (pendingTasks.length > 0) {
    logger.info(
      `Enviando ${pendingTasks.length} tareas pendientes al teléfono.`
    );
    // Enviamos una copia y vaciamos la cola original
    const tasksToSend = [...pendingTasks];
    pendingTasks = [];
    savePendingTasks();

    tasksToSend.forEach((task) => {
      // Incrementamos el contador de intentos al reenviar
      task.attempts = (task.attempts || 1) + 1;
      ws.send(JSON.stringify({ type: "NEW_TASK", payload: task }));
    });
  }

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
          // El teléfono debe devolver el objeto de la tarea para poder re-encolarlo
          if (data.task) {
            pendingTasks.push(data.task);
            savePendingTasks();
          } else {
            logger.error(
              `No se pudo re-encolar la tarea ${data.taskId} porque no se incluyó el objeto de la tarea en el reporte de fallo.`
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

// --- Iniciar Servidor ---
server.listen(PORT, "0.0.0.0", () => {
  loadPendingTasks();
  logger.info(`Servidor HTTP y WebSocket iniciado en puerto ${PORT}`);
  logger.info(`Token de WebSocket configurado.`);
});
