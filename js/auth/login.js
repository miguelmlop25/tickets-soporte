/**
 * login.js
 * Lógica de inicio de sesión por rol.
 *
 * Responsabilidades:
 *   - Autenticar al usuario contra Supabase Auth (email + password).
 *   - Verificar que el rol almacenado en `profiles` coincida con el rol
 *     seleccionado en el login; si no coincide, cerrar la sesión y denegar
 *     el acceso (evita que un User acceda por el flujo de Agent/Admin).
 *   - Traducir los errores de Supabase Auth a mensajes en español conforme
 *     al catálogo de errores del diseño, sin revelar cuál campo es incorrecto.
 *   - Renderizar el formulario de login correspondiente al rol seleccionado.
 *
 * Nota de seguridad: la validación autoritativa de permisos se realiza en el
 * backend (RLS + Auth Guard en Edge Functions). Esta verificación de rol en el
 * cliente es una capa adicional de coherencia de flujo, no la única defensa.
 *
 * Requisitos cubiertos: 1.8, 1.9, 1.6, 2.2
 */

import { supabase } from '../config.js';
import { validateEmail } from '../modules/validators.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Roles válidos del sistema (Requisito 2.1). */
export const VALID_ROLES = ['User', 'Agent', 'Admin'];

/**
 * Etiquetas legibles por rol para los títulos del formulario.
 * Los identificadores de rol permanecen en inglés (convención del proyecto);
 * las etiquetas mostradas al usuario están en español.
 */
const ROLE_LABELS = {
  User: 'Usuario',
  Agent: 'Agente',
  Admin: 'Administrador',
};

/**
 * Rutas de redirección al panel correspondiente según el rol.
 * Se usan tras un inicio de sesión exitoso con rol coincidente.
 */
export const ROLE_PANEL_ROUTES = {
  User: 'pages/user-panel.html',
  Agent: 'pages/agent-panel.html',
  Admin: 'pages/admin-panel.html',
};

/**
 * Catálogo de mensajes de error de autenticación (según el diseño).
 * Los mensajes de credenciales son genéricos para no revelar qué campo falla
 * (Requisito 1.9).
 */
const AUTH_ERROR_MESSAGES = {
  invalidCredentials: 'Correo o contraseña incorrectos',
  emailNotConfirmed: 'Debe verificar su correo electrónico antes de iniciar sesión',
  accountBlocked: 'Cuenta bloqueada temporalmente por intentos fallidos',
  rateLimited: 'Se ha superado el límite de intentos',
  roleMismatch: 'Acceso no autorizado para el rol seleccionado',
  emailInvalid:
    'Por favor ingrese un correo corporativo válido para la creación de su cuenta',
  generic: 'No fue posible iniciar sesión. Intente nuevamente más tarde.',
};

// ---------------------------------------------------------------------------
// Traducción de errores de Supabase Auth
// ---------------------------------------------------------------------------

/**
 * Traduce un error devuelto por Supabase Auth a un mensaje del catálogo.
 *
 * Supabase no expone un catálogo estable de códigos, por lo que se inspeccionan
 * tanto `status` como el `message`/`code` conocidos. Ante cualquier condición
 * no reconocida se retorna el mensaje de credenciales genérico para no filtrar
 * información sobre la existencia de la cuenta (Requisito 1.9).
 *
 * @param {object} error - Objeto de error de Supabase Auth.
 * @returns {string} Mensaje en español para mostrar al usuario.
 */
function mapAuthError(error) {
  if (!error) {
    return AUTH_ERROR_MESSAGES.generic;
  }

  const status = error.status;
  const code = (error.code || '').toLowerCase();
  const message = (error.message || '').toLowerCase();

  // Rate limit excedido en el endpoint de login (Requisito 1.14).
  if (status === 429 || code === 'over_request_rate_limit') {
    return AUTH_ERROR_MESSAGES.rateLimited;
  }

  // Cuenta bloqueada temporalmente por intentos fallidos (Requisito 10.7).
  if (status === 423 || message.includes('locked') || message.includes('banned')) {
    return AUTH_ERROR_MESSAGES.accountBlocked;
  }

  // Email no verificado (Requisito 1.6).
  if (
    code === 'email_not_confirmed' ||
    message.includes('email not confirmed') ||
    message.includes('not confirmed')
  ) {
    return AUTH_ERROR_MESSAGES.emailNotConfirmed;
  }

  // Credenciales inválidas: mensaje genérico (Requisito 1.9).
  return AUTH_ERROR_MESSAGES.invalidCredentials;
}

// ---------------------------------------------------------------------------
// Inicio de sesión con verificación de rol
// ---------------------------------------------------------------------------

/**
 * Inicia sesión validando que el rol del perfil coincida con el rol seleccionado.
 *
 * Flujo (según el diseño "Flujo de inicio de sesión"):
 *   1. Validar formato del correo corporativo antes de contactar al backend.
 *   2. `supabase.auth.signInWithPassword` con las credenciales.
 *   3. Consultar el rol en `profiles` para el usuario autenticado.
 *   4. Si el rol no coincide con `selectedRole`: `signOut` y retornar error.
 *   5. Si coincide: retornar la sesión y la ruta del panel correspondiente.
 *
 * @param {string} email - Correo corporativo del usuario.
 * @param {string} password - Contraseña del usuario.
 * @param {string} selectedRole - Rol seleccionado en el login ('User' | 'Agent' | 'Admin').
 * @returns {Promise<{ success: boolean, error: (string|null), role: (string|null),
 *                     redirectTo: (string|null), session: (object|null) }>}
 */
export async function loginWithRole(email, password, selectedRole) {
  // Validación defensiva del rol seleccionado.
  if (!VALID_ROLES.includes(selectedRole)) {
    return {
      success: false,
      error: AUTH_ERROR_MESSAGES.generic,
      role: null,
      redirectTo: null,
      session: null,
    };
  }

  // Validación temprana del dominio del correo (evita una petición innecesaria).
  const emailCheck = validateEmail(email);
  if (!emailCheck.isValid) {
    return {
      success: false,
      error: emailCheck.error,
      role: null,
      redirectTo: null,
      session: null,
    };
  }

  // Validación mínima de la contraseña: no debe estar vacía.
  if (typeof password !== 'string' || password.length === 0) {
    return {
      success: false,
      error: AUTH_ERROR_MESSAGES.invalidCredentials,
      role: null,
      redirectTo: null,
      session: null,
    };
  }

  try {
    // Paso 2: autenticación contra Supabase Auth.
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      return {
        success: false,
        error: mapAuthError(error),
        role: null,
        redirectTo: null,
        session: null,
      };
    }

    const userId = data?.user?.id;
    if (!userId) {
      // Situación anómala: sesión sin usuario. Se trata como credencial inválida.
      return {
        success: false,
        error: AUTH_ERROR_MESSAGES.invalidCredentials,
        role: null,
        redirectTo: null,
        session: null,
      };
    }

    // Paso 3: consultar el rol del perfil (RLS permite leer el perfil propio).
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    // Si no se puede determinar el rol, se cierra la sesión por seguridad.
    if (profileError || !profile) {
      await supabase.auth.signOut();
      return {
        success: false,
        error: AUTH_ERROR_MESSAGES.roleMismatch,
        role: null,
        redirectTo: null,
        session: null,
      };
    }

    // Paso 4: verificar coincidencia de rol; si no coincide, cerrar sesión.
    if (profile.role !== selectedRole) {
      await supabase.auth.signOut();
      return {
        success: false,
        error: AUTH_ERROR_MESSAGES.roleMismatch,
        role: null,
        redirectTo: null,
        session: null,
      };
    }

    // Paso 5: inicio de sesión exitoso con rol coincidente.
    return {
      success: true,
      error: null,
      role: profile.role,
      redirectTo: ROLE_PANEL_ROUTES[profile.role] ?? null,
      session: data.session ?? null,
    };
  } catch (unexpected) {
    // Error de red u otra excepción imprevista: mensaje genérico, sin detalles.
    console.error('Error inesperado durante el inicio de sesión:', unexpected);
    return {
      success: false,
      error: AUTH_ERROR_MESSAGES.generic,
      role: null,
      redirectTo: null,
      session: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Renderizado del formulario de login por rol
// ---------------------------------------------------------------------------

/**
 * Renderiza el formulario de inicio de sesión correspondiente al rol.
 *
 * El formulario incluye campos de correo y contraseña, un contenedor para
 * mensajes de error y el enlace "Olvidé mi contraseña". Para User y Agent se
 * habilita adicionalmente un enlace para registrarse; para Admin no, dado que
 * las cuentas Admin se crean directamente desde la base de datos (Requisito 2.4).
 *
 * El manejo del submit (invocar `loginWithRole`) se delega a la página que
 * consume este formulario, para mantener este módulo desacoplado de la
 * orquestación de la vista.
 *
 * @param {string} role - Rol seleccionado ('User' | 'Agent' | 'Admin').
 * @returns {HTMLFormElement} Elemento <form> listo para insertarse en el DOM.
 */
export function renderLoginForm(role) {
  // Validación defensiva: ante un rol desconocido se asume 'User'.
  const safeRole = VALID_ROLES.includes(role) ? role : 'User';
  const label = ROLE_LABELS[safeRole];
  const allowRegister = safeRole !== 'Admin';

  const form = document.createElement('form');
  form.className = 'login-form';
  form.setAttribute('novalidate', 'novalidate');
  form.dataset.role = safeRole;

  // Título del formulario según el rol.
  const title = document.createElement('h2');
  title.className = 'login-form__title';
  title.textContent = `Iniciar sesión — ${label}`;
  form.appendChild(title);

  // Campo: correo electrónico.
  form.appendChild(
    buildField({
      id: `login-email-${safeRole}`,
      name: 'email',
      type: 'email',
      label: 'Correo corporativo',
      autocomplete: 'email',
      placeholder: 'usuario@solucionesteneria.com',
    }),
  );

  // Campo: contraseña.
  form.appendChild(
    buildField({
      id: `login-password-${safeRole}`,
      name: 'password',
      type: 'password',
      label: 'Contraseña',
      autocomplete: 'current-password',
      placeholder: '',
    }),
  );

  // Contenedor para mensajes de error de autenticación (accesible).
  const errorBox = document.createElement('p');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.setAttribute('aria-live', 'assertive');
  errorBox.hidden = true;
  form.appendChild(errorBox);

  // Botón de envío.
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'login-form__submit';
  submitButton.textContent = 'Iniciar sesión';
  form.appendChild(submitButton);

  // Enlace "Olvidé mi contraseña" (Requisito 1.10).
  const forgotLink = document.createElement('a');
  forgotLink.className = 'login-form__forgot';
  forgotLink.href = '#';
  forgotLink.dataset.action = 'forgot-password';
  forgotLink.textContent = 'Olvidé mi contraseña';
  form.appendChild(forgotLink);

  if (allowRegister) {
    // Enlace de registro para User y Agent (Requisito 2.3).
    const registerLink = document.createElement('a');
    registerLink.className = 'login-form__register';
    registerLink.href = '#';
    registerLink.dataset.action = 'register';
    registerLink.dataset.role = safeRole;
    registerLink.textContent = 'Crear una cuenta nueva';
    form.appendChild(registerLink);
  } else {
    // Mensaje informativo para Admin (Requisito 2.4 / 11.6).
    const adminNote = document.createElement('p');
    adminNote.className = 'login-form__admin-note';
    adminNote.textContent =
      'El registro de administradores no se permite. Solo es posible iniciar sesión.';
    form.appendChild(adminNote);
  }

  return form;
}

/**
 * Construye un grupo de campo (label + input) reutilizable para el formulario.
 *
 * @param {object} config - Configuración del campo.
 * @param {string} config.id - Identificador único del input.
 * @param {string} config.name - Atributo name del input.
 * @param {string} config.type - Tipo del input (email, password, etc.).
 * @param {string} config.label - Texto de la etiqueta visible.
 * @param {string} config.autocomplete - Valor del atributo autocomplete.
 * @param {string} config.placeholder - Texto de marcador de posición.
 * @returns {HTMLDivElement} Contenedor del campo.
 */
function buildField({ id, name, type, label, autocomplete, placeholder }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'login-form__field';

  const labelEl = document.createElement('label');
  labelEl.setAttribute('for', id);
  labelEl.className = 'login-form__label';
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.id = id;
  input.name = name;
  input.type = type;
  input.className = 'login-form__input';
  input.required = true;
  input.autocomplete = autocomplete;
  if (placeholder) {
    input.placeholder = placeholder;
  }

  wrapper.appendChild(labelEl);
  wrapper.appendChild(input);
  return wrapper;
}
