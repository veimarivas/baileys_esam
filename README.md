# baileys_esam

Gateway de WhatsApp basado en **Baileys** (WebSocket, **sin Chromium**) para
**Seguimiento ESAM**: envío de mensajes, lotes con control anti-baneo,
plantillas y un panel web de operación.

## Funcionalidades

- **Gateway WhatsApp multi-número**: QR o código de vinculación, número
  autorizado por sesión (bloquea si se vincula otro), reconexión automática,
  recuperación de mensajes recibidos con el sistema cerrado e historial al vincular.
- **API de integración v1** para cronogramas: cuentas, grupos, lotes con
  plantillas/media/idempotencia, importación CSV, PDFs, salud por usuario.
- **Lotes con anti-baneo**: perfiles de riesgo, calentamiento de números, ritmo
  aleatorio y pausas por cansancio, ventana horaria, límites diario/horario, tope
  de contactos nuevos, verificación de que el número tenga WhatsApp, "escribiendo…"
  simulado, pausa automática por entregabilidad baja, cuarentena y rotación de
  sesiones, lista negra y opt-out.
- **Panel web** (plantilla Velzon, paleta institucional, modo oscuro):
  - **Conversaciones** en tiempo real (SSE): individuales y grupos, imágenes,
    video, audio con transcripción, documentos, stickers, citas, reacciones,
    notas de voz, plantillas rápidas. La media que no llegó en vivo se descarga
    al abrirla; si WhatsApp ya no la tiene, se avisa en lugar de quedar cargando.
  - **Notas internas** por contacto con etiquetas y **seguimiento con fecha**
    (marcar hecho, vencidas, para hoy) y un tablero en `/notes`.
  - Lotes, plantillas, auto-respuestas, stickers, monitoreo, reportes, actividad
    por usuario, auditoría, usuarios y conexión.
  - Acceso por **SSO de cronogramas** o admin local; cada usuario ve solo las
    conversaciones de su número.
- **Operación segura**: instancia única (bloqueo sobre las credenciales),
  versión visible en el panel, **respaldo diario** automático, retención de media
  y cola de reintentos de webhooks.

## Licencia y terceros

- Código propio del proyecto: uso interno de Seguimiento ESAM.
- **Velzon** (Themesbrand) es una plantilla comercial y **no** se redistribuye.
- Incluidos: fuente **Inter** (SIL Open Font License) y **opus-recorder** (MIT).
