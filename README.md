# Foto a 3D (web)

Servicio web móvil protegido con contraseña: haces una foto con el teléfono, la API de Tripo genera un modelo 3D en formato GLB en la nube, y lo visualizas y giras directamente en el navegador del móvil.

Es la versión en la nube del proyecto local [foto-a-3d](../foto-a-3d): en lugar de procesar en local, el servidor llama a la [API REST de Tripo V3](https://platform.tripo3d.ai) directamente.

## Cómo funciona

1. Abres la web en el móvil (usuario `edu`, contraseña en `WEB_PASSWORD`) y haces una foto (JPEG, PNG, WebP o BMP, máx. 20 MB).
2. El servidor sube la imagen a Tripo (`POST /v3/files`), crea la tarea (`POST /v3/generation/image-to-model`) y guarda el estado en `data/jobs.json`.
3. La web consulta el estado cada 2 segundos; cuando la tarea termina, el servidor descarga el GLB inmediatamente (las URLs de salida de Tripo caducan en ~5 minutos) y lo sirve desde `data/models/`.
4. El modelo se muestra con `<model-viewer>`: gíralo con el dedo y descárgalo como GLB.

Si el servidor se reinicia, los trabajos en curso se recuperan de `data/jobs.json` y siguen consultándose (el estado real vive en Tripo, asociado al `taskId`).

## Requisitos

- Node.js 20 o superior (en producción: Docker)
- Una API key de Tripo

## Variables de entorno

| Variable      | Obligatoria | Por defecto | Descripción                                                  |
| ------------- | ----------- | ----------- | ------------------------------------------------------------ |
| `TRIPO_API_KEY` | Sí         | —           | API key de Tripo                                             |
| `WEB_PASSWORD`  | Sí         | —           | Contraseña del acceso HTTP Basic (usuario `edu`). Si falta, el servidor no arranca |
| `PORT`          | No         | `3000`      | Puerto HTTP                                                  |
| `DATA_DIR`      | No         | `./data`    | Directorio de estado (`jobs.json` y modelos GLB)             |

Copia `.env.example` a `.env`, rellénalo y expórtalo antes de arrancar:

```sh
set -a; source .env; set +a
```

## Arranque en local

```sh
npm install
npm start        # http://localhost:3000
npm test         # suite offline (sin red)
```

## Despliegue en Coolify

1. **New Resource → Application** apuntando al repositorio (deploy basado en el `Dockerfile` del repo).
2. **Puerto**: `3000` (ya expuesto en el Dockerfile).
3. **Variables de entorno**: `TRIPO_API_KEY` y `WEB_PASSWORD` (obligatorias). Opcionalmente `PORT` y `DATA_DIR`.
4. **Volumen persistente**: monta un volumen en `/app/data` para que `jobs.json` y los modelos GLB sobrevivan a los reinicios.
5. **Healthcheck**: el Dockerfile ya incluye uno contra `GET /api/health` (no requiere autenticación); úsalo también como healthcheck de Coolify.

## Aviso de coste

Cada generación consume **~30 créditos de Tripo**. No hay límite en el servidor más que "una generación a la vez", así que protege bien `WEB_PASSWORD`: cualquiera con acceso puede gastar tus créditos.
