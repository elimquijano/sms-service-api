# SMS Service API

Servicio HTTP durable que recibe solicitudes individuales o masivas, las guarda en JSON y entrega una orden a la vez al gateway Android definido en [`api.md`](api.md). Una tarea solo sale de la cola activa después de que su estado fue persistido.

## Garantías principales

- Estado durable en `data/sms-state.json`, con escritura temporal, sincronización a disco, reemplazo atómico y respaldo `.bak`.
- Idempotencia HTTP mediante `Idempotency-Key`, por cliente, e idempotencia WebSocket mediante `eventId`.
- Un solo SMS en vuelo. El siguiente se despacha después de `SENT` o `FAILED`, respetando intervalo, tamaño de ráfaga y pausa.
- Reintentos con backoff exponencial y jitter ante fallos, desconexión o vencimiento del ACK.
- Protección de sobrecarga por tamaño máximo de cuerpo, lote, cola y rate limits por cliente/IP.
- WebSocket autenticado por `Authorization: Bearer ...`, ruta exacta `/android`, heartbeat y límite de payload.
- No se registran cuerpos, números ni mensajes en logs. `/status` tampoco expone el texto de los SMS.
- El texto se elimina del estado JSON cuando la tarea llega a un estado terminal para reducir exposición y crecimiento del archivo.
- Apagado ordenado y recuperación de tareas que estaban en vuelo.

> JSON funciona bien para una sola instancia y volúmenes moderados. No ejecutes dos procesos sobre el mismo archivo: esta implementación garantiza exclusión dentro de un proceso, no un bloqueo distribuido.

Si existe el antiguo `queue.json`, se importa una sola vez al nuevo estado conservando sus `taskId`; el archivo original no se elimina.

## Requisitos e inicio

- Node.js 20 o posterior.
- Un proxy TLS (Nginx, Caddy, balanceador cloud) en producción.

```bash
npm install
copy .env.example .env
npm start
```

En producción configura `NODE_ENV=production`, secretos distintos y aleatorios, `TRUST_PROXY=true` si existe un único proxy confiable y `REQUIRE_HTTPS=true`. El proceso falla al iniciar si faltan credenciales.

## Autenticación

La forma recomendada para clientes HTTP es:

```http
Authorization: Bearer secreto-del-cliente
```

`API_KEYS` acepta `cliente:secreto` y varias entradas separadas por coma. Basic Auth continúa disponible si se configuran `BASIC_AUTH_USER` y `BASIC_AUTH_PASS`.

Android se conecta exclusivamente a `ws(s)://host/android` y coloca `WEBSOCKET_TOKEN` en el header Bearer, tal como exige `api.md`. No se aceptan tokens en la URL.

## Encolar mensajes

`POST /v1/messages` es el endpoint recomendado; `POST /send-sms` se conserva como alias compatible.

```bash
curl -X POST https://gateway.example.com/v1/messages \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Idempotency-Key: factura-2026-0001" \
  -H "Content-Type: application/json" \
  -d '{"numeros":["+51987654321","987654322"],"mensaje":"Hola"}'
```

Respuesta `202 Accepted`:

```json
{
  "requestId": "a5bfb2dc-62d7-4ebc-90de-27286f48ec15",
  "accepted": 2,
  "duplicate": false,
  "taskIds": ["sms-...", "sms-..."],
  "statusUrl": "/v1/requests/a5bfb2dc-62d7-4ebc-90de-27286f48ec15"
}
```

Repetir exactamente la solicitud con la misma clave devuelve `200` y `duplicate: true`. Reutilizarla con números o mensaje distintos devuelve `409`.

Los números pueden ser un arreglo o un string separado por comas. Un número local de nueve dígitos recibe `DEFAULT_COUNTRY_CODE`; los demás deben contener entre 6 y 20 dígitos y pueden iniciar con `+`.

El mensaje tiene un límite HTTP absoluto de 300 caracteres, pero además debe caber en **una sola parte SMS**. El servidor calcula la codificación antes de encolar: hasta 160 unidades GSM-7 o 70 unidades Unicode. Caracteres de la extensión GSM como `^`, `{`, `}` y `€` consumen dos unidades; los emojis normalmente consumen dos unidades Unicode. Si Android tendría que dividir el texto, la API responde `400` y no crea tareas.

## Consulta y operación

- `GET /v1/requests/:requestId`: resumen y tareas de una solicitud del cliente autenticado.
- `GET /v1/tasks/:taskId`: estado de una tarea.
- `POST /v1/tasks/:taskId/cancel`: cancela una tarea que todavía no fue despachada.
- `GET /status`: versión/instancia, conexión del teléfono, política efectiva, presión de cola y conteos; requiere autenticación.
- `GET /health/live`: vida del proceso.
- `GET /health/ready`: `200` si Android está listo, `503` si el servicio está degradado.

Estados internos: `QUEUED`, `DISPATCHED`, `PROCESSING`, `RETRY_WAIT`, `SENT`, `FAILED`, `DEAD_LETTER` y `CANCELLED`. `SENT` significa que Android confirmó el envío al módem, no que el operador confirmó entrega al destinatario.

## Ritmo, ráfagas y reintentos

Los controles se definen en `.env`:

- `SEND_INTERVAL_MS`: pausa mínima entre órdenes.
- `ANDROID_SMS_RPM`: presupuesto máximo de intentos por minuto; admite hasta 30 y por defecto usa 20. El servidor eleva automáticamente la pausa mínima a `60000 / RPM` aunque `SEND_INTERVAL_MS` sea menor.
- `BURST_SIZE` y `BURST_PAUSE_MS`: cantidad por ráfaga y pausa posterior.
- `ACK_TIMEOUT_MS`: tiempo máximo de una tarea en vuelo.
- `MAX_RETRIES` admite como máximo `2`; son dos reintentos después del envío inicial.
- `RETRY_BASE_MS` y `RETRY_MAX_MS`: espera exponencial entre reintentos.
- `MODEM_ERROR_PAUSE_MS`, `NETWORK_ERROR_PAUSE_MS` y `RATE_LIMIT_PAUSE_MS`: circuito global según el código devuelto por Android. Un error de módem como 124 pausa 60 segundos; el rate limit 106 pausa 120 segundos.
- `MAX_QUEUE_SIZE` y `MAX_QUEUED_MESSAGE_BYTES`: rechazan con `503` antes de sobrecargar memoria o disco.
- `IP_RATE_PER_MINUTE`, `REQUEST_RATE_PER_MINUTE` y `RECIPIENT_RATE_PER_MINUTE`: límites por IP, cliente y destinatarios; responde `429` con `Retry-After`.

Una desconexión o reinicio vuelve a programar el mismo `taskId`; la idempotencia de la app evita los duplicados normales. Como explica `api.md`, no existe una transacción atómica entre servidor, Android y módem, por lo que permanece una ventana física imposible de eliminar por completo.

El historial terminal y sus claves de idempotencia se conservan durante `RETENTION_DAYS` (365 por defecto) y después se depuran. Ajusta ese periodo a tus requisitos de auditoría.

## Pruebas

```bash
npm test
npm run check
```
