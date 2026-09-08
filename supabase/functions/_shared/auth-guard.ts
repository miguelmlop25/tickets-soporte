/**
 * auth-guard.ts
 * Middleware de autenticación y autorización para Edge Functions.
 *
 * Responsabilidades:
 *  - Extraer el Bearer token del header Authorization
 *  - Validar el token contra Supabase Auth
 *  - Retornar el payload del usuario autenticado (user_id y role)
 *  - Rechazar peticiones sin token o con token inválido (HTTP 401)
 *  - Rechazar peticiones cuyo rol no esté en la lista de roles permitidos (HTTP 403)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Roles disponibles en el sistema, en sincronía con el enum user_role de la DB */
export type UserRole = 'User' | 'Agent' | 'Admin';

/** Payload que se retorna tras una verificación exitosa */
export interface AuthPayload {
  user_id: string;
  email: string;
  role: UserRole;
}

/** Resultado de verifyJWT cuando la verificación es exitosa */
export interface VerifySuccess {
  ok: true;
  payload: AuthPayload;
}

/** Resultado de verifyJWT cuando la verificación falla */
export interface VerifyError {
  ok: false;
  response: Response;
}

export type VerifyResult = VerifySuccess | VerifyError;

// ---------------------------------------------------------------------------
// Función principal: verifyJWT
// ---------------------------------------------------------------------------

/**
 * Extrae y valida el Bearer token del header Authorization de la petición.
 *
 * Flujo:
 *  1. Lee el header Authorization; si falta o no es Bearer → HTTP 401
 *  2. Inicializa un cliente Supabase con el token del usuario para que
 *     Auth valide la sesión mediante getUser()
 *  3. Si el token está expirado o es inválido → HTTP 401
 *  4. Consulta el rol del usuario en la tabla profiles → HTTP 401 si no existe
 *  5. Retorna el payload { user_id, email, role }
 *
 * @param req - Objeto Request de la Edge Function
 * @returns VerifyResult con el payload en caso exitoso o una Response de error
 */
export async function verifyJWT(req: Request): Promise<VerifyResult> {
  // 1. Extraer el token del header Authorization
  const authHeader = req.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Token de autorización ausente o con formato incorrecto.' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Token de autorización vacío.' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  // 2. Obtener las variables de entorno necesarias
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[auth-guard] Variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configuradas.');
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Error de configuración del servidor.' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  // 3. Validar el token usando un cliente con service_role para poder
  //    verificar el JWT y luego consultar el perfil del usuario.
  //    getUser(token) valida la firma del JWT sin depender de la sesión local.
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Token inválido o sesión expirada.' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  // 4. Consultar el rol del usuario en la tabla profiles
  //    (la tabla profiles es la fuente de verdad para el rol asignado)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Perfil de usuario no encontrado.' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  // 5. Retornar el payload completo
  return {
    ok: true,
    payload: {
      user_id: user.id,
      email: user.email ?? '',
      role: profile.role as UserRole,
    },
  };
}

// ---------------------------------------------------------------------------
// Función de conveniencia: requireRole
// ---------------------------------------------------------------------------

/**
 * Combina la verificación JWT con la validación del rol del usuario.
 *
 * Retorna el AuthPayload si el usuario está autenticado y su rol está
 * dentro de allowedRoles; de lo contrario retorna la Response de error
 * correspondiente (HTTP 401 para token inválido, HTTP 403 para rol no autorizado).
 *
 * Uso típico en una Edge Function:
 *
 * ```ts
 * const result = await requireRole(req, ['Agent']);
 * if (!result.ok) return result.response;
 * const { user_id, role } = result.payload;
 * ```
 *
 * @param req          - Objeto Request de la Edge Function
 * @param allowedRoles - Lista de roles autorizados para el endpoint
 * @returns VerifyResult con el payload en caso exitoso o una Response de error
 */
export async function requireRole(
  req: Request,
  allowedRoles: UserRole[]
): Promise<VerifyResult> {
  // Verificar el JWT primero
  const result = await verifyJWT(req);

  if (!result.ok) {
    // El JWT falló; retornar el error 401 tal cual
    return result;
  }

  // Verificar que el rol del usuario esté dentro de los roles permitidos
  if (!allowedRoles.includes(result.payload.role)) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: `Acceso denegado. Se requiere uno de los siguientes roles: ${allowedRoles.join(', ')}.`,
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  return result;
}
