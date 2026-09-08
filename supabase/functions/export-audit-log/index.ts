/**
 * export-audit-log/index.ts
 * Edge Function para consultar el registro de auditoría (audit_log) por parte del Admin.
 *
 * Método soportado:
 *   GET /export-audit-log?actor_id=<uuid>&action=<audit_action>&date_from=<ISO>&date_to=<ISO>&page=<n>
 *       → Lista paginada de entradas del audit_log (máx. 100 por página).
 *
 * Filtros opcionales (query params):
 *   - actor_id  : UUID del usuario que realizó la acción
 *   - action    : tipo de acción (debe pertenecer al enum audit_action)
 *   - date_from : fecha/hora inicial (ISO 8601) — filtra created_at >= date_from
 *   - date_to   : fecha/hora final (ISO 8601)   — filtra created_at <= date_to
 *   - page      : número de página (1-indexado). Tamaño fijo de 100 registros por página.
 *
 * Pipeline: CORS → Auth Guard (Admin) → Rate Limiter → validación → consulta
 *
 * Respuestas:
 *   200 — Registros del audit_log con metadatos de paginación
 *   400 — Parámetros de query inválidos
 *   401 — Token ausente o inválido
 *   403 — Origen o rol no autorizado
 *   405 — Método no soportado
 *   429 — Rate limit excedido
 *   500 — Error interno del servidor
 *
 * Requisitos: 9.5
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

// ---------------------------------------------------------------------------
// Constantes de paginación y validación
// ---------------------------------------------------------------------------

/** Primera página por defecto cuando no se especifica el parámetro `page` */
const DEFAULT_PAGE = 1;

/** Tamaño de página fijo: máximo 100 registros por página (requisito 9.5) */
const PAGE_SIZE = 100;

/**
 * Valores válidos del enum `audit_action` definido en la migración inicial.
 * Se usa para validar el filtro `action` antes de consultar la base de datos.
 */
const VALID_AUDIT_ACTIONS = [
  "TICKET_CREATED",
  "TICKET_ACCEPTED",
  "TICKET_RESOLVED",
  "TICKET_UPDATED",
  "TICKET_DELETED",
  "USER_CREATED",
  "USER_UPDATED",
  "USER_DELETED",
  "USER_BLOCKED",
  "USER_UNBLOCKED",
] as const;

/** Expresión regular para validar el formato UUID (versiones 1–5) */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helper: cliente Supabase con service_role
// ---------------------------------------------------------------------------

/**
 * Crea un cliente Supabase con la clave de service_role.
 * Las variables de entorno son inyectadas por Supabase en tiempo de ejecución
 * y nunca se escriben directamente en el código fuente.
 */
function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceKey) {
    throw new Error(
      "Variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas.",
    );
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: respuesta JSON con headers CORS
// ---------------------------------------------------------------------------

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Validación de los parámetros de query
// ---------------------------------------------------------------------------

/** Filtros ya validados y normalizados listos para construir la consulta */
interface ParsedFilters {
  actorId?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
}

/**
 * Valida y normaliza los parámetros de query de la petición.
 *
 * Reglas:
 *   - actor_id  : si está presente, debe tener formato UUID válido
 *   - action    : si está presente, debe pertenecer al enum audit_action
 *   - date_from : si está presente, debe ser una fecha ISO parseable
 *   - date_to   : si está presente, debe ser una fecha ISO parseable
 *   - date_from no puede ser posterior a date_to (si ambos están presentes)
 *   - page      : entero >= 1; por defecto DEFAULT_PAGE
 *
 * @param params - URLSearchParams de la petición entrante
 * @returns { valid: true, filters } | { valid: false, error }
 */
function validateFilters(
  params: URLSearchParams,
): { valid: true; filters: ParsedFilters } | { valid: false; error: string } {
  const filters: ParsedFilters = { page: DEFAULT_PAGE };

  // --- actor_id ---
  const actorId = params.get("actor_id");
  if (actorId !== null && actorId.trim() !== "") {
    if (!UUID_REGEX.test(actorId.trim())) {
      return {
        valid: false,
        error: "El parámetro 'actor_id' no tiene un formato UUID válido.",
      };
    }
    filters.actorId = actorId.trim();
  }

  // --- action ---
  const action = params.get("action");
  if (action !== null && action.trim() !== "") {
    if (!VALID_AUDIT_ACTIONS.includes(action.trim() as never)) {
      return {
        valid: false,
        error:
          `El parámetro 'action' no es válido. Valores permitidos: ${VALID_AUDIT_ACTIONS.join(", ")}.`,
      };
    }
    filters.action = action.trim();
  }

  // --- date_from ---
  const dateFrom = params.get("date_from");
  if (dateFrom !== null && dateFrom.trim() !== "") {
    const parsed = Date.parse(dateFrom.trim());
    if (Number.isNaN(parsed)) {
      return {
        valid: false,
        error: "El parámetro 'date_from' no es una fecha válida (use formato ISO 8601).",
      };
    }
    filters.dateFrom = new Date(parsed).toISOString();
  }

  // --- date_to ---
  const dateTo = params.get("date_to");
  if (dateTo !== null && dateTo.trim() !== "") {
    const parsed = Date.parse(dateTo.trim());
    if (Number.isNaN(parsed)) {
      return {
        valid: false,
        error: "El parámetro 'date_to' no es una fecha válida (use formato ISO 8601).",
      };
    }
    filters.dateTo = new Date(parsed).toISOString();
  }

  // --- coherencia del rango de fechas ---
  if (
    filters.dateFrom !== undefined &&
    filters.dateTo !== undefined &&
    filters.dateFrom > filters.dateTo
  ) {
    return {
      valid: false,
      error: "El parámetro 'date_from' no puede ser posterior a 'date_to'.",
    };
  }

  // --- page ---
  const rawPage = params.get("page");
  if (rawPage !== null && rawPage.trim() !== "") {
    const parsedPage = Number.parseInt(rawPage.trim(), 10);
    if (Number.isNaN(parsedPage) || parsedPage < 1) {
      return {
        valid: false,
        error: "El parámetro 'page' debe ser un entero mayor o igual a 1.",
      };
    }
    filters.page = parsedPage;
  }

  return { valid: true, filters };
}

// ---------------------------------------------------------------------------
// Handler GET: consulta paginada del audit_log
// ---------------------------------------------------------------------------

/**
 * Ejecuta la consulta paginada sobre `audit_log` aplicando los filtros validados.
 * Incluye un join con `profiles` para exponer el nombre y correo del actor,
 * facilitando la lectura del registro en el frontend.
 *
 * @param filters - Filtros validados y normalizados
 * @returns Response con los registros y metadatos de paginación
 */
async function handleGet(filters: ParsedFilters): Promise<Response> {
  const supabaseAdmin = getSupabaseAdmin();

  const from = (filters.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Construir la consulta base con join al perfil del actor.
  // `count: exact` permite calcular el total de páginas disponibles.
  let query = supabaseAdmin
    .from("audit_log")
    .select(
      "id, actor_id, action, entity_type, entity_id, metadata, created_at, actor:profiles!audit_log_actor_id_fkey(full_name, email, role)",
      { count: "exact" },
    );

  // Aplicar filtros opcionales
  if (filters.actorId) {
    query = query.eq("actor_id", filters.actorId);
  }

  if (filters.action) {
    query = query.eq("action", filters.action);
  }

  if (filters.dateFrom) {
    query = query.gte("created_at", filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.lte("created_at", filters.dateTo);
  }

  // Ordenar por fecha descendente (entradas más recientes primero) y paginar
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("[export-audit-log] Error al consultar audit_log:", error.message);
    return jsonResponse(
      { error: "Error al obtener el registro de auditoría." },
      500,
    );
  }

  const total = count ?? 0;

  return jsonResponse(
    {
      data: data ?? [],
      pagination: {
        page: filters.page,
        pageSize: PAGE_SIZE,
        total,
        totalPages: Math.ceil(total / PAGE_SIZE),
      },
      filters: {
        actor_id: filters.actorId ?? null,
        action: filters.action ?? null,
        date_from: filters.dateFrom ?? null,
        date_to: filters.dateTo ?? null,
      },
    },
    200,
  );
}

// ---------------------------------------------------------------------------
// Handler principal de la Edge Function
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // 1. Manejar preflight CORS
  if (req.method === "OPTIONS") {
    return handleCorsPreFlight();
  }

  // 2. Verificar origen de la petición
  const originError = enforceOrigin(req);
  if (originError) return originError;

  // 3. Solo se acepta el método GET (consulta de solo lectura)
  if (req.method !== "GET") {
    return jsonResponse(
      { error: `Método ${req.method} no está soportado. Use GET.` },
      405,
    );
  }

  // 4. Auth Guard: solo Admin puede consultar el audit_log (requisito 9.5)
  const authResult = await requireRole(req, ["Admin"]);
  if (!authResult.ok) {
    // Reenvía el error del guard añadiendo los headers CORS
    const errorBody = await authResult.response.text();
    return new Response(errorBody, {
      status: authResult.response.status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // 5. Rate Limiting: 100 peticiones por IP en 60 segundos
  const clientIp = getClientIp(req);
  const allowed = await checkRateLimit(
    clientIp,
    "export-audit-log",
    RATE_LIMIT_API.maxReq,
    RATE_LIMIT_API.windowSecs,
  );

  if (!allowed) {
    return rateLimitExceededResponse(corsHeaders);
  }

  // 6. Validar los parámetros de query
  const url = new URL(req.url);
  const validation = validateFilters(url.searchParams);
  if (!validation.valid) {
    return jsonResponse({ error: validation.error }, 400);
  }

  // 7. Ejecutar la consulta paginada
  try {
    return await handleGet(validation.filters);
  } catch (err) {
    // Error inesperado: loguear sin exponer detalles internos al cliente
    console.error("[export-audit-log] Error inesperado:", err);
    return jsonResponse(
      { error: "Error interno del servidor. Por favor, intente nuevamente." },
      500,
    );
  }
});
