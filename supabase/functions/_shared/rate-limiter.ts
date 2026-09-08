/**
 * rate-limiter.ts
 * Módulo de rate limiting para Edge Functions usando la tabla `rate_limit_log`.
 *
 * Estrategia: ventana deslizante basada en INSERT + COUNT en PostgreSQL.
 * - Se inserta el registro de la petición actual.
 * - Se cuenta cuántas peticiones de la misma IP se realizaron en la ventana de tiempo.
 * - Si el conteo supera el máximo permitido, se retorna false (límite superado).
 *
 * Umbrales predefinidos:
 * - Login:       RATE_LIMIT_LOGIN   → 10 intentos / 60 segundos
 * - API general: RATE_LIMIT_API     → 100 peticiones / 60 segundos
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Umbrales predefinidos exportados para uso en Edge Functions
// ---------------------------------------------------------------------------

/** Límite para el endpoint de inicio de sesión: 10 intentos por IP en 60 seg. */
export const RATE_LIMIT_LOGIN = { maxReq: 10, windowSecs: 60 } as const;

/** Límite general para las Edge Functions de la API: 100 req por IP en 60 seg. */
export const RATE_LIMIT_API = { maxReq: 100, windowSecs: 60 } as const;

// ---------------------------------------------------------------------------
// Cliente Supabase con service_role para operar sin restricciones de RLS
// ---------------------------------------------------------------------------

/**
 * Crea un cliente Supabase con la clave de service_role.
 * Las variables de entorno son inyectadas por Supabase en tiempo de ejecución.
 * Nunca se escriben directamente en el código fuente.
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
// Función principal de rate limiting
// ---------------------------------------------------------------------------

/**
 * Verifica y registra una petición en la tabla `rate_limit_log`.
 *
 * El proceso es:
 * 1. Inserta el registro de la petición actual.
 * 2. Cuenta cuántas peticiones de la misma IP al mismo endpoint
 *    ocurrieron en los últimos `windowSecs` segundos (incluyendo la actual).
 * 3. Si el conteo >= maxReq, retorna false (límite superado).
 * 4. Si el conteo < maxReq, retorna true (petición permitida).
 *
 * @param ip          - Dirección IP del cliente
 * @param endpoint    - Identificador del endpoint (ej: "create-ticket", "login")
 * @param maxReq      - Número máximo de peticiones permitidas en la ventana
 * @param windowSecs  - Duración de la ventana de tiempo en segundos
 * @returns           - `true` si la petición está dentro del límite, `false` si lo supera
 *
 * @example
 * // Usando el umbral general de API
 * const allowed = await checkRateLimit(clientIp, "create-ticket", RATE_LIMIT_API.maxReq, RATE_LIMIT_API.windowSecs);
 * if (!allowed) return new Response(JSON.stringify({ error: "Límite de peticiones excedido" }), { status: 429 });
 */
export async function checkRateLimit(
  ip: string,
  endpoint: string,
  maxReq: number,
  windowSecs: number,
): Promise<boolean> {
  const supabaseAdmin = getSupabaseAdmin();

  // Insertar el registro de la petición actual en el log
  const { error: insertError } = await supabaseAdmin
    .from("rate_limit_log")
    .insert({ ip_address: ip, endpoint });

  if (insertError) {
    // Si no se puede escribir el log, se permite la petición para no bloquear
    // el servicio, pero se registra el error en consola para diagnóstico
    console.error(
      `[rate-limiter] Error al insertar en rate_limit_log: ${insertError.message}`,
    );
    return true;
  }

  // Calcular el inicio de la ventana de tiempo
  const windowStart = new Date(Date.now() - windowSecs * 1000).toISOString();

  // Contar cuántas peticiones de esta IP a este endpoint se realizaron
  // dentro de la ventana de tiempo (incluyendo la petición recién insertada)
  const { count, error: countError } = await supabaseAdmin
    .from("rate_limit_log")
    .select("*", { count: "exact", head: true })
    .eq("ip_address", ip)
    .eq("endpoint", endpoint)
    .gte("created_at", windowStart);

  if (countError) {
    // Si no se puede contar, se permite la petición para no bloquear el servicio
    console.error(
      `[rate-limiter] Error al contar peticiones en rate_limit_log: ${countError.message}`,
    );
    return true;
  }

  // Si el conteo alcanza o supera el máximo, el límite fue superado
  if ((count ?? 0) >= maxReq) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Helper: extrae la IP del cliente desde los headers de la petición
// ---------------------------------------------------------------------------

/**
 * Obtiene la dirección IP real del cliente desde los headers de la petición.
 * Prioriza `x-forwarded-for` (proxy/CDN) sobre `x-real-ip` y el valor directo.
 * Si no se puede determinar, retorna "unknown".
 *
 * @param req - Objeto Request de la Edge Function
 * @returns   - Dirección IP del cliente como string
 *
 * @example
 * const clientIp = getClientIp(req);
 * const allowed = await checkRateLimit(clientIp, "create-ticket", 100, 60);
 */
export function getClientIp(req: Request): string {
  // x-forwarded-for puede contener múltiples IPs separadas por coma;
  // la primera es la IP del cliente original
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Helper: genera la respuesta HTTP 429 estándar
// ---------------------------------------------------------------------------

/**
 * Genera una respuesta HTTP 429 Too Many Requests estandarizada.
 * Incluye los headers CORS necesarios para que el frontend pueda leer el error.
 *
 * @param corsHeaders - Headers CORS a incluir en la respuesta
 * @returns           - Response con status 429 y mensaje de error en JSON
 *
 * @example
 * if (!allowed) return rateLimitExceededResponse(corsHeaders);
 */
export function rateLimitExceededResponse(
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: "Se ha superado el límite de peticiones. Intente nuevamente más tarde.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    },
  );
}
