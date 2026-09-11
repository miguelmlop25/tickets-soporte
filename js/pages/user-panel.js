/**
 * user-panel.js
 * Orquestación del panel de Usuario (pages/user-panel.html).
 *
 * Responsabilidades:
 *   - Verificar la sesión y el rol con requireAuth(['User']) antes de renderizar.
 *   - Cargar los tickets propios del usuario con getMyTickets() y renderizarlos.
 *   - Inicializar las notificaciones en tiempo real (initNotifications) y cargar
 *     las no leídas acumuladas (loadUnreadNotifications).
 *   - Iniciar la vigilancia de inactividad de la sesión (initSessionWatcher).
 *   - Conectar el formulario de Nuevo Ticket con createTicket(), mostrando los
 *     errores de validación por campo.
 *   - Conectar el formulario de filtros con getMyTickets(filters), mostrando un
 *     mensaje cuando no hay resultados.
 *   - Permitir la edición de tickets (estados Pendiente/En proceso) y la
 *     eliminación (solo estado Pendiente).
 *   - Utilidades de UI: navegación entre secciones, dropdown de notificaciones,
 *     contador de caracteres, poblado dinámico de subcategoría y agentes,
 *     detalle del ticket con su historial de cambios de estado, y logout.
 *
 * Nota de arquitectura: toda la lógica vive en este módulo porque la Content
 * Security Policy del proyecto no permite scripts inline (script-src 'self').
 * La seguridad real de los datos la garantiza Row Level Security en la base de
 * datos; las comprobaciones del cliente son de conveniencia.
 *
 * Nota de seguridad XSS: todo texto proveniente de la base de datos se inserta
 * en el DOM mediante `textContent` (nunca innerHTML), evitando la inyección de
 * marcado malicioso.
 *
 * Requisitos cubiertos: 4.1, 4.4, 7.6, 7.7
 */

import { supabase } from '../config.js';
import { requireAuth, initSessionWatcher } from '../auth/session.js';
import {
  createTicket,
  getMyTickets,
  updateTicket,
  deleteTicket,
} from '../modules/tickets.js';
import {
  initNotifications,
  loadUnreadNotifications,
} from '../modules/notifications.js';
import {
  validateTicketFields,
  SUBCATEGORIAS,
} from '../modules/validators.js';
// Diálogos del sistema (toast/confirm/prompt) que reemplazan a los nativos del
// navegador, con estética coherente al tema Liquid Glass.
import { showToast, showConfirm, showPrompt } from '../modules/ui-dialogs.js';

// ---------------------------------------------------------------------------
// Constantes del módulo
// ---------------------------------------------------------------------------

/** Rol autorizado para esta página. */
const ALLOWED_ROLES = ['User'];

/** Ruta de retorno al login tras cerrar sesión (absoluta desde la raíz). */
const LOGIN_PATH = '/index.html';

/** Longitud máxima de la descripción, alineada con el atributo maxlength del HTML. */
const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * Estados (Status) en los que un ticket es editable por el User (Requisito 7.6).
 * Coincide con USER_EDITABLE_STATUSES del módulo de tickets y con la RLS.
 */
const EDITABLE_STATUSES = ['Pendiente', 'En proceso'];

/** Estado (Status) en el que un ticket puede eliminarse por el User (Requisito 7.7). */
const DELETABLE_STATUS = 'Pendiente';

/**
 * Mapa de nombres de campo del formulario al id del elemento que muestra su
 * error de validación. Permite limpiar y pintar errores por campo de forma
 * homogénea.
 */
const FIELD_ERROR_IDS = {
  area: 'error-area',
  tipo_asistencia: 'error-tipo-asistencia',
  categoria: 'error-categoria',
  subcategoria: 'error-subcategoria',
  agente_asignado: 'error-agente',
  descripcion: 'error-descripcion',
};

// ---------------------------------------------------------------------------
// Estado interno del módulo
// ---------------------------------------------------------------------------

/** Perfil del usuario autenticado, obtenido en la inicialización. */
let currentProfile = null;

/**
 * Caché de los tickets actualmente renderizados, indexada por id. Permite
 * resolver los datos del ticket al abrir el detalle o editar sin volver a
 * consultar la base de datos.
 * @type {Map<string, object>}
 */
const ticketsById = new Map();

// Referencias a nodos del DOM (se resuelven en init()).
let ticketsTableBody;
let ticketsNoResults;
let filtersForm;
let newTicketForm;
let categoriaSelect;
let subcategoriaSelect;
let agenteSelect;
let descripcionTextarea;
let descripcionCounter;
let createTicketBtn;
let detailOverlay;
let detailBody;
let historyList;

// ===========================================================================
// Inicialización
// ===========================================================================

/**
 * Punto de entrada de la página. Verifica la sesión, resuelve referencias del
 * DOM, arranca los subsistemas (notificaciones, watcher de sesión) y conecta
 * los distintos manejadores de eventos de la interfaz.
 */
async function init() {
  // 1) Verificación de sesión y rol. Si no autoriza, requireAuth ya redirige.
  const auth = await requireAuth(ALLOWED_ROLES);
  if (!auth) {
    return;
  }
  currentProfile = auth.profile;

  // 2) Resolver referencias del DOM una sola vez.
  cacheDomReferences();

  // 3) Mostrar el nombre del usuario autenticado en el header.
  renderCurrentUserName();

  // 4) Conectar utilidades de interfaz (navegación, notificaciones, logout, etc.).
  setupNavigation();
  setupNotificationsDropdown();
  setupLogout();
  setupCharCounter();
  setupCategoriaSubcategoria();
  setupTicketDetailModal();
  setupFiltersForm();
  setupNewTicketForm();

  // 5) Poblar el selector de agentes asignables (consulta a profiles).
  await loadAgents();

  // 6) Arrancar notificaciones en tiempo real y cargar las no leídas.
  const userId = auth.session.user.id;
  initNotifications(userId);
  await loadUnreadNotifications(userId);

  // 7) Iniciar la vigilancia de inactividad de la sesión (Requisito 10.8).
  initSessionWatcher();

  // 8) Carga inicial de los tickets del usuario (sin filtros).
  await refreshTickets();
}

/**
 * Resuelve y almacena las referencias a los nodos del DOM utilizados por el
 * módulo. Centralizar esta resolución evita repetir document.getElementById.
 */
function cacheDomReferences() {
  ticketsTableBody = document.getElementById('tickets-table-body');
  ticketsNoResults = document.getElementById('tickets-no-results');
  filtersForm = document.getElementById('ticket-filters');
  newTicketForm = document.getElementById('new-ticket-form');
  categoriaSelect = document.getElementById('ticket-categoria');
  subcategoriaSelect = document.getElementById('ticket-subcategoria');
  agenteSelect = document.getElementById('ticket-agente');
  descripcionTextarea = document.getElementById('ticket-descripcion');
  descripcionCounter = document.getElementById('descripcion-counter');
  createTicketBtn = document.getElementById('create-ticket-btn');
  detailOverlay = document.getElementById('ticket-detail-overlay');
  detailBody = document.getElementById('ticket-detail-body');
  historyList = document.getElementById('ticket-history-list');
}

/** Muestra el nombre del usuario autenticado en el header. */
function renderCurrentUserName() {
  const nameEl = document.getElementById('current-user-name');
  if (nameEl && currentProfile) {
    nameEl.textContent = currentProfile.full_name || currentProfile.email || '';
  }
}

// ===========================================================================
// Navegación entre secciones
// ===========================================================================

/**
 * Configura la navegación lateral. Cada botón con [data-section] alterna la
 * visibilidad de la sección correspondiente y actualiza el estado activo.
 */
function setupNavigation() {
  const navItems = document.querySelectorAll('.dashboard__nav-item[data-section]');

  navItems.forEach((navItem) => {
    navItem.addEventListener('click', () => {
      const targetId = navItem.dataset.section;

      // Alternar visibilidad de todas las secciones del main.
      document.querySelectorAll('.dashboard__section').forEach((section) => {
        section.hidden = section.id !== targetId;
      });

      // Actualizar el estado activo y accesible de los botones de navegación.
      navItems.forEach((item) => {
        const isActive = item === navItem;
        item.classList.toggle('dashboard__nav-item--active', isActive);
        if (isActive) {
          item.setAttribute('aria-current', 'page');
        } else {
          item.removeAttribute('aria-current');
        }
      });
    });
  });
}

// ===========================================================================
// Dropdown de notificaciones
// ===========================================================================

/**
 * Configura la apertura/cierre del dropdown de notificaciones al hacer clic en
 * la campana, y su cierre al hacer clic fuera del componente.
 */
function setupNotificationsDropdown() {
  const bell = document.getElementById('notifications-bell');
  const dropdown = document.getElementById('notifications-dropdown');
  if (!bell || !dropdown) {
    return;
  }

  bell.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = dropdown.hidden;
    dropdown.hidden = !willOpen;
    bell.setAttribute('aria-expanded', String(willOpen));
  });

  // Cerrar el dropdown al hacer clic fuera del componente de notificaciones.
  document.addEventListener('click', (event) => {
    if (dropdown.hidden) {
      return;
    }
    const notifications = bell.closest('.notifications');
    if (notifications && !notifications.contains(event.target)) {
      dropdown.hidden = true;
      bell.setAttribute('aria-expanded', 'false');
    }
  });
}

// ===========================================================================
// Logout
// ===========================================================================

/** Conecta el botón de cierre de sesión con Supabase Auth. */
function setupLogout() {
  const logoutBtn = document.getElementById('logout-btn');
  if (!logoutBtn) {
    return;
  }

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await supabase.auth.signOut();
    } catch (error) {
      // Aunque falle el signOut remoto, se redirige para no dejar al usuario
      // en una página protegida.
      console.error('[user-panel] Error al cerrar sesión:', error);
    }
    window.location.replace(LOGIN_PATH);
  });
}

// ===========================================================================
// Contador de caracteres de la descripción
// ===========================================================================

/** Actualiza el contador de caracteres de la descripción en cada entrada. */
function setupCharCounter() {
  if (!descripcionTextarea || !descripcionCounter) {
    return;
  }

  const updateCounter = () => {
    const length = descripcionTextarea.value.length;
    descripcionCounter.textContent = `${length} / ${MAX_DESCRIPTION_LENGTH}`;
  };

  descripcionTextarea.addEventListener('input', updateCounter);
  updateCounter();
}

// ===========================================================================
// Poblado dinámico de subcategoría según la categoría
// ===========================================================================

/**
 * Conecta el select de Categoría con el de Subcategoría. Al cambiar la
 * categoría se repuebla la subcategoría con las opciones del mapa SUBCATEGORIAS
 * y se habilita/deshabilita el control según corresponda.
 */
function setupCategoriaSubcategoria() {
  if (!categoriaSelect || !subcategoriaSelect) {
    return;
  }

  categoriaSelect.addEventListener('change', () => {
    populateSubcategorias(categoriaSelect.value);
  });
}

/**
 * Rellena el select de subcategoría con las opciones correspondientes a la
 * categoría dada. Si no hay categoría válida, deja el select deshabilitado con
 * una opción de aviso.
 *
 * @param {string} categoria - Categoría seleccionada.
 */
function populateSubcategorias(categoria) {
  // Limpiar las opciones actuales de forma segura.
  subcategoriaSelect.replaceChildren();

  const options = SUBCATEGORIAS[categoria];

  if (!options) {
    // Sin categoría válida: deshabilitar y mostrar aviso.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Seleccione primero una categoría';
    subcategoriaSelect.appendChild(placeholder);
    subcategoriaSelect.disabled = true;
    return;
  }

  // Opción inicial vacía para forzar una selección explícita.
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Seleccione una subcategoría';
  subcategoriaSelect.appendChild(placeholder);

  // Poblar con las subcategorías de la categoría elegida.
  for (const sub of options) {
    const option = document.createElement('option');
    option.value = sub;
    option.textContent = sub;
    subcategoriaSelect.appendChild(option);
  }

  subcategoriaSelect.disabled = false;
}

// ===========================================================================
// Poblado del selector de agentes
// ===========================================================================

/**
 * Consulta los perfiles con rol Agent y puebla el select de "Agente asignado".
 * El agente es obligatorio al crear un ticket:
 *   - Si existe mas de un agente, se muestra un placeholder "Seleccione un
 *     agente" que obliga a elegir uno.
 *   - Si existe exactamente un agente, se selecciona por defecto y se retira el
 *     placeholder para agilizar la creacion del ticket.
 *   - Si no existe ningun agente, se informa mediante un placeholder.
 */
async function loadAgents() {
  if (!agenteSelect) {
    return;
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'Agent')
    .order('full_name', { ascending: true });

  if (error) {
    // Se informa para diagnostico. El placeholder permanece y la validacion del
    // formulario impedira crear el ticket sin un agente valido.
    console.error('[user-panel] Error al cargar agentes:', error.message);
    return;
  }

  const agents = Array.isArray(data) ? data : [];

  // Poblar las opciones de agentes tras el placeholder ya presente en el HTML.
  for (const agent of agents) {
    const option = document.createElement('option');
    option.value = agent.id;
    // textContent evita inyeccion de HTML a partir del nombre almacenado.
    option.textContent = agent.full_name || 'Agente sin nombre';
    agenteSelect.appendChild(option);
  }

  // Si solo hay un agente, seleccionarlo por defecto y retirar el placeholder
  // para que quede elegido automaticamente.
  if (agents.length === 1) {
    const placeholder = agenteSelect.querySelector('option[value=""]');
    if (placeholder) {
      placeholder.remove();
    }
    agenteSelect.value = agents[0].id;
  }
}

// ===========================================================================
// Filtros de tickets
// ===========================================================================

/**
 * Conecta el formulario de filtros. Al enviar, recarga los tickets aplicando
 * los filtros; al limpiar, recarga sin filtros.
 */
function setupFiltersForm() {
  if (!filtersForm) {
    return;
  }

  filtersForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await refreshTickets(readFilters());
  });

  filtersForm.addEventListener('reset', () => {
    // El reset limpia los campos de forma nativa; se recargan sin filtros tras
    // permitir que el navegador aplique el reset (siguiente tick).
    setTimeout(() => refreshTickets(), 0);
  });
}

/**
 * Lee los valores actuales del formulario de filtros y construye el objeto de
 * filtros esperado por getMyTickets. Se omiten los campos vacíos.
 *
 * @returns {object} Filtros activos.
 */
function readFilters() {
  const filters = {};
  const data = new FormData(filtersForm);

  const status = data.get('status');
  const estado = data.get('estado');
  const categoria = data.get('categoria');
  const fechaDesde = data.get('fecha_desde');
  const fechaHasta = data.get('fecha_hasta');

  if (status) filters.status = status;
  if (estado) filters.estado = estado;
  if (categoria) filters.categoria = categoria;
  if (fechaDesde) filters.fecha_desde = fechaDesde;
  if (fechaHasta) filters.fecha_hasta = fechaHasta;

  return filters;
}

// ===========================================================================
// Carga y renderizado de la tabla de tickets
// ===========================================================================

/**
 * Consulta los tickets del usuario (con filtros opcionales) y actualiza la
 * tabla y el mensaje de "sin resultados".
 *
 * @param {object} [filters] - Filtros opcionales para getMyTickets.
 */
async function refreshTickets(filters) {
  const result = await getMyTickets(filters);

  if (!result.ok) {
    // Se informa el error reutilizando el área de "sin resultados" con el
    // mensaje devuelto por el módulo.
    renderTickets([]);
    if (ticketsNoResults) {
      ticketsNoResults.textContent = result.error;
      ticketsNoResults.hidden = false;
    }
    return;
  }

  renderTickets(result.data);
}

/**
 * Renderiza la lista de tickets en la tabla. Actualiza la caché por id y
 * gestiona la visibilidad del mensaje de "sin resultados" (Requisito 4.4).
 *
 * @param {object[]} tickets - Tickets a renderizar.
 */
function renderTickets(tickets) {
  ticketsById.clear();
  ticketsTableBody.replaceChildren();

  if (!tickets || tickets.length === 0) {
    if (ticketsNoResults) {
      ticketsNoResults.textContent =
        'No se encontraron tickets que coincidan con los filtros aplicados.';
      ticketsNoResults.hidden = false;
    }
    return;
  }

  if (ticketsNoResults) {
    ticketsNoResults.hidden = true;
  }

  const fragment = document.createDocumentFragment();
  for (const ticket of tickets) {
    ticketsById.set(ticket.id, ticket);
    fragment.appendChild(buildTicketRow(ticket));
  }
  ticketsTableBody.appendChild(fragment);
}

/**
 * Construye la fila (`<tr>`) de un ticket con sus celdas y botones de acción.
 * Todo el texto se inserta con textContent para prevenir XSS.
 *
 * @param {object} ticket - Ticket a representar.
 * @returns {HTMLTableRowElement} Fila lista para insertar.
 */
function buildTicketRow(ticket) {
  const row = document.createElement('tr');
  row.dataset.ticketId = ticket.id;

  // Celdas de datos en el orden de las columnas del HTML.
  appendTextCell(row, ticket.ticket_number || '');
  appendTextCell(row, ticket.area || '');
  appendTextCell(row, ticket.categoria || '');

  // Celda de Status con badge visual.
  const statusCell = document.createElement('td');
  statusCell.appendChild(buildStatusBadge(ticket.status));
  row.appendChild(statusCell);

  appendTextCell(row, ticket.estado || '');
  appendTextCell(row, formatDate(ticket.fecha_creacion));

  // Celda de acciones: Ver detalle, Editar (condicional), Eliminar (condicional).
  const actionsCell = document.createElement('td');
  actionsCell.className = 'data-table__actions';

  const detailBtn = buildActionButton('Ver detalle', 'btn-secondary', () =>
    openTicketDetail(ticket.id),
  );
  actionsCell.appendChild(detailBtn);

  // Editar: solo en estados Pendiente/En proceso (Requisito 7.6).
  if (EDITABLE_STATUSES.includes(ticket.status)) {
    const editBtn = buildActionButton('Editar', 'btn-secondary', () =>
      handleEditTicket(ticket.id),
    );
    actionsCell.appendChild(editBtn);
  }

  // Eliminar: solo en estado Pendiente (Requisito 7.7).
  if (ticket.status === DELETABLE_STATUS) {
    const deleteBtn = buildActionButton('Eliminar', 'btn-danger', () =>
      handleDeleteTicket(ticket.id),
    );
    actionsCell.appendChild(deleteBtn);
  }

  row.appendChild(actionsCell);
  return row;
}

/**
 * Crea una celda de tabla con texto plano.
 *
 * @param {HTMLTableRowElement} row - Fila a la que se añade la celda.
 * @param {string} text - Texto de la celda.
 */
function appendTextCell(row, text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  row.appendChild(cell);
}

/**
 * Construye un badge visual para el Status del ticket. La clase modificadora
 * se deriva del status normalizado para permitir estilos por estado.
 *
 * @param {string} status - Status del ticket.
 * @returns {HTMLSpanElement} Badge listo para insertar.
 */
function buildStatusBadge(status) {
  const badge = document.createElement('span');
  const normalized = String(status || '')
    .toLowerCase()
    .replace(/\s+/g, '-');
  badge.className = `badge badge--${normalized}`;
  badge.textContent = status || '';
  return badge;
}

/**
 * Crea un botón de acción para la tabla.
 *
 * @param {string} label - Texto del botón.
 * @param {string} variantClass - Clase de variante (btn-secondary, btn-danger...).
 * @param {Function} onClick - Manejador del clic.
 * @returns {HTMLButtonElement} Botón listo para insertar.
 */
function buildActionButton(label, variantClass, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${variantClass} btn-sm`;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// ===========================================================================
// Formulario de Nuevo Ticket
// ===========================================================================

/**
 * Conecta el formulario de creación de ticket con createTicket(). Valida los
 * campos en el cliente, muestra errores por campo y, en caso de éxito, limpia
 * el formulario, refresca la tabla y navega a la sección de tickets.
 */
function setupNewTicketForm() {
  if (!newTicketForm) {
    return;
  }

  newTicketForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors();

    const formData = new FormData(newTicketForm);
    const agenteSeleccionado = formData.get('agente_asignado') || '';
    const ticketData = {
      area: formData.get('area') || '',
      tipo_asistencia: formData.get('tipo_asistencia') || '',
      categoria: formData.get('categoria') || '',
      subcategoria: formData.get('subcategoria') || '',
      descripcion: formData.get('descripcion') || '',
      agente_asignado: agenteSeleccionado || null,
    };

    // Validación en el cliente para retroalimentación inmediata por campo.
    const validation = validateTicketFields(ticketData);

    // El agente asignado es obligatorio en el panel de Usuario. Se valida aqui
    // (no en validateTicketFields, que lo trata como opcional para otras vistas).
    if (!agenteSeleccionado) {
      validation.errors.agente_asignado = 'Debe seleccionar un agente asignado.';
      validation.isValid = false;
    }

    if (!validation.isValid) {
      showFieldErrors(validation.errors);
      return;
    }

    // Envío al backend (Edge Function create-ticket) con los datos sanitizados.
    createTicketBtn.disabled = true;
    const result = await createTicket(validation.sanitized);
    createTicketBtn.disabled = false;

    if (!result.ok) {
      // Error de negocio/servidor: se muestra en el campo de descripción como
      // ubicación visible, ya que el backend puede devolver un mensaje general.
      showFieldErrors({ descripcion: result.error });
      return;
    }

    // Éxito: limpiar el formulario, restablecer subcategoría y contador.
    newTicketForm.reset();
    populateSubcategorias('');
    if (descripcionCounter) {
      descripcionCounter.textContent = `0 / ${MAX_DESCRIPTION_LENGTH}`;
    }

    // Refrescar la tabla y navegar a "Mis Tickets".
    await refreshTickets();
    document.getElementById('nav-my-tickets')?.click();
  });
}

/**
 * Muestra los mensajes de error de validación en el elemento correspondiente a
 * cada campo.
 *
 * @param {Object<string,string>} errors - Mapa campo → mensaje de error.
 */
function showFieldErrors(errors) {
  for (const [field, message] of Object.entries(errors)) {
    const errorId = FIELD_ERROR_IDS[field];
    if (!errorId) {
      continue;
    }
    const errorEl = document.getElementById(errorId);
    if (errorEl) {
      errorEl.textContent = message;
    }
  }
}

/** Limpia todos los mensajes de error de validación del formulario de ticket. */
function clearFieldErrors() {
  for (const errorId of Object.values(FIELD_ERROR_IDS)) {
    const errorEl = document.getElementById(errorId);
    if (errorEl) {
      errorEl.textContent = '';
    }
  }
}

// ===========================================================================
// Edición de tickets
// ===========================================================================

/**
 * Maneja la edición de un ticket en estado editable. Solicita la nueva
 * descripción al usuario (edición mínima permitida en el cliente) y persiste el
 * cambio con updateTicket. La barrera autoritativa es la RLS del backend.
 *
 * @param {string} ticketId - Id del ticket a editar.
 */
async function handleEditTicket(ticketId) {
  const ticket = ticketsById.get(ticketId);
  if (!ticket) {
    return;
  }

  // Comprobación de conveniencia del estado editable (Requisito 7.6).
  if (!EDITABLE_STATUSES.includes(ticket.status)) {
    showToast('Solo es posible editar tickets en estado Pendiente o En proceso.', 'warning');
    return;
  }

  // Edición de la descripción mediante el modal del sistema (reemplaza al
  // prompt nativo). Se preselecciona el valor actual.
  const nuevaDescripcion = await showPrompt({
    title: 'Editar ticket',
    message: 'Edite la descripción del problema',
    defaultValue: ticket.descripcion || '',
    multiline: true,
    maxLength: 1000,
    confirmText: 'Guardar',
  });

  // El usuario canceló el prompt (showPrompt devuelve null al cancelar).
  if (nuevaDescripcion === null) {
    return;
  }

  const result = await updateTicket(ticketId, { descripcion: nuevaDescripcion });

  if (!result.ok) {
    showToast(result.error, 'danger');
    return;
  }

  // Refrescar la tabla para reflejar el cambio.
  await refreshTickets(readFilters());
}

// ===========================================================================
// Eliminación de tickets
// ===========================================================================

/**
 * Maneja la eliminación de un ticket en estado Pendiente, previa confirmación
 * del usuario (Requisito 7.7).
 *
 * @param {string} ticketId - Id del ticket a eliminar.
 */
async function handleDeleteTicket(ticketId) {
  const ticket = ticketsById.get(ticketId);
  if (!ticket) {
    return;
  }

  // Comprobación de conveniencia del estado eliminable (Requisito 7.7).
  if (ticket.status !== DELETABLE_STATUS) {
    showToast('Solo es posible eliminar tickets en estado Pendiente.', 'warning');
    return;
  }

  // Confirmación mediante el modal del sistema (reemplaza al confirm nativo).
  const confirmed = await showConfirm({
    title: 'Eliminar ticket',
    message:
      `¿Está seguro de eliminar el ticket ${ticket.ticket_number || ''}? ` +
      'Esta acción no se puede deshacer.',
    confirmText: 'Eliminar',
    variant: 'danger',
  });
  if (!confirmed) {
    return;
  }

  const result = await deleteTicket(ticketId, 'User');

  if (!result.ok) {
    showToast(result.error, 'danger');
    return;
  }

  // Refrescar la tabla para reflejar la eliminación.
  await refreshTickets(readFilters());
}

// ===========================================================================
// Detalle del ticket + historial
// ===========================================================================

/**
 * Configura el cierre del modal de detalle del ticket (botón de cierre y clic
 * en el fondo del overlay).
 */
function setupTicketDetailModal() {
  const closeBtn = document.getElementById('ticket-detail-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeTicketDetail);
  }

  if (detailOverlay) {
    // Cerrar al hacer clic en el fondo del overlay (no en el contenido del modal).
    detailOverlay.addEventListener('click', (event) => {
      if (event.target === detailOverlay) {
        closeTicketDetail();
      }
    });
  }
}

/**
 * Abre el modal de detalle de un ticket, renderiza sus datos generales y carga
 * su historial de cambios de estado desde la tabla ticket_history.
 *
 * @param {string} ticketId - Id del ticket.
 */
async function openTicketDetail(ticketId) {
  const ticket = ticketsById.get(ticketId);
  if (!ticket || !detailBody) {
    return;
  }

  renderTicketDetailBody(ticket);
  await loadTicketHistory(ticketId);

  if (detailOverlay) {
    detailOverlay.hidden = false;
  }
}

/** Cierra el modal de detalle del ticket. */
function closeTicketDetail() {
  if (detailOverlay) {
    detailOverlay.hidden = true;
  }
}

/**
 * Renderiza los datos generales del ticket en el cuerpo del modal usando una
 * lista de definición. Todo el texto se inserta con textContent (anti-XSS).
 *
 * @param {object} ticket - Ticket a mostrar.
 */
function renderTicketDetailBody(ticket) {
  detailBody.replaceChildren();

  const fields = [
    ['Número', ticket.ticket_number],
    ['Área', ticket.area],
    ['Tipo de asistencia', ticket.tipo_asistencia],
    ['Categoría', ticket.categoria],
    ['Subcategoría', ticket.subcategoria],
    ['Status', ticket.status],
    ['Estado', ticket.estado],
    ['Fecha de creación', formatDate(ticket.fecha_creacion)],
    ['Descripción', ticket.descripcion],
  ];

  const dl = document.createElement('dl');
  dl.className = 'ticket-detail__fields';

  for (const [label, value] of fields) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value != null && value !== '' ? String(value) : '—';
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  detailBody.appendChild(dl);
}

/**
 * Carga el historial de cambios de estado del ticket desde ticket_history,
 * incluyendo el rol del actor mediante un join a profiles, y lo renderiza.
 *
 * @param {string} ticketId - Id del ticket.
 */
async function loadTicketHistory(ticketId) {
  if (!historyList) {
    return;
  }

  historyList.replaceChildren();

  const { data, error } = await supabase
    .from('ticket_history')
    .select('id, estado_anterior, estado_nuevo, created_at, actor:profiles ( role )')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[user-panel] Error al cargar el historial del ticket:', error.message);
    const errorItem = document.createElement('p');
    errorItem.className = 'ticket-history__error';
    errorItem.textContent = 'No fue posible cargar el historial de cambios.';
    historyList.appendChild(errorItem);
    return;
  }

  const entries = Array.isArray(data) ? data : [];

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ticket-history__empty';
    empty.textContent = 'Sin cambios de estado registrados.';
    historyList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    fragment.appendChild(buildHistoryItem(entry));
  }
  historyList.appendChild(fragment);
}

/**
 * Construye un elemento del historial de cambios de estado. Muestra la
 * transición, la fecha/hora y el rol del actor. Texto insertado con textContent.
 *
 * @param {object} entry - Registro de ticket_history.
 * @returns {HTMLDivElement} Elemento del historial.
 */
function buildHistoryItem(entry) {
  const item = document.createElement('div');
  item.className = 'ticket-history__item';

  // Transición de estado (anterior → nuevo). El estado anterior puede ser nulo
  // en la creación del ticket.
  const transition = document.createElement('p');
  transition.className = 'ticket-history__transition';
  const previous = entry.estado_anterior ? `${entry.estado_anterior} → ` : '';
  transition.textContent = `${previous}${entry.estado_nuevo || ''}`;
  item.appendChild(transition);

  // Metadatos: fecha/hora y rol del actor.
  const meta = document.createElement('p');
  meta.className = 'ticket-history__meta';
  const role = entry.actor && entry.actor.role ? entry.actor.role : 'Sistema';
  meta.textContent = `${formatDateTime(entry.created_at)} · ${role}`;
  item.appendChild(meta);

  return item;
}

// ===========================================================================
// Utilidades de formato
// ===========================================================================

/**
 * Formatea una fecha ISO a formato corto local (dd/mm/aaaa).
 *
 * @param {string} isoString - Fecha en formato ISO 8601.
 * @returns {string} Fecha formateada o cadena vacía si no es válida.
 */
function formatDate(isoString) {
  if (!isoString) {
    return '';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Formatea una fecha ISO a fecha y hora local legible.
 *
 * @param {string} isoString - Fecha en formato ISO 8601.
 * @returns {string} Fecha y hora formateadas o cadena vacía si no es válida.
 */
function formatDateTime(isoString) {
  if (!isoString) {
    return '';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ===========================================================================
// Arranque
// ===========================================================================

// Se inicializa cuando el DOM está listo. El script se carga como módulo con
// `defer` implícito, por lo que el DOM suele estar disponible; se comprueba el
// estado por robustez.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
