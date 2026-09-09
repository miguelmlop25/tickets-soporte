/**
 * register.js
 * Lógica de registro de cuentas para los roles User y Agent.
 *
 * Responsabilidades:
 *   - Validar en el frontend el dominio del correo, los requisitos de la
 *     contraseña y la coincidencia de la confirmación antes de contactar al
 *     backend (retroalimentación inmediata para el usuario).
 *   - Invocar `supabase.auth.signUp` adjuntando la metadata de rol y nombre,
 *     configurando `emailRedirectTo` hacia el dominio de producción para el
 *     enlace de verificación de correo.
 *   - Traducir los errores devueltos por Supabase Auth (email ya registrado,
 *     dominio inválido, validación de backend) a mensajes claros en español.
 *
 * Regla de seguridad crítica (Requisitos 2.4, 2.5): el registro de cuentas con
 * rol Admin NUNCA se permite desde la aplicación. Las cuentas Admin se crean
 * exclusivamente desde la base de datos. Este módulo rechaza cualquier intento
 * de registrar un rol distinto de 'User' o 'Agent'.
 *
 * Nota de arquitectura: la validación del cliente es una capa de conveniencia.
 * La validación y sanitización autoritativa se realiza siempre en el backend
 * (Supabase Auth + políticas de la base de datos), conforme al Requisito 11.4.
 *
 * Requisitos cubiertos: 1.1, 1.2, 1.3, 1.4, 1.7, 2.4, 2.5, 11.2, 11.4
 */

import { supabase } from '../config.js';
import { validateEmail, validatePassword } from '../modules/validators.js';

// ---------------------------------------------------------------------------
// Constantes del dominio
// ---------------------------------------------------------------------------

/**
 * URL de producción a la que redirigen los enlaces de verificación de correo.
 * Supabase Auth incrusta esta URL en el correo de confirmación (Requisito 1.4).
 */
const EMAIL_REDIRECT_URL = 'https://ticketsoportest.netlify.app';

/**
 * Roles para los que se permite el registro a través del formulario.
 * El rol 'Admin' se omite deliberadamente (Requisitos 2.4, 2.5).
 */
const REGISTRABLE_ROLES = ['User', 'Agent'];

// ---------------------------------------------------------------------------
// Registro de usuario
// ---------------------------------------------------------------------------

/**
 * Registra una nueva cuenta de rol User o Agent.
 *
 * Flujo:
 *   1. Verifica que el rol solicitado sea registrable (nunca Admin).
 *   2. Valida en frontend: dominio del correo, requisitos de la contraseña y
 *      coincidencia con la confirmación.
 *   3. Invoca `supabase.auth.signUp` con la metadata de rol y nombre y con la
 *      URL de redirección del enlace de verificación.
 *   4. Interpreta el resultado y devuelve un objeto uniforme de respuesta.
 *
 * @param {object} formData - Datos del formulario de registro.
 * @param {string} formData.email - Correo corporativo del visitante.
 * @param {string} formData.password - Contraseña propuesta.
 * @param {string} formData.confirmPassword - Confirmación de la contraseña.
 * @param {string} [formData.fullName] - Nombre completo del usuario.
 * @param {('User'|'Agent')} role - Rol solicitado para la nueva cuenta.
 * @returns {Promise<{ success: boolean, message: string, errors: string[], data: (object|null) }>}
 *          `success` indica si el registro se aceptó. `errors` contiene los
 *          mensajes de validación por campo cuando corresponde.
 */
export async function registerUser(formData, role) {
  // Normalización defensiva del payload de entrada.
  const input = formData && typeof formData === 'object' ? formData : {};
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const confirmPassword =
    typeof input.confirmPassword === 'string' ? input.confirmPassword : '';
  const fullName =
    typeof input.fullName === 'string' ? input.fullName.trim() : '';

  // --- Regla de seguridad: solo se permite registrar User o Agent ---
  // Se rechaza cualquier intento de registrar Admin u otro rol desconocido
  // antes de contactar al backend (Requisitos 2.4, 2.5).
  if (!REGISTRABLE_ROLES.includes(role)) {
    return {
      success: false,
      message:
        'El registro de administradores no está permitido por esta vía.',
      errors: ['El registro de administradores no está permitido por esta vía.'],
      data: null,
    };
  }

  // --- Validación frontend: nombre completo ---
  const errors = [];
  if (!fullName) {
    errors.push('El nombre completo es obligatorio.');
  }

  // --- Validación frontend: dominio del correo (Requisitos 1.1, 1.2) ---
  const emailResult = validateEmail(email);
  if (!emailResult.isValid) {
    errors.push(emailResult.error);
  }

  // --- Validación frontend: requisitos de la contraseña (Requisitos 1.1, 1.3) ---
  const passwordResult = validatePassword(password);
  if (!passwordResult.isValid) {
    errors.push(...passwordResult.errors);
  }

  // --- Validación frontend: coincidencia de contraseñas ---
  if (password !== confirmPassword) {
    errors.push('Las contraseñas no coinciden.');
  }

  // Si existe cualquier error de validación local, no se contacta al backend.
  if (errors.length > 0) {
    return {
      success: false,
      message: 'Revise los datos ingresados e intente nuevamente.',
      errors,
      data: null,
    };
  }

  // --- Registro contra Supabase Auth ---
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Enlace de verificación del correo (Requisito 1.4).
        emailRedirectTo: EMAIL_REDIRECT_URL,
        // Metadata usada por el trigger de la base de datos para poblar la
        // tabla `profiles` (full_name NOT NULL y role) tras la verificación.
        data: {
          full_name: fullName,
          role,
        },
      },
    });

    if (error) {
      return mapSignUpError(error);
    }

    // --- Deteccion de correo ya registrado (sin revelar su existencia) ---
    // Supabase, por proteccion contra enumeracion de usuarios, no devuelve
    // error cuando el correo ya existe: responde "exito" pero con el array
    // `identities` vacio. Se detecta ese caso para mostrar un mensaje neutro
    // y util, sin confirmar explicitamente si el correo esta o no registrado.
    const identities = data?.user?.identities;
    const yaRegistrado = Array.isArray(identities) && identities.length === 0;

    if (yaRegistrado) {
      return {
        success: true,
        message:
          'Si el correo no estaba registrado, recibirá un enlace de ' +
          'verificación en su bandeja de entrada. Si ya tiene una cuenta, ' +
          'utilice la opción "Iniciar sesión".',
        errors: [],
        data,
      };
    }

    // Registro aceptado (cuenta nueva): queda pendiente de verificación.
    return {
      success: true,
      message:
        'Cuenta creada. Revise su correo corporativo y confirme su cuenta ' +
        'mediante el enlace de verificación antes de iniciar sesión.',
      errors: [],
      data,
    };
  } catch (unexpected) {
    // Errores de red u otros fallos no controlados por Supabase.
    return {
      success: false,
      message:
        'No fue posible completar el registro por un error de conexión. ' +
        'Intente nuevamente en unos momentos.',
      errors: [unexpected?.message ?? 'Error de conexión.'],
      data: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Traducción de errores de Supabase Auth
// ---------------------------------------------------------------------------

/**
 * Traduce un error devuelto por `supabase.auth.signUp` a la respuesta uniforme
 * de este módulo, cubriendo los casos previstos por el diseño:
 *   - Email ya registrado (HTTP 409).
 *   - Dominio de correo inválido rechazado por el backend (HTTP 400).
 *   - Contraseña débil rechazada por el backend (HTTP 400).
 *   - Cualquier otro error de validación de backend.
 *
 * No se revela información sensible: los mensajes son descriptivos pero no
 * exponen detalles internos de la infraestructura.
 *
 * @param {object} error - Objeto de error de Supabase Auth.
 * @returns {{ success: boolean, message: string, errors: string[], data: null }}
 */
function mapSignUpError(error) {
  const status = error?.status;
  const rawMessage = typeof error?.message === 'string' ? error.message : '';
  const normalized = rawMessage.toLowerCase();

  // Email ya registrado (Requisito 1.7). Supabase suele responder con estado
  // 409/422 o mensajes que contienen "already registered"/"already exists".
  const isDuplicateEmail =
    status === 409 ||
    normalized.includes('already registered') ||
    normalized.includes('already exists') ||
    normalized.includes('user already');
  if (isDuplicateEmail) {
    const message = 'Ya existe una cuenta asociada a ese correo electrónico.';
    return { success: false, message, errors: [message], data: null };
  }

  // Dominio de correo inválido rechazado por el backend (Requisitos 1.2, 11.4).
  const isInvalidDomain =
    normalized.includes('email') &&
    (normalized.includes('invalid') || normalized.includes('domain'));
  if (isInvalidDomain) {
    const message =
      'Por favor ingrese un correo corporativo válido para la creación de su cuenta';
    return { success: false, message, errors: [message], data: null };
  }

  // Contraseña débil rechazada por el backend (Requisito 1.3).
  if (normalized.includes('password')) {
    const message =
      'La contraseña no cumple con los requisitos mínimos de seguridad.';
    return { success: false, message, errors: [message], data: null };
  }

  // Cualquier otro error de validación de backend: se conserva el mensaje
  // original si existe, sin exponer detalles internos.
  const fallback =
    rawMessage ||
    'No fue posible completar el registro. Verifique los datos e intente de nuevo.';
  return { success: false, message: fallback, errors: [fallback], data: null };
}
