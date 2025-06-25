# SMS Service API

Este proyecto es una API para el envío de SMS utilizando WebSocket y Express. Permite enviar mensajes a números de teléfono y gestionar tareas pendientes.

## Tabla de Contenidos

- [Características](#características)
- [Dependencias](#dependencias)
- [Configuración](#configuración)
- [Uso](#uso)
- [API](#api)
- [Registro de Logs](#registro-de-logs)
- [Contribuciones](#contribuciones)

## Características

- Envío de SMS a múltiples números.
- Manejo de tareas pendientes.
- Autenticación básica para la API.
- Conexión WebSocket para recibir actualizaciones en tiempo real.

## Dependencias

Este proyecto utiliza las siguientes dependencias:

- `express`: Framework web para Node.js.
- `http`: Módulo nativo de Node.js para crear servidores HTTP.
- `ws`: Librería para WebSocket.
- `fs`: Módulo nativo de Node.js para manejar el sistema de archivos.
- `url`: Módulo nativo de Node.js para manejar URLs.
- `dotenv`: Carga variables de entorno desde un archivo `.env`.
- `winston`: Librería para el registro de logs.
- `winston-daily-rotate-file`: Transportador para rotación diaria de archivos de log.

## Configuración

1. Clona el repositorio:

```bash
git clone https://github.com/elimquijano/sms-service-api.git
cd sms-service-api
```

2. Instala las dependencias:

```bash
npm install
```

3. Crea un archivo .env en la raíz del proyecto y define las siguientes variables:

```bash
PORT=3000
BASIC_AUTH_USER=tu_usuario
BASIC_AUTH_PASS=tu_contraseña
WEBSOCKET_TOKEN=tu_token
```

## Uso

Para iniciar el servidor, ejecuta el siguiente comando:

```bash
node server.js
```

El servidor escuchará en el puerto definido en la variable de entorno PORT.

## API

# Enviar SMS
- Endpoint: POST /send-sms

- Autenticación: Básica

- Cuerpo de la solicitud:

```json
{
  "numeros": "987654321,987654321",
  "mensaje": "Tu mensaje aquí"
}
```

- Respuesta:

**202 Accepted:** La solicitud ha sido aceptada y está en proceso.
**400 Bad Request:** Si faltan campos o el formato de números es inválido.

# Estado

- Endpoint: GET /status

- Autenticación: Básica

- Respuesta:

```json
{
  "phone_connected": true,
  "pending_tasks_count": 0,
  "pending_tasks": []
}
```

## Registro de Logs

Los logs se registran en la consola y se guardan en archivos rotativos diarios en la carpeta logs. Los archivos de log se comprimen y se conservan durante 14 días.

## Contribuciones

Las contribuciones son bienvenidas. Si deseas contribuir, por favor abre un issue o envía un pull request.