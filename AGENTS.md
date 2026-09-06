# Reglas de Desarrollo y Arquitectura del Proyecto (Bot Surfshark)

## 1. Arquitectura Limpia y Separación de Capas
El proyecto sigue una arquitectura modular y estricta en `/src`:
- `/src/config`: Carga y validación estricta de variables de entorno usando tipado y valores por defecto controlados.
- `/src/db`: Cliente de base de datos (Prisma Client) y repositorios/helpers para persistencia de datos.
- `/src/services`: Capa de red y lógica de negocio externa (ej. `VpnServiceAdapter`), desacoplada completamente de la capa de Telegram.
- `/src/bot/middlewares`: Interceptores de Telegraf para control de acceso estricto (validación silenciosa de `group_id`, `topic_id` y bypass del `OWNER_ID`), rate-limiting y sanitización.
- `/src/bot/commands`: Manejadores de comandos y eventos de Telegram (`/start`, `/status`, `/settopic`, listener de códigos de activación).

## 2. Seguridad y Variables de Entorno
- Todas las credenciales críticas (`BOT_TOKEN`, `VPN_API_BEARER_TOKEN`, `VPN_API_BASE_URL`, `DATABASE_URL`, `OWNER_ID`) deben residir exclusivamente en variables de entorno leídas a través de `.env`.
- Está prohibido hardcodear tokens o URLs internas en el código fuente.
- Se debe proveer un archivo `.env.example` actualizado con descripciones claras.

## 3. Resiliencia y Estabilidad
- **Manejo de Errores Aislado:** Todas las operaciones asíncronas y llamadas HTTP externas (usando Axios/Fetch) deben estar envueltas en bloques de manejo de errores específicos (`AxiosError`).
- El fallo en una llamada a un servicio externo o a la base de datos nunca debe tumbar (crash) el proceso de Node.js.
- Se debe notificar al usuario con un mensaje claro y amigable ante fallos externos, registrando el error detallado en la consola/logger con contexto.
- Configurar interceptores globales para `uncaughtException` y `unhandledRejection`.
