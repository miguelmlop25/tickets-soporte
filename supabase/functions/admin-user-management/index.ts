/**
 * admin-user-management/index.ts
 * Edge Function para gestión de usuarios por parte del Admin.
 *
 * Métodos soportados:
 *   GET    /admin-user-management?page=1&pageSize=20
 *          → Lista paginada de usuarios (rol User o Agent)
 *
 *   PATCH  /admin-user-management
 *          Body: { user_id: string, is_active: boolean }
 *          → Bloquea (is_active=false) o desbloquea (is_active=true) una cuenta
 *
 *   DELETE /admin-user-management
 *          Body: { user_id: string }
 *          → Elimina permanentemente una cuenta de rol User o Agent
 *
 * Pipeline: CORS → Auth Guard (Admin) → Rate Limiter → validación → lógica
 *
 * Requisitos: 2.9, 9.1, 9.2
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
// Constantes de paginación
// ---------------------------------------------------------------------------

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Helper: cliente Supabase con service_role
// ---------------------------------------------------------------------------

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
// Handler GET: listado paginado de usuarios
// ---------------------------------------------------------------------------

async function handleGet(
  url: URL,
  actorId: string,
): Promise<Response> {
  const supabaseAdmin = getSupabaseAdmin();

  // Parsear y validar parámetros de paginación
  const rawPage = parseInt(url.searchParams.get("page") ?? String(DEFAULT_PAGE), 10);
  const rawPageSize = parseInt(
    url.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE),
    10,
  );

  const page = isNaN(rawPage) || rawPage < 1 ? DEFAULT_PAGE : rawPage;
  const pageSize = isNaN(rawPageSize) || rawPageSize < 1
    ? DEFAULT_PAGE_SIZE
    : Math.min(rawPageSize, MAX_PAGE_SIZE);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Listar sólo Users y Agents (no Admins), ordenados por fecha de registro
  const { data: users, error, count } = await supabaseAdmin
    .from("profiles")
    .select(
      "id, full_name, email, role, is_active, created_at",
      { count: "exact" },
    )
    .in("role", ["User", "Agent"])
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("[admin-user-management] Error al consultar profiles:", error.message);
    return jsonResponse(
      { error: "Error al obtener la lista de usuarios." },
      500,
    );
  }

  return jsonResponse(
    {
      data: users ?? [],
      pagination: {
        page,
        pageSize,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / pageSize),
      },
    },
    200,
  );
}

// ---------------------------------------------------------------------------
// Handler PATCH: bloquear / desbloquear cuenta
// ---------------------------------------------------------------------------

async function handlePatch(
  body: Record<string, unknown>,
  actorId: string,
): Promise<Response> {
  const supabaseAdmin = getSupabaseAdmin();

  // Validar presencia de campos requeridos
  const { user_id, is_active } = body;

  if (!user_id || typeof user_id !== "string") {
    return jsonResponse({ error: "El campo 'user_id' es obligatorio." }, 400);
  }

  if (typeof is_active !== "boolean") {
    return jsonResponse(
      { error: "El campo 'is_active' es obligatorio y debe ser un booleano." },
      400,
    );
  }

  // Verificar que el usuario objetivo existe y no es Admin
  const { data: targetProfile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, role, full_name, email")
    .eq("id", user_id)
    .single();

  if (profileError || !targetProfile) {
    return jsonResponse({ error: "Usuario no encontrado." }, 404);
  }

  if (targetProfile.role === "Admin") {
    return jsonResponse(
      { error: "No se puede bloquear o desbloquear una cuenta con rol Admin." },
      403,
    );
  }

  // Actualizar el campo is_active en profiles
  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({ is_active })
    .eq("id", user_id);

  if (updateError) {
    console.error(
      "[admin-user-management] Error al actualizar is_active:",
      updateError.message,
    );
    return jsonResponse(
      { error: "Error al actualizar el estado del usuario." },
      500,
    );
  }

  // Registrar en audit_log
  const auditAction = is_active ? "USER_UNBLOCKED" : "USER_BLOCKED";

  const { error: auditError } = await supabaseAdmin.from("audit_log").insert({
    actor_id: actorId,
    action: auditAction,
    entity_type: "profile",
    entity_id: user_id,
    metadata: {
      target_email: targetProfile.email,
      target_role: targetProfile.role,
      is_active,
    },
  });

  if (auditError) {
    console.error(
      "[admin-user-management] Error al escribir en audit_log (PATCH):",
      auditError.message,
    );
    // Si el audit_log falla, revertir la actualización y devolver error
    // (Requisito 9.4: sin persistencia parcial)
    await supabaseAdmin
      .from("profiles")
      .update({ is_active: !is_active })
      .eq("id", user_id);

    return jsonResponse(
      { error: "La acción no pudo completarse. El registro de auditoría falló." },
      500,
    );
  }

  return jsonResponse(
    {
      message: is_active
        ? "Cuenta desbloqueada exitosamente."
        : "Cuenta bloqueada exitosamente.",
      user_id,
      is_active,
    },
    200,
  );
}

// ---------------------------------------------------------------------------
// Handler DELETE: eliminar cuenta de User o Agent
// ---------------------------------------------------------------------------

async function handleDelete(
  body: Record<string, unknown>,
  actorId: string,
): Promise<Response> {
  const supabaseAdmin = getSupabaseAdmin();

  // Validar campo requerido
  const { user_id } = body;

  if (!user_id || typeof user_id !== "string") {
    return jsonResponse({ error: "El campo 'user_id' es obligatorio." }, 400);
  }

  // Verificar que el usuario objetivo existe y no es Admin
  const { data: targetProfile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, role, full_name, email")
    .eq("id", user_id)
    .single();

  if (profileError || !targetProfile) {
    return jsonResponse({ error: "Usuario no encontrado." }, 404);
  }

  if (targetProfile.role === "Admin") {
    return jsonResponse(
      { error: "No se puede eliminar una cuenta con rol Admin." },
      403,
    );
  }

  // Registrar en audit_log ANTES de eliminar (para conservar referencia)
  const { error: auditError } = await supabaseAdmin.from("audit_log").insert({
    actor_id: actorId,
    action: "USER_DELETED",
    entity_type: "profile",
    entity_id: user_id,
    metadata: {
      target_email: targetProfile.email,
      target_full_name: targetProfile.full_name,
      target_role: targetProfile.role,
    },
  });

  if (auditError) {
    console.error(
      "[admin-user-management] Error al escribir en audit_log (DELETE):",
      auditError.message,
    );
    // No eliminar si el audit_log falla (Requisito 9.4)
    return jsonResponse(
      { error: "La acción no pudo completarse. El registro de auditoría falló." },
      500,
    );
  }

  // Eliminar la cuenta de Auth (esto también elimina el perfil via ON DELETE CASCADE)
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(
    user_id,
  );

  if (deleteError) {
    console.error(
      "[admin-user-management] Error al eliminar usuario en Auth:",
      deleteError.message,
    );
    return jsonResponse(
      { error: "Error al eliminar el usuario del sistema." },
      500,
    );
  }

  return jsonResponse(
    {
      message: "Cuenta eliminada exitosamente.",
      user_id,
    },
    200,
  );
}

// ---------------------------------------------------------------------------
// Handler principal de la Edge Function
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // 1. Manejar preflight CORS
  if (req.method === "OPTIONS") {
    return handleCorsPreFlight();
  }

  // 2. Verificar origen de la petición
  const originError = enforceOrigin(req);
  if (originError) return originError;

  // 3. Auth Guard: solo Admin puede acceder a esta función
  const authResult = await requireRole(req, ["Admin"]);
  if (!authResult.ok) return authResult.response;

  const { user_id: actorId } = authResult.payload;

  // 4. Rate Limiting
  const clientIp = getClientIp(req);
  const allowed = await checkRateLimit(
    clientIp,
    "admin-user-management",
    RATE_LIMIT_API.maxReq,
    RATE_LIMIT_API.windowSecs,
  );

  if (!allowed) {
    return rateLimitExceededResponse(corsHeaders);
  }

  // 5. Parsear URL y enrutar según método HTTP
  const url = new URL(req.url);

  try {
    switch (req.method) {
      case "GET":
        return await handleGet(url, actorId);

      case "PATCH": {
        // Parsear body JSON
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: "El cuerpo de la petición debe ser JSON válido." }, 400);
        }
        return await handlePatch(body, actorId);
      }

      case "DELETE": {
        // Parsear body JSON
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: "El cuerpo de la petición debe ser JSON válido." }, 400);
        }
        return await handleDelete(body, actorId);
      }

      default:
        return jsonResponse(
          { error: `Método ${req.method} no está soportado.` },
          405,
        );
    }
  } catch (err) {
    // Error inesperado: loguear sin exponer detalles internos al cliente
    console.error("[admin-user-management] Error inesperado:", err);
    return jsonResponse(
      { error: "Error interno del servidor. Por favor, intente nuevamente." },
      500,
    );
  }
});
