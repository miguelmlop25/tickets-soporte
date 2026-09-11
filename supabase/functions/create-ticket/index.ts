/**
 * create-ticket/index.ts
 * Edge Function para la creación de tickets de soporte.
 *
 * Pipeline de ejecución:
 *   1. CORS preflight
 *   2. Verificar origen permitido (enforceOrigin)
 *   3. Auth Guard — solo rol 'User'
 *   4. Rate Limiter — 100 req/IP/60 s
 *   5. Validación y sanitización de input
 *   6. Lógica de negocio via RPC (transacción atómica en PostgreSQL)
 *   7. Respuesta HTTP 201 con { ticket_id, ticket_number }
 *
 * Requisitos cubiertos: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 9.1, 9.3
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
  RATE_LIMIT_API,
  rateLimitExceededResponse,
} from "../_shared/rate-limiter.ts";
import {
  sendEmail,
  buildNewTicketEmailForAgent,
} from "../_shared/email.ts";

// ---------------------------------------------------------------------------
// Mapa de subcategorías válidas por categoría (fuente de verdad del backend)
// ---------------------------------------------------------------------------

/** Subcategorías válidas para cada categoría de ticket */
const SUBCATEGORIAS: Record<string, string[]> = {
  SOFTWARE: [
    "instalación de S.O.",
    "Instalación de Programa(s)",
    "Configuración estándar por área",
    "Configuración de Software",
    "Reconfiguración de Software",
    "Actualización de Software",
    "Error de Software",
    "Formateo de Equipo",
    "Licenciamientos",
    "Funcionamientos",
    "Controladores",
    "Capacitación de usuario",
    "Copiar Inf. A Disp. De Alm.",
  ],
  HARDWARE: [
    "Revisión de equipo",
    "Cambio de pieza",
    "Inventario",
    "Ponchado de Cable/Red",
    "Otro",
    "Descripción",
    "Re asignación",
    "Asignación",
    "Componentes",
    "Teclado",
    "Mouse",
    "Cámara",
    "Batería",
    "Puertos",
    "Display",
    "Capacitación usuarios",
    "D.D. Lleno",
    "Todas las anteriores",
  ],
  CONFIGURACIONES: [
    "Malware",
    "Licencias",
    "VPN",
    "CORREO",
    "Reinicio Servidor",
    "Revisión Servidor",
    "Apagado de Servidor",
    "Escritorio Remoto",
    "Nuevo usuario",
  ],
  SEGURIDAD: [
    "Respaldo de Información",
    "SharePoint",
    "Acces Point",
    "USB",
    "Recuperación de Información",
    "Virus",
    "Liberación IP",
    "Desbloqueos",
    "Sitios Web",
    "Robos",
  ],
  TELECOMUNICACIONES: [
    "Acceso Internet",
    "ETH/WL",
    "Telefonía IP",
    "Clik Clickshare",
    "Poly",
    "Nodos",
  ],
};

// ---------------------------------------------------------------------------
// Valores válidos para enums del dominio
// ---------------------------------------------------------------------------

/** Áreas válidas para el campo 'area' del ticket */
const VALID_AREAS = new Set([
  "Administracion",
  "Auditoria",
  "Auditoria IMSS",
  "BPO Others",
  "Consultoria",
  "Contabilidad",
  "Eduacion Continua",
  "General",
  "Impuestos",
  "Mercadotecnia",
  "Nominas",
  "Precios T",
  "RH",
  "Sistemas TI",
  "SOCIOS",
]);

/** Tipos de asistencia válidos */
const VALID_TIPOS_ASISTENCIA = new Set([
  "Asistencia remota",
  "Correo",
  "Llamada",
  "Presencial",
]);

/** Categorías válidas */
const VALID_CATEGORIAS = new Set([
  "SOFTWARE",
  "HARDWARE",
  "CONFIGURACIONES",
  "SEGURIDAD",
  "TELECOMUNICACIONES",
]);

// ---------------------------------------------------------------------------
// Utilidad de sanitización
// ---------------------------------------------------------------------------

/**
 * Elimina etiquetas HTML, scripts y patrones peligrosos de un string.
 * Recorta espacios al inicio y al final.
 *
 * @param text - Texto de entrada sin sanitizar
 * @returns    - Texto sanitizado
 */
function sanitizeText(text: string): string {
  return text
    // Eliminar etiquetas HTML completas (incluyendo self-closing)
    .replace(/<[^>]*>/g, "")
    // Eliminar secuencias de escape javascript: en atributos
    .replace(/javascript\s*:/gi, "")
    // Eliminar eventos inline on* (p.ej. onerror=, onclick=)
    .replace(/\bon\w+\s*=/gi, "")
    // Eliminar referencias a entidades HTML numéricas &#xXX;
    .replace(/&#x[0-9a-fA-F]+;?/gi, "")
    .replace(/&#\d+;?/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Interfaz del body esperado
// ---------------------------------------------------------------------------

interface CreateTicketBody {
  area: string;
  tipo_asistencia: string;
  categoria: string;
  subcategoria: string;
  descripcion: string;
  agente_asignado?: string | null;
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // 1. CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPreFlight();
  }

  // 2. Verificar origen permitido
  const originError = enforceOrigin(req);
  if (originError) {
    return originError;
  }

  // Solo aceptar POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Método no permitido." }),
      {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // 3. Auth Guard — rol requerido: User
  const authResult = await requireRole(req, ["User"]);
  if (!authResult.ok) {
    return authResult.response;
  }
  const { user_id } = authResult.payload;

  // 4. Rate Limiter — 100 req / IP / 60 s
  const clientIp = getClientIp(req);
  const allowed = await checkRateLimit(
    clientIp,
    "create-ticket",
    RATE_LIMIT_API.maxReq,
    RATE_LIMIT_API.windowSecs,
  );
  if (!allowed) {
    return rateLimitExceededResponse(corsHeaders);
  }

  // 5. Parsear y validar el body
  let body: CreateTicketBody;
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

  // --- Validar campos obligatorios presentes ---
  const requiredFields: (keyof CreateTicketBody)[] = [
    "area",
    "tipo_asistencia",
    "categoria",
    "subcategoria",
    "descripcion",
  ];

  for (const field of requiredFields) {
    const value = body[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      return new Response(
        JSON.stringify({
          error: `El campo ${field} es obligatorio.`,
          field,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }
  }

  // --- Normalizar strings ---
  const area = String(body.area).trim();
  const tipoAsistencia = String(body.tipo_asistencia).trim();
  const categoria = String(body.categoria).trim();
  const subcategoria = String(body.subcategoria).trim();
  const descripcionRaw = String(body.descripcion).trim();
  const agenteAsignado = body.agente_asignado
    ? String(body.agente_asignado).trim()
    : null;

  // --- Validar 'area' ---
  if (!VALID_AREAS.has(area)) {
    return new Response(
      JSON.stringify({
        error: `El valor '${area}' no es válido para el campo area.`,
        field: "area",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // --- Validar 'tipo_asistencia' ---
  if (!VALID_TIPOS_ASISTENCIA.has(tipoAsistencia)) {
    return new Response(
      JSON.stringify({
        error: `El valor '${tipoAsistencia}' no es válido para el campo tipo_asistencia.`,
        field: "tipo_asistencia",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // --- Validar 'categoria' ---
  if (!VALID_CATEGORIAS.has(categoria)) {
    return new Response(
      JSON.stringify({
        error: `El valor '${categoria}' no es válido para el campo categoria.`,
        field: "categoria",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // --- Validar 'subcategoria' contra el mapa SUBCATEGORIAS ---
  const subcategoriasValidas = SUBCATEGORIAS[categoria] ?? [];
  if (!subcategoriasValidas.includes(subcategoria)) {
    return new Response(
      JSON.stringify({
        error: `Subcategoría no válida para la categoría seleccionada.`,
        field: "subcategoria",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // --- Sanitizar 'descripcion' ---
  const descripcion = sanitizeText(descripcionRaw);

  // --- Validar longitud de 'descripcion' (1–1000 chars tras sanitizar) ---
  if (descripcion.length < 1) {
    return new Response(
      JSON.stringify({
        error: "El campo descripcion es obligatorio.",
        field: "descripcion",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
  if (descripcion.length > 1000) {
    return new Response(
      JSON.stringify({
        error: "La descripción no puede superar 1000 caracteres.",
        field: "descripcion",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // --- Validar formato UUID de 'agente_asignado' (si se proporcionó) ---
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (agenteAsignado !== null && !uuidRegex.test(agenteAsignado)) {
    return new Response(
      JSON.stringify({
        error: "El campo agente_asignado debe ser un UUID válido.",
        field: "agente_asignado",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // 6. Lógica de negocio — transacción atómica via RPC
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "[create-ticket] Variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configuradas.",
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

  const { data, error } = await supabaseAdmin.rpc(
    "create_ticket_transaction",
    {
      p_area: area,
      p_tipo_asistencia: tipoAsistencia,
      p_categoria: categoria,
      p_subcategoria: subcategoria,
      p_descripcion: descripcion,
      p_user_id: user_id,
      p_agent_id: agenteAsignado,
    },
  );

  if (error) {
    // Verificar si el error es por límite de secuencia SSP-9999
    const isSeqLimit =
      error.message?.includes("SEQ_LIMIT_REACHED") ||
      error.code === "P0001";

    if (isSeqLimit) {
      return new Response(
        JSON.stringify({
          error:
            "Se ha alcanzado el límite máximo de tickets del sistema.",
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    console.error(`[create-ticket] Error en RPC create_ticket_transaction:`, error);
    return new Response(
      JSON.stringify({
        error:
          "No fue posible crear el ticket. Por favor, intente nuevamente.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // La función RPC retorna un array con una fila (RETURNS TABLE)
  const result = Array.isArray(data) ? data[0] : data;

  if (!result?.ticket_id || !result?.ticket_number) {
    console.error("[create-ticket] RPC retornó datos incompletos:", data);
    return new Response(
      JSON.stringify({ error: "Error inesperado al crear el ticket." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // 7. Notificacion por correo al agente asignado (Opcion A: no bloquea).
  //    Si hay agente asignado, se le envia un correo con todos los datos del
  //    ticket, el numero generado y el correo del usuario que lo creo. Cualquier
  //    fallo se registra en logs y NO afecta la creacion del ticket ya realizada.
  if (agenteAsignado) {
    try {
      // Datos del agente (destinatario) y del usuario (solicitante).
      const [{ data: agentProfile }, { data: userProfile }] = await Promise.all([
        supabaseAdmin
          .from("profiles")
          .select("full_name, email")
          .eq("id", agenteAsignado)
          .single(),
        supabaseAdmin
          .from("profiles")
          .select("full_name, email")
          .eq("id", user_id)
          .single(),
      ]);

      if (agentProfile?.email) {
        const html = buildNewTicketEmailForAgent({
          agentName: agentProfile.full_name ?? "Agente",
          userName: userProfile?.full_name ?? "Usuario",
          userEmail: userProfile?.email ?? "",
          ticket: {
            ticket_number: result.ticket_number,
            area,
            tipo_asistencia: tipoAsistencia,
            categoria,
            subcategoria,
            descripcion,
            estado: "TICKET PENDIENTE",
            status: "Pendiente",
          },
        });

        const sent = await sendEmail(
          agentProfile.email,
          `Nuevo ticket por atender: ${result.ticket_number}`,
          html,
        );

        if (!sent) {
          console.error(
            `[create-ticket] No se pudo enviar el correo al agente para el ticket ${result.ticket_number}.`,
          );
        }
      } else {
        console.error(
          "[create-ticket] El agente asignado no tiene correo; se omite la notificacion por correo.",
        );
      }
    } catch (emailError) {
      // Opcion A: el fallo del correo no interrumpe la creacion del ticket.
      console.error(
        "[create-ticket] Error inesperado al enviar el correo de notificacion:",
        emailError,
      );
    }
  }

  // 8. Respuesta exitosa HTTP 201
  return new Response(
    JSON.stringify({
      ticket_id: result.ticket_id,
      ticket_number: result.ticket_number,
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
});
