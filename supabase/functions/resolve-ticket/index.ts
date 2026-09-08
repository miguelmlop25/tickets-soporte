/**
 * resolve-ticket/index.ts
 * Edge Function que permite a un Agent marcar un ticket como resuelto.
 *
 * Pipeline de procesamiento:
 *   1. CORS preflight
 *   2. Verificación de origen (enforceOrigin)
 *   3. Auth Guard — requiere rol Agent
 *   4. Rate Limiter — 100 req/IP/60s
 *   5. Validación y sanitización del input
 *   6. Transacción atómica vía RPC (resolve_ticket_transaction)
 *
 * Requisitos cubiertos: 5.5, 5.6, 5.7, 5.8, 5.9, 9.1
 *
 * POST /functions/v1/resolve-ticket
 * Body: { ticket_id: string, solucion_aplicada: string }
 *
 * Respuestas:
 *   201 — Ticket resuelto correctamente
 *   400 — Input inválido (ticket_id faltante, solución fuera de rango o con patrones no permitidos)
 *   401 — Token ausente o inválido
 *   403 — Rol incorrecto o ticket asignado a otro Agent
 *   429 — Rate limit excedido
 *   500 — Error interno del servidor
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  handleCorsPreFlight,
  enforceOrigin,
} from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth-guard.ts";
import {
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
  RATE_LIMIT_API,
} from "../_shared/rate-limiter.ts";

// ---------------------------------------------------------------------------
// Constantes de validación
// ---------------------------------------------------------------------------

/** Longitud mínima requerida para la solución aplicada (después de sanitizar) */
const SOLUCION_MIN_LENGTH = 10;

/** Longitud máxima permitida para la solución aplicada (después de sanitizar) */
const SOLUCION_MAX_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Sanitización de texto (requisito 5.9)
// ---------------------------------------------------------------------------

/**
 * Elimina etiquetas HTML, scripts y patrones potencialmente peligrosos del texto.
 * Preserva el contenido textual legítimo para que no se pierda información útil.
 *
 * @param text - Texto de entrada a sanitizar
 * @returns    - Texto limpio sin etiquetas ni patrones no permitidos
 */
function sanitizeText(text: string): string {
  return text
    // Eliminar etiquetas HTML completas (incluyendo <script>, <style>, etc.)
    .replace(/<[^>]*>/g, "")
    // Eliminar entidades HTML (ej: &lt; &gt; &amp; &#x27; &quot;)
    .replace(/&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z]+);/g, "")
    // Eliminar intentos de javascript: en atributos o texto
    .replace(/javascript\s*:/gi, "")
    // Eliminar patrones de eventos DOM inline (onclick=, onerror=, etc.)
    .replace(/on\w+\s*=/gi, "")
    // Normalizar saltos de línea y espacios múltiples para evitar inyecciones de formato
    .replace(/\r\n|\r/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Validación del input
// ---------------------------------------------------------------------------

/**
 * Valida y sanitiza el body de la petición resolve-ticket.
 *
 * @param body - Objeto parseado del body JSON
 * @returns    - { valid: true, ticketId, solucionSanitizada } | { valid: false, error, status }
 */
function validateInput(body: unknown): (
  | { valid: true; ticketId: string; solucionSanitizada: string }
  | { valid: false; error: string; status: number }
) {
  // Verificar que body sea un objeto plano
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      valid: false,
      error: "El body de la petición debe ser un objeto JSON válido.",
      status: 400,
    };
  }

  const { ticket_id, solucion_aplicada } = body as Record<string, unknown>;

  // --- ticket_id ---
  if (!ticket_id || typeof ticket_id !== "string" || !ticket_id.trim()) {
    return {
      valid: false,
      error: "El campo ticket_id es obligatorio.",
      status: 400,
    };
  }

  // Validación básica de formato UUID v4
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(ticket_id.trim())) {
    return {
      valid: false,
      error: "El campo ticket_id no tiene un formato UUID válido.",
      status: 400,
    };
  }

  // --- solucion_aplicada ---
  if (
    solucion_aplicada === undefined ||
    solucion_aplicada === null ||
    typeof solucion_aplicada !== "string"
  ) {
    return {
      valid: false,
      error: "El campo solucion_aplicada es obligatorio.",
      status: 400,
    };
  }

  // Sanitizar antes de medir la longitud (requisito 5.9)
  const solucionSanitizada = sanitizeText(solucion_aplicada);

  // Verificar longitud post-sanitización (requisito 5.6, 5.7)
  if (solucionSanitizada.length < SOLUCION_MIN_LENGTH) {
    return {
      valid: false,
      error: `La descripción de la solución debe tener al menos ${SOLUCION_MIN_LENGTH} caracteres.`,
      status: 400,
    };
  }

  if (solucionSanitizada.length > SOLUCION_MAX_LENGTH) {
    return {
      valid: false,
      error: `La descripción de la solución no puede superar ${SOLUCION_MAX_LENGTH} caracteres.`,
      status: 400,
    };
  }

  return {
    valid: true,
    ticketId: ticket_id.trim(),
    solucionSanitizada,
  };
}

// ---------------------------------------------------------------------------
// Mapeo de errores de la función SQL a respuestas HTTP
// ---------------------------------------------------------------------------

/**
 * Convierte los errores lanzados por resolve_ticket_transaction en respuestas HTTP.
 *
 * La función SQL usa RAISE EXCEPTION con mensajes semánticos que permiten
 * distinguir el tipo de fallo sin parsear texto libre.
 *
 * @param message - Mensaje de la excepción SQL
 * @returns       - { httpStatus, userMessage }
 */
function mapSqlErrorToResponse(
  message: string,
): { httpStatus: number; userMessage: string } {
  if (message.includes("TICKET_NOT_FOUND")) {
    return { httpStatus: 404, userMessage: "El ticket especificado no existe." };
  }

  if (message.includes("TICKET_ALREADY_RESOLVED")) {
    return {
      httpStatus: 409,
      userMessage: "El ticket ya se encuentra en estado Finalizado.",
    };
  }

  if (message.includes("TICKET_NOT_ASSIGNED")) {
    return {
      httpStatus: 403,
      userMessage: "El ticket no está asignado a ningún agente.",
    };
  }

  if (message.includes("TICKET_WRONG_AGENT")) {
    return {
      httpStatus: 403,
      userMessage: "No tiene permiso sobre este ticket.",
    };
  }

  // Error inesperado de base de datos
  return {
    httpStatus: 500,
    userMessage: "La operación no pudo completarse. Por favor, inténtelo nuevamente.",
  };
}

// ---------------------------------------------------------------------------
// Handler principal de la Edge Function
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // -------------------------------------------------------------------------
  // Paso 1: CORS preflight (OPTIONS)
  // -------------------------------------------------------------------------
  if (req.method === "OPTIONS") {
    return handleCorsPreFlight();
  }

  // -------------------------------------------------------------------------
  // Paso 2: Verificar que la petición proviene del origen permitido
  // -------------------------------------------------------------------------
  const originError = enforceOrigin(req);
  if (originError) return originError;

  // -------------------------------------------------------------------------
  // Paso 3: Solo se acepta el método PATCH (actualización parcial de ticket)
  // -------------------------------------------------------------------------
  if (req.method !== "PATCH") {
    return new Response(
      JSON.stringify({ error: "Método no permitido. Use PATCH." }),
      {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Paso 4: Auth Guard — requiere rol Agent
  // -------------------------------------------------------------------------
  const authResult = await requireRole(req, ["Agent"]);
  if (!authResult.ok) {
    // Añadir corsHeaders a la respuesta de error del auth guard
    const errorBody = await authResult.response.text();
    return new Response(errorBody, {
      status: authResult.response.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }
  const { user_id: agentId } = authResult.payload;

  // -------------------------------------------------------------------------
  // Paso 5: Rate Limiter — 100 peticiones por IP en 60 segundos
  // -------------------------------------------------------------------------
  const clientIp = getClientIp(req);
  const withinLimit = await checkRateLimit(
    clientIp,
    "resolve-ticket",
    RATE_LIMIT_API.maxReq,
    RATE_LIMIT_API.windowSecs,
  );
  if (!withinLimit) {
    return rateLimitExceededResponse(corsHeaders);
  }

  // -------------------------------------------------------------------------
  // Paso 6: Parsear y validar el body JSON
  // -------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "El body de la petición no es JSON válido." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const validation = validateInput(body);
  if (!validation.valid) {
    return new Response(
      JSON.stringify({ error: validation.error }),
      {
        status: validation.status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const { ticketId, solucionSanitizada } = validation;

  // -------------------------------------------------------------------------
  // Paso 7: Ejecutar la transacción atómica vía RPC
  //
  // La función SQL resolve_ticket_transaction realiza en una sola transacción:
  //   - Verificación de asignación del ticket al Agent
  //   - UPDATE del ticket (status, estado, solucion_aplicada, fecha_fin)
  //   - INSERT en ticket_history
  //   - INSERT en audit_log (TICKET_RESOLVED)
  //   - INSERT en notifications para el User propietario
  // -------------------------------------------------------------------------
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    console.error("[resolve-ticket] Variables de entorno no configuradas.");
    return new Response(
      JSON.stringify({ error: "Error de configuración del servidor." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabaseAdmin.rpc(
    "resolve_ticket_transaction",
    {
      p_ticket_id:         ticketId,
      p_agent_id:          agentId,
      p_solucion_aplicada: solucionSanitizada,
    },
  );

  if (error) {
    console.error(
      `[resolve-ticket] Error en RPC resolve_ticket_transaction: ${error.message}`,
    );
    const { httpStatus, userMessage } = mapSqlErrorToResponse(error.message);
    return new Response(
      JSON.stringify({ error: userMessage }),
      {
        status: httpStatus,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Respuesta exitosa
  // -------------------------------------------------------------------------
  return new Response(
    JSON.stringify({
      message: "Ticket resuelto correctamente.",
      data,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
});
