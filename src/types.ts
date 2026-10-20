/** Fila de la tabla `sessions`. */
export interface SessionRow {
  id: string;
  name: string;
  api_key: string | null;
  webhook_secret: string | null;
  owner_uid: string | null;
  owner_name: string | null;
  owner_email: string | null;
  area: string | null;
  status: string;
  phone: string | null;
  expected_phone: string | null;
  phone_verified_at: string | null;
  last_error: string | null;
  blocked_reason: string | null;
  proxy_url: string | null;
  created_at: string;
  updated_at: string;
}

/** Fila de la tabla `batches`. */
export interface BatchRow {
  id: number;
  session_id: string | null;
  name: string | null;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  status: string;
  meta: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Fila de la tabla `batch_items`. */
export interface BatchItemRow {
  id: number;
  batch_id: number;
  chat_id: string;
  contact_name: string | null;
  body: string | null;
  content_type: string | null;
  media_path: string | null;
  media_mime: string | null;
  external_ref: string | null;
  status: string;
  error: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Fila de la tabla `conversations` (inbox). */
export interface ConversationRow {
  id: number;
  session_id: string;
  whatsapp_phone: string | null;
  chat_id: string;
  contact_name: string | null;
  programa: string | null;
  programa_id: number | null;
  last_message_at: string | null;
  last_message_text: string | null;
  unread_count: number;
  last_direction: string | null;
  history_synced_at: string | null;
  status: string;
  assigned_agent_id: number | null;
  contact_id: number | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Fila de la tabla `messages`. */
export interface MessageRow {
  id: number;
  session_id: string | null;
  session_phone: string | null;
  chat_id: string;
  contact_name: string | null;
  direction: string;
  content_type: string;
  body: string | null;
  /** JSON con datos de contactos, encuestas u otros mensajes especiales. */
  content_meta: string | null;
  /** Fijado interno del panel (no se sincroniza con WhatsApp). */
  pinned_at: string | null;
  pinned_by: number | null;
  media_mime: string | null;
  media_path: string | null;
  media_filename: string | null;
  media_seconds: number | null;
  wa_message_id: string | null;
  status: string;
  transcription: string | null;
  origin: string | null;
  reply_to_wa_id: string | null;
  /** Autor del mensaje citado según WhatsApp (contextInfo.participant). */
  reply_to_sender?: string | null;
  /** Texto del mensaje citado según WhatsApp. */
  reply_to_body?: string | null;
  sender_type: string | null;
  sender_uid: number | null;
  sender_jid: string | null;
  /** Referencia serializada para descargar la media más tarde. */
  media_ref: string | null;
  /** Estado de la media: NULL (sin intentar), 'ok' o 'missing'. */
  media_state: string | null;
  occurred_at: string;
  created_at: string;
}

/** Fila de la tabla `contacts`. */
export interface ContactRow {
  id: number;
  session_id: string;
  chat_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  avatar_path: string | null;
  /** Teléfono solo con dígitos (une a la persona entre líneas); lo mantiene un trigger. */
  phone_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Fila de la tabla `contact_notes`. */
export interface ContactNoteRow {
  id: number;
  contact_id: number;
  user_id: number | null;
  note_text: string | null;
  audio_path: string | null;
  due_at: string | null;
  /** Seguimiento completado (null = pendiente). */
  done_at: string | null;
  done_by: number | null;
  /** 1 = importante: se fija arriba del chat en todas las líneas. */
  pinned: number;
  /** En la papelera desde (null = activa). */
  deleted_at: string | null;
  deleted_by: number | null;
  /** Hora del recordatorio (HH:MM) del día `due_at`, o null. */
  due_time: string | null;
  /** Cuándo se avisó el recordatorio (null = pendiente de avisar). */
  reminded_at: string | null;
  /** Derivación: quién la derivó y cuándo. */
  assigned_by: number | null;
  assigned_at: string | null;
  /** Cuándo la vio el responsable. */
  seen_at: string | null;
  /** Confirmación del responsable de que se comunicó con el contacto. */
  contacted_at: string | null;
  contacted_by: number | null;
  contact_result: string | null;
  /** Etapa manual del pipeline ('todo' | 'doing'); null = según los datos. */
  pipeline_stage?: string | null;
  /** Responsable de la tarea (null = sin asignar). */
  assigned_to: number | null;
  /** Mensaje del chat desde el que se registró (si se guardó desde una burbuja). */
  source_message_id: number | null;
  updated_at: string | null;
  created_at: string;
}

/** Fila de la tabla `note_tags` (etiquetas de notas, globales). */
export interface NoteTagRow {
  id: number;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

/** Fila de la tabla `message_reactions`. */
export interface MessageReactionRow {
  id: number;
  message_id: number;
  session_id: string | null;
  chat_id: string;
  actor_type: string;
  actor_id: string | null;
  emoji: string;
  created_at: string;
}

/** Fila de la tabla `quick_replies`. */
export interface QuickReplyRow {
  id: number;
  shortcut: string;
  content: string;
  user_id: number | null;
  shared: number;
  created_at: string;
  updated_at: string;
}

/** Payload de media en base64 (mismo contrato que openwa_basico). */
export interface MediaPayload {
  base64?: string;
  mimetype?: string;
  filename?: string;
  content_type?: string;
}

/** Envio de un solo mensaje (lo implementa SessionManager). */
export interface OutboundSender {
  sendText(sessionId: string, chatId: string, text: string): Promise<{ messageId?: string }>;
  sendMedia(    sessionId: string,
    chatId: string,
    opts: {
      type: string;
      contents: Buffer;
      mimetype: string;
      filename?: string;
      caption?: string;
      ptt?: boolean;
    },
  ): Promise<{ messageId?: string }>;
  /** ¿El número tiene WhatsApp? (verificación previa anti-baneo). Opcional. */
  checkNumber?(sessionId: string, number: string): Promise<{ exists: boolean; jid: string | null }>;
  /** Asocia metadatos (programa) a la conversación. Opcional. */
  tagConversation?(
    sessionId: string,
    chatId: string,
    tag: { contactName?: string | null; programa?: string | null; programaId?: number | null },
  ): void;
}
