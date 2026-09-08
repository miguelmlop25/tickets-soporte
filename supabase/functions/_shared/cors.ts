/**
 * cors.ts
 * Headers y utilidades CORS reutilizables para todas las Edge Functions.
 * Restringe el origen a la URL de producción del frontend en Netlify.
 */

/** Origen permitido para peticiones CORS */
const ALLOWED_ORIGIN = "https://ticketsoportest.netlify.app";

/**
 * Headers CORS estándar aplicados a todas las respuestas de las Edge Functions.
 * Solo se permite el origen del frontend de producción.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Maneja la petición OPTIONS (preflight de CORS).
 * Retorna HTTP 204 con los headers CORS correctos sin cuerpo.
 *
 * Uso en cada Edge Function:
 * ```ts
 * if (req.method === "OPTIONS") {
 *   return handleCorsPreFlight();
 * }
 * ```
 */
export function handleCorsPreFlight(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * Verifica si el origen de la petición está permitido.
 * Retorna HTTP 403 si el origen no coincide con el permitido.
 * Retorna null si el origen es válido y puede continuar el procesamiento.
 *
 * @param req - Objeto Request de la petición entrante
 */
export function enforceOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin") ?? "";

  if (origin !== ALLOWED_ORIGIN) {
    return new Response(
      JSON.stringify({ error: "Origen no autorizado" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return null;
}
