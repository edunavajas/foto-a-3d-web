# Foto a 3D

Servicio web móvil: sube una foto y Tripo genera un modelo 3D (GLB) que puedes girar y descargar desde el teléfono.

## Interfaz

- **Login por contraseña**: solo contraseña, sin usuario. Cookie de sesión `HttpOnly` válida 30 días (sobrevive a reinicios del servidor).
- **Dos modos de generación**:
  - **Rápido**: modelo low-poly (`P1-20260311`). Gasta menos créditos y está listo en segundos.
  - **Máxima calidad**: primero se publica el modelo rápido y después se lanza una segunda tarea de alta fidelidad (`v3.1-20260211`) reutilizando la foto ya subida. Mientras mejora ves el modelo rápido con el aviso «Mejorando a máxima calidad…»; al terminar el visor cambia al modelo HQ. Coste aproximado: Rápido gasta menos; Máxima consume una tarea P1 + una tarea v3.1. Si la fase de mejora falla, conservas el modelo rápido (la mejora es un extra, no un error).
- Animación de nube de puntos durante la generación (los colores de la foto se convierten en puntos con profundidad) y visor 3D interactivo con botón «Descargar GLB».
- La barra de progreso muestra el progreso real devuelto por la API de Tripo (estimación temporal solo hasta que la API reporta un valor).

## Desarrollo

```bash
npm install
npm run build      # construye la SPA en dist/ (Vite, root web/)
npm test           # 32 tests offline (node --test)
npm start          # sirve dist/ y la API en el puerto 3000
```

Variables de entorno (ver `.env.example`): `TRIPO_API_KEY`, `WEB_PASSWORD`, `PORT`, `DATA_DIR`.
El servidor no arranca sin `WEB_PASSWORD` y `TRIPO_API_KEY` (fail-closed).

## Despliegue (Coolify)

Sin cambios respecto al despliegue anterior:

- Dockerfile multi-etapa: etapa 1 construye la SPA, etapa 2 copia `src/` y `dist/` con dependencias de producción (solo `express` y `multer`).
- Healthcheck contra `http://127.0.0.1:3000/api/health`; el proceso escucha en dual-stack (sin argumento de host).
- Volumen en `/app/data` (`jobs.json` + `models/`). Los trabajos persisten y se reanudan tras un reinicio consultando el estado de la tarea en Tripo.
