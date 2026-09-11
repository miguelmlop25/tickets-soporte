/**
 * update-ticket-status/index.ts
 * Edge Function para aceptar un ticket por parte de un Agent.
 *
 * Pipeline de procesamiento:
 *   1. CORS preflight
 *   2. Verificar que el método sea PATCH
 *   3. Verificar origen (enforceOrigin)
 *   4. Validar JWT y exigir rol Agent (requireRole)
 *   5. Rate Limiter (100 req/IP/60s — umbral general de API)
 *   6. Validar y parsear el body: { ticket_id, action: 'ACEPTAR' }
 *   7. Llamar a accept_ticket_transaction vía supabase.rpc()
 *   8. Retornar el resultado con HTTP 200
 *
 * Requisitos cubiertos: 5.1, 5.2, 5.3, 5.4, 8.2
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  enforceOrigin,
  handleCorsPreFlight,
} from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth-guard.ts";
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMIT_API,
  rateLimitExceededResponse,
} from "../_shared/rate-limiter.ts";
import {
  sendEmail,
  buildTicketAcceptedEmailForUser,
} from "../_shared/email.ts";

// ---------------------------------------------------------------------------
// Tipos internos
// ---------------------------------------------------------------------------

/** Body esperado en la petición PATCH */
interface UpdateTicketStatusBody {
  ticket_id: string;
  action: string;
}

/** Acción válida que puede enviarse en el body */
const VALID_ACTIONS = ["ACEPTAR"] as const;
type ValidAction = (typeof VALID_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // -------------------------------------------------------
  // 1. CORS preflight (OPTIONS)
  // -------------------------------------------------------
  if (req.method === "OPTIONS") {
    return handleCorsPreFlight();
  }

  // -------------------------------------------------------
  // 2. Verificar método HTTP — solo PATCH está permitido
  // -------------------------------------------------------
  if (req.method !== "PATCH") {
    return new Response(
      JSON.stringify({ error: "Método no permitido. Use PATCH." }),
      {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // -------------------------------------------------------
  // 3. Verificar origen (CORS) — solo ticketsoportest.netlify.app
  // -------------------------------------------------------
  const originError = enforceOrigin(req);
  if (originError) return originError;

  // -------------------------------------------------------
  // 4. Validar JWT y verificar que el rol sea Agent
  //    Requisito 5.1, 5.2, 5.3: solo un Agent puede aceptar tickets
  // -------------------------------------------------------
  const authResult = await requireRole(req, ["Agent"]);
  if (!authResult.ok) {
    return authResult.response;
  }
  const { user_id: agentId } = authResult.payload;

  // -------------------------------------------------------
  // 5. Rate Limiting — 100 peticiones por IP en 60 segundos
  //    Requisito 10.5: límite general para Edge Functions
  // -------------------------------------------------------
  const clientIp = getClientIp(req);
  const withinLimit = await checkRateLimit(
    clientIp,
    "update-ticket-status",
    RATE_LIMIT_API.maxReq,
    RATE_LIMIT_API.windowSecs,
  );
  if (!withinLimit) {
    return rateLimitExceededResponse(corsHeaders);
  }

  // -------------------------------------------------------
  // 6. Parsear y validar el body de la petición
  // -------------------------------------------------------
  let body: UpdateTicketStatusBody;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "El cuerpo de la petición no es JSON válido." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // Validar ticket_id
  const ticketId = body?.ticket_id?.trim();
  if (!ticketId) {
    return new Response(
      JSON.stringify({ error: "El campo ticket_id es obligatorio." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // Validar que ticket_id sea un UUID válido
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(ticketId)) {
    return new Response(
      JSON.stringify({ error: "El campo ticket_id no tiene un formato UUID válido." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // Validar acción — debe ser exactamente 'ACEPTAR'
  const action = body?.action?.trim() as ValidAction;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return new Response(
      JSON.stringify({
        error: `El campo action es inválido. Valor permitido: ${VALID_ACTIONS.join(", ")}.`,
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // -------------------------------------------------------
  // 7. Inicializar cliente Supabase con service_role
  //    para ejecutar la transacción sin restricciones de RLS
  // -------------------------------------------------------
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "[update-ticket-status] Variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configuradas.",
    );
    return new Response(
      JSON.stringify({ error: "Error de configuración del servidor." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  // -------------------------------------------------------
  // 8. Ejecutar la transacción atómica via RPC
  //    La función SQL accept_ticket_transaction realiza en un único
  //    bloque atómico:
  //      a) Verificar disponibilidad del ticket (FOR UPDATE)
  //      b) Actualizar status, estado, agent_id y fecha_inicio
  //      c) Insertar en ticket_history
  //      d) Insertar en audit_log (TICKET_ACCEPTED)
  //      e) Insertar notificación para el User propietario
  //
  //    Cualquier fallo revierte la operación completa.
  //    Requisitos: 5.1, 5.2, 5.3, 5.4, 8.2, 9.1
  // -------------------------------------------------------
  const { data, error: rpcError } = await supabaseAdmin.rpc(
    "accept_ticket_transaction",
    {
      p_ticket_id: ticketId,
      p_agent_id: agentId,
    },
  );

  if (rpcError) {
    // Mapear los errores controlados de la función SQL a respuestas HTTP apropiadas
    const errorMessage: string = rpcError.message ?? "";

    // Ticket no encontrado
    if (errorMessage.includes("TICKET_NOT_FOUND")) {
      return new Response(
        JSON.stringify({ error: "El ticket especificado no existe." }),
        {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    // Ticket en estado incorrecto (no está en Pendiente)
    if (errorMessage.includes("TICKET_WRONG_STATUS")) {
      return new Response(
        JSON.stringify({
          error: "El ticket no puede ser aceptado porque no está en estado Pendiente.",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    // Ticket asignado a otro Agent — HTTP 403 (Requisito 5.3)
    if (errorMessage.includes("TICKET_ASSIGNED_OTHER")) {
      return new Response(
        JSON.stringify({
          error: "No tiene permiso sobre este ticket. El ticket está asignado a otro agente.",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    // Error inesperado del servidor
    console.error(
      `[update-ticket-status] Error en accept_ticket_transaction: ${rpcError.message}`,
    );
    return new Response(
      JSON.stringify({
        error: "La acción no pudo completarse. Por favor, intente nuevamente.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // -------------------------------------------------------
  // 9. Notificacion por correo al usuario propietario (Opcion A: no bloquea).
  //    Se informa al usuario que su ticket fue aceptado y esta en atencion,
  //    mencionando el nombre del agente, el del usuario y el numero de ticket.
  //    Cualquier fallo se registra y NO afecta la aceptacion ya realizada.
  // -------------------------------------------------------
  try {
    const result = (data ?? {}) as Record<string, unknown>;
    const ticketNumber = String(result.ticket_number ?? "");

    // Obtener el usuario propietario del ticket y el nombre del agente.
    const { data: ticketRow } = await supabaseAdmin
      .from("tickets")
      .select("user_id")
      .eq("id", ticketId)
      .single();

    const ownerId = ticketRow?.user_id;

    if (ownerId) {
      const [{ data: userProfile }, { data: agentProfile }] = await Promise.all([
        supabaseAdmin
          .from("profiles")
          .select("full_name, email")
          .eq("id", ownerId)
          .single(),
        supabaseAdmin
          .from("profiles")
          .select("full_name")
          .eq("id", agentId)
          .single(),
      ]);

      if (userProfile?.email) {
        const html = buildTicketAcceptedEmailForUser({
          userName: userProfile.full_name ?? "Usuario",
          agentName: agentProfile?.full_name ?? "Agente",
          ticketNumber,
        });

        const sent = await sendEmail(
          userProfile.email,
          `Tu ticket ${ticketNumber} esta en atencion`,
          html,
        );

        if (!sent) {
          console.error(
            `[update-ticket-status] No se pudo enviar el correo al usuario para el ticket ${ticketNumber}.`,
          );
        }
      } else {
        console.error(
          "[update-ticket-status] El usuario propietario no tiene correo; se omite la notificacion.",
        );
      }
    }
  } catch (emailError) {
    // Opcion A: el fallo del correo no interrumpe la aceptacion del ticket.
    console.error(
      "[update-ticket-status] Error inesperado al enviar el correo de notificacion:",
      emailError,
    );
  }

  // -------------------------------------------------------
  // 10. Retornar respuesta exitosa con los datos actualizados
  // -------------------------------------------------------
  return new Response(
    JSON.stringify({
      message: "Ticket aceptado exitosamente.",
      data,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
});
