/**
 * ui-dialogs.js
 * Componentes de interfaz para reemplazar los diálogos nativos del navegador
 * (alert, confirm, prompt) por elementos integrados en el sistema, con
 * estética coherente al tema Liquid Glass.
 *
 * Expone tres utilidades basadas en promesas:
 *   - showToast(message, variant)        → notificación efímera (reemplaza alert informativo).
 *   - showConfirm({ title, message, ... }) → modal de confirmación (reemplaza confirm). Devuelve Promise<boolean>.
 *   - showPrompt({ title, message, ... })  → modal con campo de texto (reemplaza prompt). Devuelve Promise<string|null>.
 *
 * No dependen de Bootstrap JS: se construyen con DOM puro y se estilizan con
 * las clases .sys-* definidas en main.css. Así funcionan aunque el bundle de
 * Bootstrap no esté cargado en una página concreta.
 *
 * Nota: este módulo es exclusivamente de presentación (UI). No contiene lógica
 * de negocio ni llamadas a Supabase.
 */

// ---------------------------------------------------------------------------
// Contenedor raíz para overlays y toasts (se crea una sola vez)
// ---------------------------------------------------------------------------

/**
 * Garantiza la existencia del contenedor de toasts en el DOM y lo devuelve.
 * @returns {HTMLElement}
 */
function getToastContainer() {
  let container = document.getElementById('sys-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'sys-toast-container';
    container.className = 'sys-toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(container);
  }
  return container;
}

// ---------------------------------------------------------------------------
// showToast — notificación efímera
// ---------------------------------------------------------------------------

/**
 * Muestra una notificación efímera (toast) en la esquina de la pantalla.
 * Reemplaza los usos de alert() para mensajes informativos o de error.
 *
 * @param {string} message - Texto a mostrar.
 * @param {('info'|'success'|'danger'|'warning')} [variant='info'] - Variante visual.
 * @param {number} [durationMs=4000] - Duración antes de autodescartarse.
 */
export function showToast(message, variant = 'info', durationMs = 4000) {
  const container = getToastContainer();

  const toast = document.createElement('div');
  toast.className = `sys-toast sys-toast--${variant}`;
  toast.setAttribute('role', variant === 'danger' ? 'alert' : 'status');

  // Icono acorde a la variante (Bootstrap Icons).
  const iconClass = {
    info: 'bi-info-circle',
    success: 'bi-check-circle',
    danger: 'bi-exclamation-octagon',
    warning: 'bi-exclamation-triangle',
  }[variant] || 'bi-info-circle';

  const icon = document.createElement('i');
  icon.className = `bi ${iconClass} sys-toast__icon`;
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'sys-toast__message';
  text.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sys-toast__close';
  closeBtn.setAttribute('aria-label', 'Cerrar notificación');
  closeBtn.innerHTML = '<i class="bi bi-x-lg" aria-hidden="true"></i>';

  toast.append(icon, text, closeBtn);
  container.appendChild(toast);

  // Animación de entrada en el siguiente frame.
  requestAnimationFrame(() => toast.classList.add('sys-toast--visible'));

  let timeoutId = null;
  const dismiss = () => {
    if (timeoutId) clearTimeout(timeoutId);
    toast.classList.remove('sys-toast--visible');
    // Retirar del DOM tras la transición de salida.
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  closeBtn.addEventListener('click', dismiss);
  timeoutId = setTimeout(dismiss, durationMs);
}

// ---------------------------------------------------------------------------
// Overlay modal genérico
// ---------------------------------------------------------------------------

/**
 * Construye y muestra un overlay modal genérico con foco atrapado básico.
 * Devuelve referencias para que quien lo invoque resuelva su promesa.
 *
 * @param {object} opts
 * @param {string} opts.title - Título del modal.
 * @param {string} opts.message - Mensaje descriptivo.
 * @param {string} [opts.iconClass] - Clase de icono Bootstrap Icons para el encabezado.
 * @returns {{ overlay: HTMLElement, body: HTMLElement, footer: HTMLElement, close: Function }}
 */
function buildModal({ title, message, iconClass }) {
  const overlay = document.createElement('div');
  overlay.className = 'sys-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const modal = document.createElement('div');
  modal.className = 'sys-modal';

  // Encabezado con icono opcional.
  const header = document.createElement('div');
  header.className = 'sys-modal__header';
  if (iconClass) {
    const icon = document.createElement('i');
    icon.className = `bi ${iconClass} sys-modal__icon`;
    icon.setAttribute('aria-hidden', 'true');
    header.appendChild(icon);
  }
  const titleEl = document.createElement('h3');
  titleEl.className = 'sys-modal__title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  // Cuerpo con el mensaje.
  const body = document.createElement('div');
  body.className = 'sys-modal__body';
  if (message) {
    const p = document.createElement('p');
    p.className = 'sys-modal__message';
    p.textContent = message;
    body.appendChild(p);
  }

  // Pie con acciones.
  const footer = document.createElement('div');
  footer.className = 'sys-modal__footer';

  modal.append(header, body, footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Animación de entrada.
  requestAnimationFrame(() => overlay.classList.add('sys-modal-overlay--visible'));

  const close = () => {
    overlay.classList.remove('sys-modal-overlay--visible');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  };

  return { overlay, body, footer, close };
}

// ---------------------------------------------------------------------------
// showConfirm — modal de confirmación
// ---------------------------------------------------------------------------

/**
 * Muestra un modal de confirmación. Reemplaza a window.confirm().
 *
 * @param {object} opts
 * @param {string} [opts.title='Confirmar acción'] - Título.
 * @param {string} opts.message - Mensaje de confirmación.
 * @param {string} [opts.confirmText='Confirmar'] - Texto del botón de confirmar.
 * @param {string} [opts.cancelText='Cancelar'] - Texto del botón de cancelar.
 * @param {('primary'|'danger')} [opts.variant='primary'] - Estilo del botón de confirmar.
 * @returns {Promise<boolean>} true si confirma, false si cancela.
 */
export function showConfirm({
  title = 'Confirmar acción',
  message,
  confirmText = 'Confirmar',
  cancelText = 'Cancelar',
  variant = 'primary',
} = {}) {
  return new Promise((resolve) => {
    const iconClass = variant === 'danger' ? 'bi-exclamation-triangle' : 'bi-question-circle';
    const { overlay, footer, close } = buildModal({ title, message, iconClass });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = cancelText;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = variant === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.textContent = confirmText;

    footer.append(cancelBtn, confirmBtn);

    const finish = (value) => {
      close();
      resolve(value);
    };

    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        finish(false);
      }
    });

    confirmBtn.focus();
  });
}

// ---------------------------------------------------------------------------
// showPrompt — modal con campo de texto
// ---------------------------------------------------------------------------

/**
 * Muestra un modal con un campo de texto. Reemplaza a window.prompt().
 *
 * @param {object} opts
 * @param {string} [opts.title='Editar'] - Título.
 * @param {string} [opts.message] - Mensaje descriptivo.
 * @param {string} [opts.defaultValue=''] - Valor inicial del campo.
 * @param {boolean} [opts.multiline=false] - Si true, usa textarea en lugar de input.
 * @param {string} [opts.confirmText='Guardar'] - Texto del botón de confirmar.
 * @param {string} [opts.cancelText='Cancelar'] - Texto del botón de cancelar.
 * @param {number} [opts.maxLength] - Longitud máxima opcional del campo.
 * @returns {Promise<string|null>} El texto ingresado, o null si se cancela.
 */
export function showPrompt({
  title = 'Editar',
  message,
  defaultValue = '',
  multiline = false,
  confirmText = 'Guardar',
  cancelText = 'Cancelar',
  maxLength,
} = {}) {
  return new Promise((resolve) => {
    const { overlay, body, footer, close } = buildModal({
      title,
      message,
      iconClass: 'bi-pencil-square',
    });

    // Campo de entrada (input o textarea).
    const field = document.createElement(multiline ? 'textarea' : 'input');
    field.className = 'form-control sys-modal__field';
    field.value = defaultValue;
    if (maxLength) field.maxLength = maxLength;
    if (multiline) field.rows = 4;
    else field.type = 'text';
    body.appendChild(field);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = cancelText;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn-primary';
    confirmBtn.textContent = confirmText;

    footer.append(cancelBtn, confirmBtn);

    const finish = (value) => {
      close();
      resolve(value);
    };

    cancelBtn.addEventListener('click', () => finish(null));
    confirmBtn.addEventListener('click', () => finish(field.value));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        finish(null);
      }
    });

    field.focus();
    field.select();
  });
}