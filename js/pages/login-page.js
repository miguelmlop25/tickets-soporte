/**
 * login-page.js
 * Orquestación de la pantalla de login (index.html).
 *
 * Responsabilidades:
 *   - Gestionar la selección de rol (User / Agent / Admin) y mostrar el área
 *     de autenticación correspondiente (Requisitos 2.2, 2.3, 2.4, 11.1).
 *   - Alternar entre las pestañas Iniciar Sesión / Registrarse para User/Agent;
 *     para Admin mostrar únicamente el login con un aviso informativo
 *     (Requisitos 2.4, 11.6).
 *   - Inyectar el formulario de login generado por renderLoginForm(role) y
 *     conectar su envío con loginWithRole(), redirigiendo al panel del rol.
 *   - Conectar el formulario de registro con registerUser() (Requisitos 11.2, 11.4).
 *   - Gestionar el enlace "Olvidé mi contraseña" mediante Supabase Auth.
 *   - Mostrar mensajes provenientes del parámetro de query "message" (por ejemplo,
 *     sesión expirada enviada por session.js).
 *
 * Toda la lógica vive en este módulo porque la CSP del proyecto no permite
 * scripts inline (script-src 'self' + CDNs).
 *
 * Requisitos cubiertos: 2.2, 2.3, 2.4, 11.1, 11.2, 11.4, 11.6
 */

import { supabase } from '../config.js';
import { loginWithRole, renderLoginForm, ROLE_PANEL_ROUTES } from '../auth/login.js';
import { registerUser } from '../auth/register.js';
import { validateEmail } from '../modules/validators.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/**
 * URL de producción a la que redirige el enlace de recuperación de contraseña
 * (Requisito 1.10). Coincide con el dominio autorizado del proyecto.
 */
const PASSWORD_RESET_REDIRECT_URL = 'https://ticketsoportest.netlify.app';

/** Etiquetas legibles por rol para los títulos del área de autenticación. */
const ROLE_LABELS = {
  User: 'Usuario',
  Agent: 'Agente',
  Admin: 'Administrador',
};

// ---------------------------------------------------------------------------
// Estado del módulo
// ---------------------------------------------------------------------------

/** Rol actualmente seleccionado; null mientras se muestra la selección inicial. */
let selectedRole = null;

// Referencias a los nodos del DOM (se resuelven en init()).
let roleSelectionSection;
let authAreaSection;
let authAreaTitle;
let authTabs;
let loginPanel;
let loginFormContainer;
let registerPanel;
let registerForm;
let registerMessageBox;
let globalMessageBox;

// ---------------------------------------------------------------------------
// Utilidades de UI
// ---------------------------------------------------------------------------

/**
 * Muestra un mensaje en un contenedor de alerta, aplicando la variante de estilo
 * indicada y haciéndolo visible.
 *
 * @param {HTMLElement} box - Contenedor de la alerta.
 * @param {string} message - Texto a mostrar.
 * @param {('success'|'danger'|'warning'|'info')} [variant='info'] - Variante visual.
 */
function showMessage(box, message, variant = 'info') {
  if (!box) return;
  // Se conserva la clase base "alert" y se reemplaza la variante.
  box.className = `alert alert-${variant}`;
  box.textContent = message;
  box.hidden = false;
}

/**
 * Oculta y limpia un contenedor de alerta.
 *
 * @param {HTMLElement} box - Contenedor de la alerta.
 */
function clearMessage(box) {
  if (!box) return;
  box.textContent = '';
  box.hidden = true;
}

/**
 * Lee el parámetro de query "message" de la URL y lo muestra en el mensaje
 * global. session.js usa este parámetro para informar, por ejemplo, de una
 * sesión expirada por inactividad.
 */
function showQueryMessage() {
  const params = new URLSearchParams(window.location.search);
  const message = params.get('message');
  if (message) {
    showMessage(globalMessageBox, message, 'info');
  }
}

// ---------------------------------------------------------------------------
// Selección de rol y navegación entre vistas
// ---------------------------------------------------------------------------

/**
 * Aplica la selección de un rol: oculta la selección inicial, muestra el área de
 * autenticación y configura pestañas y paneles según el rol.
 *
 * Para User y Agent se muestran las pestañas Iniciar Sesión / Registrarse
 * (Requisito 2.3). Para Admin se ocultan las pestañas y el panel de registro,
 * dejando visible solo el login (Requisitos 2.4, 11.6).
 *
 * @param {('User'|'Agent'|'Admin')} role - Rol seleccionado.
 */
function selectRole(role) {
  selectedRole = role;

  // Alterna las vistas principales.
  roleSelectionSection.hidden = true;
  authAreaSection.hidden = false;

  authAreaTitle.textContent = `Acceso - ${ROLE_LABELS[role] ?? role}`;

  // Inyecta el formulario de login correspondiente al rol.
  renderLoginPanel(role);

  const isAdmin = role === 'Admin';

  // Admin: sin pestañas ni registro. User/Agent: con ambas opciones.
  authTabs.hidden = isAdmin;
  registerPanel.hidden = true; // el registro siempre inicia oculto
  loginPanel.hidden = false;

  if (!isAdmin) {
    // Se reinicia siempre a la pestaña de login al entrar.
    setActiveTab('login');
  }

  clearMessage(registerMessageBox);
}

/**
 * Regresa a la pantalla de selección de rol, restableciendo el estado.
 */
function backToRoleSelection() {
  selectedRole = null;
  authAreaSection.hidden = true;
  roleSelectionSection.hidden = false;
  loginFormContainer.replaceChildren();
  clearMessage(registerMessageBox);
}

/**
 * Activa una pestaña (login o register) y sincroniza la visibilidad de los
 * paneles y los atributos de accesibilidad de las pestañas.
 *
 * @param {('login'|'register')} tabName - Pestaña a activar.
 */
function setActiveTab(tabName) {
  const tabs = authTabs.querySelectorAll('.auth-tabs__tab');
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle('auth-tabs__tab--active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  const showLogin = tabName === 'login';
  loginPanel.hidden = !showLogin;
  registerPanel.hidden = showLogin;
}

// ---------------------------------------------------------------------------
// Panel de login
// ---------------------------------------------------------------------------

/**
 * Genera el formulario de login del rol mediante renderLoginForm() y lo inserta
 * en el contenedor, registrando el manejador de envío y los enlaces internos
 * ("Olvidé mi contraseña" y, para User/Agent, "Crear una cuenta nueva").
 *
 * @param {('User'|'Agent'|'Admin')} role - Rol seleccionado.
 */
function renderLoginPanel(role) {
  const form = renderLoginForm(role);

  // Envío del formulario de login.
  form.addEventListener('submit', (event) => handleLoginSubmit(event, form, role));

  // Delegación de clics para los enlaces generados dentro del formulario.
  form.addEventListener('click', (event) => {
    const target = event.target.closest('a[data-action]');
    if (!target) return;

    event.preventDefault();
    const action = target.dataset.action;

    if (action === 'forgot-password') {
      handleForgotPassword(form);
    } else if (action === 'register') {
      // Cambia a la pestaña de registro (solo disponible para User/Agent).
      setActiveTab('register');
    }
  });

  // Reemplaza el contenido previo del contenedor por el nuevo formulario.
  loginFormContainer.replaceChildren(form);
}

/**
 * Maneja el envío del formulario de login: valida, invoca loginWithRole() y, en
 * caso de éxito, redirige al panel del rol correspondiente.
 *
 * @param {SubmitEvent} event - Evento de envío.
 * @param {HTMLFormElement} form - Formulario de login.
 * @param {string} role - Rol seleccionado.
 */
async function handleLoginSubmit(event, form, role) {
  event.preventDefault();

  const errorBox = form.querySelector('.login-form__error');
  const submitButton = form.querySelector('.login-form__submit');

  const email = form.elements.email?.value ?? '';
  const password = form.elements.password?.value ?? '';

  // Oculta cualquier error previo.
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  // Evita envíos duplicados mientras se procesa la petición.
  if (submitButton) submitButton.disabled = true;

  try {
    const result = await loginWithRole(email, password, role);

    if (result.success) {
      // Redirige al panel del rol. Se usa la ruta devuelta o el mapa como respaldo.
      const target = result.redirectTo ?? ROLE_PANEL_ROUTES[role] ?? null;
      if (target) {
        window.location.assign(target);
        return;
      }
    }

    // Muestra el error de autenticación devuelto por el módulo.
    if (errorBox) {
      errorBox.textContent = result.error ?? 'No fue posible iniciar sesión.';
      errorBox.hidden = false;
    }
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

/**
 * Maneja el enlace "Olvidé mi contraseña": solicita el correo corporativo,
 * valida su dominio y envía el correo de recuperación mediante Supabase Auth
 * con redirección al dominio de producción (Requisito 1.10).
 *
 * @param {HTMLFormElement} form - Formulario de login (fuente del correo ingresado).
 */
async function handleForgotPassword(form) {
  const errorBox = form.querySelector('.login-form__error');

  // Se reutiliza el correo ya escrito en el formulario, si existe.
  const email = (form.elements.email?.value ?? '').trim();

  // El correo debe pertenecer al dominio corporativo antes de intentar el envío.
  const emailCheck = validateEmail(email);
  if (!emailCheck.isValid) {
    if (errorBox) {
      errorBox.className = 'login-form__error';
      errorBox.textContent =
        email.length === 0
          ? 'Ingrese su correo corporativo para recuperar la contraseña.'
          : emailCheck.error;
      errorBox.hidden = false;
    }
    return;
  }

  try {
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: PASSWORD_RESET_REDIRECT_URL,
    });

    // Se muestra siempre un mensaje neutro: no se revela si el correo existe,
    // evitando la enumeración de cuentas.
    if (errorBox) {
      errorBox.textContent =
        'Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.';
      errorBox.hidden = false;
    }
  } catch (unexpected) {
    console.error('Error al solicitar la recuperación de contraseña:', unexpected);
    if (errorBox) {
      errorBox.textContent =
        'No fue posible procesar la solicitud. Intente nuevamente más tarde.';
      errorBox.hidden = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Formulario de registro
// ---------------------------------------------------------------------------

/**
 * Maneja el envío del formulario de registro (solo User/Agent): recopila los
 * datos, invoca registerUser() con el rol seleccionado y muestra el resultado.
 *
 * @param {SubmitEvent} event - Evento de envío.
 */
async function handleRegisterSubmit(event) {
  event.preventDefault();

  // Salvaguarda: el registro solo aplica a User y Agent (Requisito 2.4).
  if (selectedRole !== 'User' && selectedRole !== 'Agent') {
    showMessage(
      registerMessageBox,
      'El registro no está disponible para este tipo de acceso.',
      'danger',
    );
    return;
  }

  clearMessage(registerMessageBox);

  const formData = {
    fullName: registerForm.elements.fullName?.value ?? '',
    email: registerForm.elements.email?.value ?? '',
    password: registerForm.elements.password?.value ?? '',
    confirmPassword: registerForm.elements.confirmPassword?.value ?? '',
  };

  const submitButton = registerForm.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;

  try {
    const result = await registerUser(formData, selectedRole);

    if (result.success) {
      showMessage(registerMessageBox, result.message, 'success');
      registerForm.reset();
    } else {
      // Se concatenan los errores de validación por campo en un único mensaje.
      const detail =
        Array.isArray(result.errors) && result.errors.length > 0
          ? result.errors.join(' ')
          : result.message;
      showMessage(registerMessageBox, detail, 'danger');
    }
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------------------

/**
 * Inicializa la página de login: resuelve referencias del DOM, registra los
 * manejadores de eventos y muestra el mensaje del parámetro de query si existe.
 */
function init() {
  roleSelectionSection = document.getElementById('role-selection');
  authAreaSection = document.getElementById('auth-area');
  authAreaTitle = document.getElementById('auth-area-title');
  authTabs = document.getElementById('auth-tabs');
  loginPanel = document.getElementById('login-panel');
  loginFormContainer = document.getElementById('login-form-container');
  registerPanel = document.getElementById('register-panel');
  registerForm = document.getElementById('register-form');
  registerMessageBox = document.getElementById('register-message');
  globalMessageBox = document.getElementById('global-message');

  // Botones de selección de rol.
  roleSelectionSection.querySelectorAll('.role-selector__btn').forEach((btn) => {
    btn.addEventListener('click', () => selectRole(btn.dataset.role));
  });

  // Botón para volver a la selección de rol.
  authAreaSection
    .querySelector('[data-action="back"]')
    ?.addEventListener('click', backToRoleSelection);

  // Cambio de pestañas (Iniciar Sesión / Registrarse).
  authTabs.querySelectorAll('.auth-tabs__tab').forEach((tab) => {
    tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
  });

  // Envío del formulario de registro.
  registerForm.addEventListener('submit', handleRegisterSubmit);

  // Mensaje proveniente de la URL (por ejemplo, sesión expirada).
  showQueryMessage();
}

// Ejecuta la inicialización cuando el DOM está listo. El script es un módulo con
// defer implícito, pero se comprueba el estado por robustez.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
