/**
 * agent-panel.js
 * Orquestación del panel de Agente (pages/agent-panel.html).
 *
 * Responsabilidades:
 *   - Verificar la sesión y el rol con requireAuth(['Agent']) e iniciar el
 *     vigilante de inactividad (Requisito 5.x, control de UI).
 *   - Cargar la cola de tickets con getAllTickets() y mostrar los tickets
 *     asignados al Agent (agent_id === me) y los tickets sin asignar
 *     (agent_id === null), diferenciándolos visualmente (Requisitos 5.1, 5.2).
 *   - Abrir el detalle de un ticket, mostrar/ocultar el botón "ACEPTAR" según
 *     canAgentAccept() y el formulario de resolución cuando corresponda.
 *   - Conectar el botón "ACEPTAR" con acceptTicket() y refrescar la cola sin
 *     recargar la página (Requisitos 5.1, 5.2, 5.3).
 *   - Conectar el formulario de resolución con resolveTicket(), validando la
 *     longitud de la solución en el cliente antes de enviar (Requisitos 5.6,
 *     5.7). La notificación al User propietario (5.8) la genera el backend.
 *   - Inicializar el componente de notificaciones (campana, badge, dropdown) y
 *     el cierre de sesión.
 *
 * Nota de seguridad: todas las comprobaciones de este módulo son controles de
 * la interfaz. La autorización y validación autoritativa se realizan en el
 * backend (Edge Functions + Row Level Security). El módulo se carga como ES
 * Module porque la CSP del proyecto no permite scripts inline.
 *
 * Requisitos cubiertos: 5.1, 5.2, 5.3, 5.6, 5.7, 5.8
 */

import { supabase } from '../config.js';
import { requireAuth, initSessionWatcher } from '../auth/session.js';
import {
  getAllTickets,
  acceptTicket,
  resolveTicket,
  canAgentAccept,
} from '../modules/tickets.js';
import { initNotifications, loadUnreadNotifications } from '../modules/notifications.js';
import { validateSolution } from '../modules/validators.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Ruta absoluta de la pantalla de login para el cierre de sesión. */
const LOGIN_PATH = '../index.html';

/**
 * Estado (columna `estado`) en el que un ticket asignado al Agent puede
 * resolverse. El formulario de resolución solo se muestra cuando el ticket
 * está asignado a ese Agent y en este estado (Requisito 5.6).
 */
const ESTADO_EN_PROCESO = 'TICKET ACEPTADO';

/** Longitud mínima y máxima del comentario de solución (Requisitos 5.6, 5.7). */
const MIN_SOLUTION_LENGTH = 10;
const MAX_SOLUTION_LENGTH = 1000;

/** Placeholder para valores de texto ausentes en el detalle del ticket. */
const EMPTY_VALUE = '—';

// ---------------------------------------------------------------------------
// Estado del módulo
// ---------------------------------------------------------------------------

/** UUID del Agent autenticado; se establece en init(). */
let agentId = null;

/** Ticket actualmente mostrado en el modal de detalle. */
let selectedTicket = null;

/** Referencias a los nodos del DOM (se resuelven en init()). */
let agentNameEl;
let queueFeedbackEl;
let ticketsTbodyEl;
let ticketsEmptyEl;

// Modal de detalle.
let detailOverlayEl;
let detailCloseEl;
let detailTicketNumberEl;
let detailAreaEl;
let detailTipoAsistenciaEl;
let detailCategoriaEl;
let detailSubcategoriaEl;
let detailCreatorEl;
let detailAgentEl;
let detailStatusEl;
let detailEstadoEl;
let detailDescripcionEl;
let detailFeedbackEl;

// Acción ACEPTAR y formulario de resolución.
let acceptBtnEl;
let resolveFormEl;
let solucionTextareaEl;
let solucionCounterEl;
let solucionErrorEl;
let resolveBtnEl;

// Notificaciones y sesión.
let notificationsBellEl;
let notificationsDropdownEl;
let logoutBtnEl;

// ---------------------------------------------------------------------------
// Utilidades de UI
// ---------------------------------------------------------------------------

/**
 * Muestra un mensaje de feedback en un contenedor, aplicando la variante de
 * estilo indicada. Se usa textContent para evitar inyección de HTML (XSS).
 *
 * @param {HTMLElement} box - Contenedor de la alerta.
 * @param {string} message - Texto a mostrar.
 * @param {('success'|'danger'|'warning'|'info')} [variant='info'] - Variante visual.
 */
function showFeedback(box, message, variant = 'info') {
  if (!box) return;
  box.className = `alert alert-${variant}`;
  box.textContent = message;
  box.hidden = false;
}

/**
 * Oculta y limpia un contenedor de feedback.
 *
 * @param {HTMLElement} box - Contenedor de la alerta.
 */
function clearFeedback(box) {
  if (!box) return;
  box.textContent = '';
  box.hidden = true;
}

/**
 * Formatea una marca temporal ISO en una fecha legible para el usuario.
 *
 * @param {string} isoString - Fecha en formato ISO 8601.
 * @returns {string} Fecha localizada, o placeholder si no es parseable.
 */
function formatDate(isoString) {
  if (!isoString) return EMPTY_VALUE;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
  return date.toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Asigna texto plano a un nodo con un valor de respaldo cuando está vacío.
 *
 * @param {HTMLElement} el - Nodo destino.
 * @param {string} value - Valor a mostrar.
 */
function setText(el, value) {
  if (!el) return;
  el.textContent = value != null && value !== '' ? value : EMPTY_VALUE;
}

// ---------------------------------------------------------------------------
// Cola de tickets
// ---------------------------------------------------------------------------

/**
 * Carga la cola de tickets del Agent y la renderiza. Se muestran únicamente los
 * tickets asignados al Agent autenticado (agent_id === agentId) y los tickets
 * sin asignar (agent_id === null), en coherencia con lo que RLS permite ver
 * (Requisitos 5.1, 5.2).
 *
 * @returns {Promise<void>}
 */
async function loadQueue() {
  clearFeedback(queueFeedbackEl);

  const result = await getAllTickets();

  if (!result.ok) {
    // No se ocultan los errores: se informa al Agent para facilitar el reintento.
    showFeedback(queueFeedbackEl, result.error, 'danger');
    renderQueue([]);
    return;
  }

  // Filtro de conveniencia: tickets míos o sin asignar. RLS es la barrera real.
  const visibleTickets = result.data.filter((ticket) => {
    const assignedAgentId = ticket.agent_id ?? null;
    return assignedAgentId === agentId || assignedAgentId === null;
  });

  renderQueue(visibleTickets);
}

/**
 * Renderiza las filas de la tabla de tickets. Cada fila recibe la clase
 * .ticket-row--assigned o .ticket-row--unassigned y una .assignment-tag
 * (--mine / --free) para diferenciar visualmente la asignación.
 *
 * @param {object[]} tickets - Tickets visibles a renderizar.
 */
function renderQueue(tickets) {
  ticketsTbodyEl.replaceChildren();

  if (tickets.length === 0) {
    ticketsEmptyEl.hidden = false;
    return;
  }

  ticketsEmptyEl.hidden = true;

  const fragment = document.createDocumentFragment();
  for (const ticket of tickets) {
    fragment.appendChild(buildTicketRow(ticket));
  }
  ticketsTbodyEl.appendChild(fragment);
}

/**
 * Construye la fila (`<tr>`) de un ticket. Todos los textos se insertan con
 * textContent para evitar inyección de HTML (XSS).
 *
 * @param {object} ticket - Ticket a representar.
 * @returns {HTMLTableRowElement} Fila lista para insertar en el DOM.
 */
function buildTicketRow(ticket) {
  const isMine = (ticket.agent_id ?? null) === agentId;

  const row = document.createElement('tr');
  row.className = isMine ? 'ticket-row--assigned' : 'ticket-row--unassigned';
  row.dataset.ticketId = ticket.id;

  // --- Columna Ticket: número + etiqueta de asignación ---
  const numberCell = document.createElement('td');
  const numberText = document.createElement('span');
  numberText.textContent = ticket.ticket_number ?? EMPTY_VALUE;
  numberCell.appendChild(numberText);
  row.appendChild(numberCell);

  // --- Columna Asignación ---
  const assignmentCell = document.createElement('td');
  const tag = document.createElement('span');
  tag.className = `assignment-tag ${isMine ? 'assignment-tag--mine' : 'assignment-tag--free'}`;
  tag.textContent = isMine ? 'Asignado a mí' : 'Sin asignar';
  assignmentCell.appendChild(tag);
  row.appendChild(assignmentCell);

  // --- Columnas de datos ---
  appendTextCell(row, ticket.area);
  appendTextCell(row, ticket.categoria);
  appendTextCell(row, ticket.status);
  appendTextCell(row, ticket.estado);
  appendTextCell(row, formatDate(ticket.fecha_creacion));

  // --- Columna Acciones: abrir el detalle del ticket ---
  const actionsCell = document.createElement('td');
  actionsCell.className = 'ticket-actions';
  const detailBtn = document.createElement('button');
  detailBtn.type = 'button';
  detailBtn.className = 'btn btn-secondary btn-sm';
  detailBtn.textContent = 'Ver detalle';
  detailBtn.addEventListener('click', () => openTicketDetail(ticket));
  actionsCell.appendChild(detailBtn);
  row.appendChild(actionsCell);

  return row;
}

/**
 * Añade una celda de texto plano a una fila.
 *
 * @param {HTMLTableRowElement} row - Fila destino.
 * @param {string} value - Valor a mostrar.
 */
function appendTextCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value != null && value !== '' ? value : EMPTY_VALUE;
  row.appendChild(cell);
}

// ---------------------------------------------------------------------------
// Detalle del ticket
// ---------------------------------------------------------------------------

/**
 * Abre el modal de detalle del ticket, rellena sus campos y configura la
 * visibilidad del botón "ACEPTAR" (canAgentAccept) y del formulario de
 * resolución (solo si el ticket está asignado al Agent y en estado
 * "TICKET ACEPTADO").
 *
 * @param {object} ticket - Ticket seleccionado.
 */
function openTicketDetail(ticket) {
  selectedTicket = ticket;

  clearFeedback(detailFeedbackEl);
  clearSolutionError();

  // Datos del ticket (texto plano por seguridad).
  setText(detailTicketNumberEl, ticket.ticket_number);
  setText(detailAreaEl, ticket.area);
  setText(detailTipoAsistenciaEl, ticket.tipo_asistencia);
  setText(detailCategoriaEl, ticket.categoria);
  setText(detailSubcategoriaEl, ticket.subcategoria);
  setText(detailCreatorEl, ticket.creator?.full_name ?? ticket.creator?.email);
  setText(detailAgentEl, ticket.agent?.full_name ?? ticket.agent?.email);
  setText(detailStatusEl, ticket.status);
  setText(detailEstadoEl, ticket.estado);
  setText(detailDescripcionEl, ticket.descripcion);

  // Botón ACEPTAR: visible solo cuando la acción aplica (Requisito 5.3).
  acceptBtnEl.hidden = !canAgentAccept(ticket, agentId);
  acceptBtnEl.disabled = false;

  // Formulario de resolución: solo si el ticket es mío y está en proceso.
  const isMine = (ticket.agent_id ?? null) === agentId;
  const canResolve = isMine && ticket.estado === ESTADO_EN_PROCESO;
  resolveFormEl.hidden = !canResolve;
  if (canResolve) {
    resetResolveForm();
  }

  detailOverlayEl.hidden = false;
}

/**
 * Cierra el modal de detalle y limpia el estado asociado.
 */
function closeTicketDetail() {
  detailOverlayEl.hidden = true;
  selectedTicket = null;
  resolveFormEl.hidden = true;
  acceptBtnEl.hidden = true;
  clearFeedback(detailFeedbackEl);
}

// ---------------------------------------------------------------------------
// Acción ACEPTAR
// ---------------------------------------------------------------------------

/**
 * Maneja el clic en el botón "ACEPTAR": invoca acceptTicket() y, en caso de
 * éxito, refresca la cola sin recargar la página y cierra el detalle
 * (Requisitos 5.1, 5.2). Ante un error muestra el mensaje específico devuelto
 * por el módulo (por ejemplo, 403 cuando el ticket es de otro Agent).
 */
async function handleAccept() {
  if (!selectedTicket) return;

  clearFeedback(detailFeedbackEl);
  acceptBtnEl.disabled = true;

  try {
    const result = await acceptTicket(selectedTicket.id);

    if (result.ok) {
      // Se refresca la cola en segundo plano y se cierra el detalle.
      await loadQueue();
      closeTicketDetail();
      showFeedback(queueFeedbackEl, 'Ticket aceptado correctamente.', 'success');
      return;
    }

    showFeedback(detailFeedbackEl, result.error, 'danger');
  } finally {
    // Se rehabilita el botón solo si el detalle sigue abierto (hubo error).
    if (!detailOverlayEl.hidden) {
      acceptBtnEl.disabled = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Formulario de resolución
// ---------------------------------------------------------------------------

/**
 * Restablece el formulario de resolución: limpia el textarea, el error y
 * recalcula el contador de caracteres.
 */
function resetResolveForm() {
  solucionTextareaEl.value = '';
  clearSolutionError();
  updateSolutionCounter();
}

/**
 * Actualiza el contador de caracteres del textarea de solución y alterna la
 * clase --invalid cuando la longitud está fuera del rango permitido (10–1000).
 */
function updateSolutionCounter() {
  const length = solucionTextareaEl.value.length;
  solucionCounterEl.textContent = `${length} / ${MAX_SOLUTION_LENGTH}`;

  const isOutOfRange = length < MIN_SOLUTION_LENGTH || length > MAX_SOLUTION_LENGTH;
  solucionCounterEl.classList.toggle('resolve-form__counter--invalid', isOutOfRange);
}

/**
 * Muestra un mensaje de error en el campo de solución.
 *
 * @param {string} message - Texto del error.
 */
function showSolutionError(message) {
  if (!solucionErrorEl) return;
  solucionErrorEl.textContent = message;
  solucionErrorEl.hidden = false;
}

/**
 * Limpia el mensaje de error del campo de solución.
 */
function clearSolutionError() {
  if (!solucionErrorEl) return;
  solucionErrorEl.textContent = '';
  solucionErrorEl.hidden = true;
}

/**
 * Maneja el envío del formulario de resolución: valida la solución en el
 * cliente con validateSolution() antes de enviar (Requisitos 5.6, 5.7),
 * invoca resolveTicket() y, en caso de éxito, refresca la cola sin recargar la
 * página. La notificación al User propietario (Requisito 5.8) la genera el
 * backend al cambiar el estado del ticket.
 *
 * @param {SubmitEvent} event - Evento de envío del formulario.
 */
async function handleResolveSubmit(event) {
  event.preventDefault();

  if (!selectedTicket) return;

  clearSolutionError();
  clearFeedback(detailFeedbackEl);

  const solucion = solucionTextareaEl.value;

  // Validación previa en el cliente (retroalimentación inmediata).
  const validation = validateSolution(solucion);
  if (!validation.isValid) {
    showSolutionError(validation.error);
    return;
  }

  resolveBtnEl.disabled = true;

  try {
    const result = await resolveTicket(selectedTicket.id, solucion);

    if (result.ok) {
      await loadQueue();
      closeTicketDetail();
      showFeedback(queueFeedbackEl, 'Ticket resuelto correctamente.', 'success');
      return;
    }

    // Error del backend: se muestra en el feedback del detalle.
    showFeedback(detailFeedbackEl, result.error, 'danger');
  } finally {
    if (!detailOverlayEl.hidden) {
      resolveBtnEl.disabled = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Notificaciones y sesión
// ---------------------------------------------------------------------------

/**
 * Alterna la visibilidad del dropdown de notificaciones y sincroniza el
 * atributo aria-expanded de la campana para mantener la accesibilidad.
 */
function toggleNotifications() {
  const willOpen = notificationsDropdownEl.hidden;
  notificationsDropdownEl.hidden = !willOpen;
  notificationsBellEl.setAttribute('aria-expanded', String(willOpen));
}

/**
 * Cierra el dropdown de notificaciones cuando se hace clic fuera de él.
 *
 * @param {MouseEvent} event - Evento de clic del documento.
 */
function handleOutsideClick(event) {
  if (notificationsDropdownEl.hidden) return;
  const container = notificationsBellEl.closest('.notifications');
  if (container && !container.contains(event.target)) {
    notificationsDropdownEl.hidden = true;
    notificationsBellEl.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Cierra la sesión activa y redirige a la pantalla de login.
 */
async function handleLogout() {
  try {
    await supabase.auth.signOut();
  } catch (error) {
    // Aunque falle el signOut remoto, se redirige para no dejar al Agent en una
    // página protegida. Se registra el error para facilitar el diagnóstico.
    console.error('Error al cerrar la sesión:', error);
  }
  window.location.replace(LOGIN_PATH);
}

// ---------------------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------------------

/**
 * Resuelve las referencias del DOM utilizadas por el módulo.
 */
function resolveDomReferences() {
  agentNameEl = document.getElementById('agent-name');
  queueFeedbackEl = document.getElementById('queue-feedback');
  ticketsTbodyEl = document.getElementById('tickets-tbody');
  ticketsEmptyEl = document.getElementById('tickets-empty');

  detailOverlayEl = document.getElementById('ticket-detail-overlay');
  detailCloseEl = document.getElementById('ticket-detail-close');
  detailTicketNumberEl = document.getElementById('detail-ticket-number');
  detailAreaEl = document.getElementById('detail-area');
  detailTipoAsistenciaEl = document.getElementById('detail-tipo-asistencia');
  detailCategoriaEl = document.getElementById('detail-categoria');
  detailSubcategoriaEl = document.getElementById('detail-subcategoria');
  detailCreatorEl = document.getElementById('detail-creator');
  detailAgentEl = document.getElementById('detail-agent');
  detailStatusEl = document.getElementById('detail-status');
  detailEstadoEl = document.getElementById('detail-estado');
  detailDescripcionEl = document.getElementById('detail-descripcion');
  detailFeedbackEl = document.getElementById('detail-feedback');

  acceptBtnEl = document.getElementById('accept-btn');
  resolveFormEl = document.getElementById('resolve-form');
  solucionTextareaEl = document.getElementById('solucion-aplicada');
  solucionCounterEl = document.getElementById('solucion-counter');
  solucionErrorEl = document.getElementById('solucion-error');
  resolveBtnEl = document.getElementById('resolve-btn');

  notificationsBellEl = document.getElementById('notifications-bell');
  notificationsDropdownEl = document.getElementById('notifications-dropdown');
  logoutBtnEl = document.getElementById('logout-btn');
}

/**
 * Registra los manejadores de eventos de la interfaz.
 */
function registerEventListeners() {
  // Cierre del modal de detalle: botón de cierre y clic en el fondo del overlay.
  detailCloseEl.addEventListener('click', closeTicketDetail);
  detailOverlayEl.addEventListener('click', (event) => {
    if (event.target === detailOverlayEl) {
      closeTicketDetail();
    }
  });

  // Acción ACEPTAR.
  acceptBtnEl.addEventListener('click', handleAccept);

  // Formulario de resolución: contador en vivo y envío.
  solucionTextareaEl.addEventListener('input', updateSolutionCounter);
  resolveFormEl.addEventListener('submit', handleResolveSubmit);

  // Notificaciones: alternar dropdown y cierre al hacer clic fuera.
  notificationsBellEl.addEventListener('click', toggleNotifications);
  document.addEventListener('click', handleOutsideClick);

  // Cierre de sesión.
  logoutBtnEl.addEventListener('click', handleLogout);
}

/**
 * Inicializa el panel de Agente: verifica la sesión y el rol, resuelve el DOM,
 * registra los manejadores, arranca el vigilante de sesión, inicializa las
 * notificaciones y carga la cola de tickets.
 */
async function init() {
  // Verificación de sesión y rol. Si no es válida, requireAuth ya redirige.
  const auth = await requireAuth(['Agent']);
  if (!auth) return;

  agentId = auth.profile.id;

  resolveDomReferences();
  registerEventListeners();

  // Nombre del Agent en el encabezado (texto plano por seguridad).
  setText(agentNameEl, auth.profile.full_name ?? auth.profile.email);

  // Vigilante de inactividad (Requisito 10.8).
  initSessionWatcher();

  // Notificaciones en tiempo real y carga de las acumuladas no leídas.
  initNotifications(agentId);
  await loadUnreadNotifications(agentId);

  // Carga inicial de la cola de tickets.
  await loadQueue();
}

// Ejecuta la inicialización cuando el DOM está listo. El script es un módulo con
// defer implícito, pero se comprueba el estado por robustez.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
