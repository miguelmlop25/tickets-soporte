// session.js — Gestión de la sesión activa del usuario.
//
// Responsabilidades:
//  - Vigilar la inactividad del usuario e invalidar la sesión tras 30 minutos
//    sin actividad (Requisito 10.8).
//  - Exponer la sesión activa de Supabase Auth.
//  - Proteger páginas verificando sesión y rol antes de renderizarlas.
//
// Toda la seguridad real de los datos se garantiza en la base de datos mediante
// Row Level Security. Las comprobaciones de este módulo son controles de la
// interfaz para mejorar la experiencia y evitar mostrar pantallas a las que el
// usuario no debería acceder; nunca sustituyen a la validación del backend.

import { supabase } from '../config.js';

// Tiempo máximo de inactividad permitido antes de cerrar la sesión: 30 minutos
// expresados en milisegundos (Requisito 10.8).
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

// Ruta absoluta de la pantalla de login. Se usa una ruta absoluta para que la
// redirección funcione correctamente desde cualquier profundidad de página
// (index.html en la raíz o paneles dentro de /pages/).
const LOGIN_PATH = '/index.html';

// Eventos del navegador que se consideran señales de actividad del usuario.
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click'];

// Identificador del temporizador de inactividad. Se mantiene a nivel de módulo
// para poder reiniciarlo en cada evento de actividad.
let inactivityTimerId = null;

/**
 * Redirige a la pantalla de login añadiendo un mensaje opcional como parámetro
 * de consulta. El login puede leer este parámetro para informar al usuario del
 * motivo (por ejemplo, expiración de sesión).
 *
 * @param {string} [message] Mensaje a mostrar en el login.
 */
function redirectToLogin(message) {
  const url = message
    ? `${LOGIN_PATH}?message=${encodeURIComponent(message)}`
    : LOGIN_PATH;
  window.location.replace(url);
}

/**
 * Cierra la sesión activa por inactividad y redirige al login con un mensaje
 * explicativo. Se invoca cuando expira el temporizador de inactividad.
 */
async function handleInactivityTimeout() {
  try {
    await supabase.auth.signOut();
  } catch (error) {
    // Aunque falle el signOut remoto, se continúa con la redirección para no
    // dejar al usuario en una página protegida. Se registra el error para
    // facilitar el diagnóstico.
    console.error('Error al cerrar la sesión por inactividad:', error);
  }
  redirectToLogin('Tu sesión se cerró por inactividad. Inicia sesión nuevamente.');
}

/**
 * Reinicia el temporizador de inactividad. Cada evento de actividad del usuario
 * cancela el temporizador anterior y programa uno nuevo.
 */
function resetInactivityTimer() {
  if (inactivityTimerId !== null) {
    clearTimeout(inactivityTimerId);
  }
  inactivityTimerId = setTimeout(handleInactivityTimeout, INACTIVITY_TIMEOUT_MS);
}

/**
 * Inicia la vigilancia de inactividad de la sesión.
 *
 * Registra escuchadores para los eventos de actividad del usuario (mousemove,
 * keydown, click). Mientras exista actividad dentro de la ventana de 30 minutos
 * la sesión se mantiene; si transcurre ese tiempo sin actividad, se cierra la
 * sesión y se redirige al login (Requisito 10.8).
 *
 * Debe llamarse una sola vez durante la inicialización de cada página protegida.
 */
export function initSessionWatcher() {
  // Se usa un escuchador pasivo porque estos eventos no requieren prevenir el
  // comportamiento por defecto; esto mejora el rendimiento del desplazamiento.
  ACTIVITY_EVENTS.forEach((eventName) => {
    window.addEventListener(eventName, resetInactivityTimer, { passive: true });
  });

  // Se arranca el temporizador inicial: si el usuario no interactúa desde el
  // primer momento, la sesión también expirará correctamente.
  resetInactivityTimer();
}

/**
 * Obtiene la sesión activa de Supabase Auth.
 *
 * @returns {Promise<import('@supabase/supabase-js').Session | null>}
 *   La sesión activa, o `null` si no hay sesión o si ocurre un error al obtenerla.
 */
export async function getActiveSession() {
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    console.error('Error al obtener la sesión activa:', error);
    return null;
  }

  return data.session ?? null;
}

/**
 * Verifica que exista una sesión activa y que el rol del usuario esté dentro de
 * los roles permitidos para la página. Si no se cumple alguna condición, redirige
 * al login.
 *
 * El rol se consulta en la tabla `profiles`, que es la fuente de verdad del rol
 * del usuario (las políticas RLS dependen de este mismo valor).
 *
 * @param {string[]} allowedRoles Roles autorizados para la página (por ejemplo
 *   ['User'], ['Agent'], ['Admin']).
 * @returns {Promise<{ session: object, profile: object } | null>}
 *   Los datos de sesión y perfil si el acceso es válido; `null` si se redirige.
 */
export async function requireAuth(allowedRoles) {
  const session = await getActiveSession();

  // Sin sesión activa no se puede continuar: se redirige al login.
  if (!session) {
    redirectToLogin('Debes iniciar sesión para acceder a esta página.');
    return null;
  }

  // Se consulta el rol del usuario autenticado en la tabla profiles. La consulta
  // filtra por el id de la sesión y espera exactamente una fila.
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, role, is_active')
    .eq('id', session.user.id)
    .single();

  // Si no se puede recuperar el perfil (error de red, perfil inexistente, etc.)
  // se deniega el acceso por precaución.
  if (error || !profile) {
    console.error('Error al obtener el perfil del usuario:', error);
    redirectToLogin('No se pudo verificar tu cuenta. Inicia sesión nuevamente.');
    return null;
  }

  // Una cuenta bloqueada no puede acceder aunque el rol sea correcto.
  if (profile.is_active === false) {
    await supabase.auth.signOut();
    redirectToLogin('Tu cuenta está bloqueada. Contacta al administrador.');
    return null;
  }

  // El rol del perfil debe estar dentro de los roles permitidos para la página.
  if (!allowedRoles.includes(profile.role)) {
    redirectToLogin('No tienes permisos para acceder a esta página.');
    return null;
  }

  return { session, profile };
}
