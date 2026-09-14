/**
 * password-toggle.js
 * Utilidad de UI para mostrar/ocultar el contenido de un campo de contrasena.
 *
 * Agrega un boton con icono de ojo (Bootstrap Icons) dentro del campo, que
 * alterna el atributo `type` del input entre "password" y "text". Su unico
 * proposito es mejorar la retroalimentacion de la experiencia del usuario al
 * escribir su contrasena; no altera ninguna logica de negocio ni de seguridad.
 *
 * Consideraciones:
 *   - Accesibilidad: el boton expone aria-label y aria-pressed, y queda fuera
 *     del orden de tabulacion secundario mediante type="button" (no envia el
 *     formulario).
 *   - CSP: no usa scripts inline; se importa como modulo ES.
 *   - Idempotencia: si el campo ya tiene el control, no se duplica.
 */

/**
 * Envuelve un input de contrasena y le agrega el boton de mostrar/ocultar.
 *
 * @param {HTMLInputElement} input - Campo de contrasena a decorar.
 * @returns {void}
 */
export function attachPasswordToggle(input) {
  // Validaciones defensivas: debe ser un input de tipo password aun sin decorar.
  if (!input || input.tagName !== 'INPUT') return;
  if (input.type !== 'password') return;
  if (input.dataset.toggleAttached === 'true') return;

  // Marca el input para evitar una doble decoracion si se vuelve a invocar.
  input.dataset.toggleAttached = 'true';

  // Contenedor relativo que posiciona el boton sobre el borde derecho del input.
  const wrapper = document.createElement('div');
  wrapper.className = 'password-field';

  // Se inserta el wrapper en el lugar del input y se mueve el input dentro.
  const parent = input.parentNode;
  if (!parent) return;
  parent.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  // Se reserva espacio a la derecha para que el texto no quede bajo el boton.
  input.classList.add('password-field__input');

  // Boton de alternancia. type="button" evita que dispare el submit del form.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'password-field__toggle';
  button.setAttribute('aria-label', 'Mostrar contrasena');
  button.setAttribute('aria-pressed', 'false');
  button.tabIndex = -1;

  const icon = document.createElement('i');
  icon.className = 'bi bi-eye';
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  wrapper.appendChild(button);

  // Alterna la visibilidad del contenido del campo al hacer clic.
  button.addEventListener('click', () => {
    const willShow = input.type === 'password';
    input.type = willShow ? 'text' : 'password';
    icon.className = willShow ? 'bi bi-eye-slash' : 'bi bi-eye';
    button.setAttribute('aria-pressed', String(willShow));
    button.setAttribute(
      'aria-label',
      willShow ? 'Ocultar contrasena' : 'Mostrar contrasena',
    );
    // Se devuelve el foco al input para no interrumpir la escritura.
    input.focus();
  });
}

/**
 * Aplica el control de mostrar/ocultar a todos los inputs de contrasena que
 * existan dentro de un contenedor dado.
 *
 * @param {ParentNode} [root=document] - Ambito de busqueda de los campos.
 * @returns {void}
 */
export function attachPasswordToggles(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const inputs = root.querySelectorAll('input[type="password"]');
  inputs.forEach((input) => attachPasswordToggle(input));
}