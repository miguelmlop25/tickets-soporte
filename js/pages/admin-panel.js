/**
 * admin-panel.js
 * Orquestación del Panel de Administrador (pages/admin-panel.html).
 *
 * Responsabilidades:
 *   - Proteger la página verificando sesión y rol Admin con requireAuth(['Admin'])
 *     e iniciar el vigilante de inactividad (initSessionWatcher).
 *   - Gestionar la navegación entre secciones (Dashboard, Todos los Tickets,
 *     Bitácora de Incidentes, Gestión de Usuarios) mostrando/ocultando cada
 *     sección con el atributo [hidden] y marcando el enlace activo.
 *   - Inicializar y conectar cada módulo de dominio con su sección:
 *       · Dashboard: startDashboardAutoRefresh + selector de rango de fechas.
 *       · Todos los Tickets: getAllTickets con los filtros del formulario.
 *       · Bitácora: loadBitacora + exportBitacoraToPDF.
 *       · Gestión de Usuarios: listUsers (que ya cablea block/unblock/delete).
 *   - Inicializar notificaciones en tiempo real y el cierre de sesión.
 *
 * Notas de arquitectura y seguridad:
 *   - La seguridad autoritativa la garantizan las políticas RLS y las Edge
 *     Functions del backend. Las comprobaciones de esta página son controles
 *     de interfaz para mejorar la experiencia, nunca sustituyen al backend.
 *   - Todo el contenido dinámico se inserta con textContent (nunca innerHTML)
 *     para evitar inyección de HTML/XSS. Los módulos de render reutilizados
 *     (dashboard, user-management) siguen la misma convención.
 *   - No se usan scripts inline por la Content Security Policy del proyecto;
 *     este archivo se carga como módulo ES desde el HTML.
 *
 * Requisitos cubiertos: 2.9, 4.7, 4.8, 7.1, 7.3, 7.4
 */

import { requireAuth, initSessionWatcher } from '../auth/session.js';
import {
  startDashboardAutoRefresh,
  validateDateRange,
} from '../modules/dashboard.js';
import {
  loadBitacora,
  exportBitacoraToPDF,
  buildBitacoraRows,
} from '../modules/bitacora.js';
import { listUsers } from '../modules/user-management.js';
import { getAllTickets } from '../modules/tickets.js';
import {
  initNotifications,
  loadUnreadNotifications,
} from '../modules/notifications.js';
import { supabase } from '../config.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Ruta absoluta de la pantalla de login para el cierre de sesión. */
const LOGIN_PATH = '/index.html';

/**
 * Mapa de identificador de sección (data-section) al id del elemento <section>
 * correspondiente en el HTML. Se usa para alternar la visibilidad.
 */
const SECTION_IDS = {
  dashboard: 'section-dashboard',
  tickets: 'section-tickets',
  bitacora: 'section-bitacora',
  usuarios: 'section-usuarios',
};

/**
 * Mapa de status de ticket a la clase modificadora del badge de estado,
 * reutilizando las convenciones de estilo del proyecto.
 */
const STATUS_BADGE_MODIFIER = {
  Pendiente: 'status-badge--pendiente',
  'En proceso': 'status-badge--en-proceso',
  Finalizado: 'status-badge--finalizado',
};

// ---------------------------------------------------------------------------
// Estado interno del módulo
// ---------------------------------------------------------------------------

/**
 * Filas crudas de la bitácora actualmente cargadas en pantalla. Se conservan
 * para exportarlas a PDF con exactamente los mismos datos visibles, sin
 * volver a consultar la base de datos (Requisito 4.7).
 * @type {object[]}
 */
let currentBitacoraRows = [];

/**
 * Controlador de la auto-actualización del Dashboard devuelto por
 * startDashboardAutoRefresh. Permite forzar un refresco manual (refresh) o
 * detener el intervalo (stop).
 * @type {{ stop: () => void, refresh: () => Promise<object|null> } | null}
 */
let dashboardController = null;

// ---------------------------------------------------------------------------
// Utilidades de DOM
// ---------------------------------------------------------------------------

/**
 * Muestra u oculta un mensaje de error en un elemento contenedor. Nunca oculta
 * errores silenciosamente: si el elemento no existe, registra en consola.
 *
 * @param {HTMLElement|null} element - Contenedor del mensaje (p. ej. .form-error).
 * @param {string|null} message - Mensaje a mostrar; null/'' oculta el elemento.
 */
function setErrorMessage(element, message) {
  if (!element) {
    if (message) console.error('[admin-panel]', message);
    return;
  }
  if (message) {
    element.textContent = message;
    element.hidden = false;
  } else {
    element.textContent = '';
    element.hidden = true;
  }
}

/**
 * Crea una celda de tabla (<td>) con texto seguro mediante textContent para
 * evitar inyección de HTML/XSS.
 *
 * @param {string} text - Texto a insertar.
 * @param {string} [className] - Clase CSS opcional.
 * @returns {HTMLTableCellElement}
 */
function createTextCell(text, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text ?? '';
  return cell;
}

// ---------------------------------------------------------------------------
// Navegación entre secciones
// ---------------------------------------------------------------------------

/**
 * Alterna la sección visible del panel. Oculta todas las secciones con el
 * atributo [hidden] y muestra únicamente la seleccionada; además marca el
 * enlace de navegación activo con la clase modificadora --active.
 *
 * @param {string} sectionKey - Clave de sección (dashboard|tickets|bitacora|usuarios).
 */
function showSection(sectionKey) {
  // Alternar visibilidad de cada sección.
  for (const [key, elementId] of Object.entries(SECTION_IDS)) {
    const section = document.getElementById(elementId);
    if (section) {
      section.hidden = key !== sectionKey;
    }
  }

  // Marcar el enlace de navegación activo.
  const navItems = document.querySelectorAll('.dashboard__nav-item[data-section]');
  navItems.forEach((item) => {
    const isActive = item.dataset.section === sectionKey;
    item.classList.toggle('dashboard__nav-item--active', isActive);
    if (isActive) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

/**
 * Conecta los enlaces de la barra lateral con el cambio de sección. Previene la
 * navegación por defecto del ancla para gestionar la vista sin recargar.
 */
function initNavigation() {
  const navItems = document.querySelectorAll('.dashboard__nav-item[data-section]');
  navItems.forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      showSection(item.dataset.section);
    });
  });
}

// ---------------------------------------------------------------------------
// Sección Dashboard
// ---------------------------------------------------------------------------

/**
 * Inicializa el Dashboard: conecta el selector de rango de fechas y arranca la
 * auto-actualización de métricas. El proveedor getDateRange lee los inputs de
 * fecha en cada ciclo, de modo que el rango vigente siempre se respeta durante
 * los refrescos automáticos (Requisitos 7.1, 7.3).
 */
function initDashboardSection() {
  const cardsContainer = document.getElementById('metrics-grid');
  const chartContainer = document.getElementById('chart-canvas');
  const dateForm = document.getElementById('dashboard-date-range');
  const fromInput = document.getElementById('dashboard-date-from');
  const toInput = document.getElementById('dashboard-date-to');
  const dateError = document.getElementById('dashboard-date-error');

  /**
   * Devuelve el rango de fechas vigente leyendo los inputs, o null si ambos
   * extremos están vacíos (equivale al total histórico).
   * @returns {{ from: string|null, to: string|null }|null}
   */
  const getDateRange = () => {
    const from = fromInput?.value || null;
    const to = toInput?.value || null;
    if (!from && !to) return null;
    return { from, to };
  };

  // Manejo de errores del Dashboard: se muestran en el contenedor de error del
  // rango de fechas para no ocultarlos silenciosamente.
  const onError = (message) => setErrorMessage(dateError, message);

  // Arranque de la auto-actualización (carga inmediata + intervalo de 30 s).
  dashboardController = startDashboardAutoRefresh({
    cardsContainer,
    chartContainer,
    getDateRange,
    onError,
  });

  // El submit del formulario valida el rango y fuerza un refresco inmediato.
  if (dateForm) {
    dateForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const from = fromInput?.value || null;
      const to = toInput?.value || null;

      // Validación del rango (from > to) antes de aplicar (Requisito 7.4).
      const validation = validateDateRange(from, to);
      if (!validation.isValid) {
        setErrorMessage(dateError, validation.error);
        return;
      }

      // Rango válido: se limpia el error y se fuerza un refresco manual.
      setErrorMessage(dateError, null);
      if (dashboardController) {
        dashboardController.refresh();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Sección Todos los Tickets
// ---------------------------------------------------------------------------

/**
 * Renderiza la tabla de todos los tickets dentro del contenedor indicado. Los
 * datos se insertan con textContent y el status se muestra como badge para dar
 * contexto visual (Requisito 4.5).
 *
 * @param {object[]} tickets - Tickets devueltos por getAllTickets (con joins).
 * @param {HTMLElement} container - Contenedor de la tabla (#tickets-table).
 */
function renderTicketsTable(tickets, container) {
  if (!container) return;
  container.replaceChildren();

  if (!tickets || tickets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No hay tickets que coincidan con los filtros.';
    container.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';

  // Encabezado de la tabla.
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = [
    'Número',
    'Usuario',
    'Agente',
    'Categoría',
    'Status',
    'Estado',
    'Fecha creación',
  ];
  for (const headerText of headers) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = headerText;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Cuerpo de la tabla con una fila por ticket.
  const tbody = document.createElement('tbody');
  for (const ticket of tickets) {
    const row = document.createElement('tr');

    row.appendChild(createTextCell(ticket.ticket_number));
    // Nombre del creador y agente provenientes de los joins con profiles.
    row.appendChild(createTextCell(ticket.creator?.full_name ?? ''));
    row.appendChild(createTextCell(ticket.agent?.full_name ?? 'Sin asignar'));
    row.appendChild(createTextCell(ticket.categoria));

    // Columna Status como badge de color.
    const statusCell = document.createElement('td');
    const statusBadge = document.createElement('span');
    const modifier = STATUS_BADGE_MODIFIER[ticket.status] || '';
    statusBadge.className = `status-badge ${modifier}`.trim();
    statusBadge.textContent = ticket.status ?? '';
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    row.appendChild(createTextCell(ticket.estado));
    row.appendChild(createTextCell(formatCreationDate(ticket.fecha_creacion)));

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

/**
 * Formatea una fecha ISO a un formato corto legible en español. Retorna cadena
 * vacía si el valor es inválido para no romper el render.
 *
 * @param {string|null|undefined} isoDate - Fecha en formato ISO 8601.
 * @returns {string}
 */
function formatCreationDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

/**
 * Construye el objeto de filtros a partir del formulario de tickets. Los campos
 * de texto (usuario/agente) se envían como filtros por nombre y los selects
 * como filtros exactos. Sólo se incluyen los valores presentes.
 *
 * @returns {object} Filtros para getAllTickets.
 */
function buildTicketFilters() {
  const filters = {};

  const status = document.getElementById('filter-status')?.value;
  const estado = document.getElementById('filter-estado')?.value;
  const categoria = document.getElementById('filter-categoria')?.value;

  if (status) filters.status = status;
  if (estado) filters.estado = estado;
  if (categoria) filters.categoria = categoria;

  return filters;
}

/**
 * Carga los tickets aplicando los filtros actuales y los renderiza. Los errores
 * se muestran en el contenedor dedicado sin ocultarlos.
 */
async function loadAndRenderTickets() {
  const container = document.getElementById('tickets-table');
  const errorContainer = document.getElementById('tickets-error');

  const result = await getAllTickets(buildTicketFilters());

  if (!result.ok) {
    setErrorMessage(errorContainer, result.error);
    return;
  }

  setErrorMessage(errorContainer, null);

  // Filtrado por nombre de usuario/agente en el cliente. Los joins con profiles
  // traen el full_name, sobre el que se filtra de forma insensible a mayúsculas.
  const userFilter = document.getElementById('filter-user')?.value.trim().toLowerCase();
  const agentFilter = document.getElementById('filter-agent')?.value.trim().toLowerCase();

  let rows = result.data;
  if (userFilter) {
    rows = rows.filter((t) =>
      (t.creator?.full_name ?? '').toLowerCase().includes(userFilter)
    );
  }
  if (agentFilter) {
    rows = rows.filter((t) =>
      (t.agent?.full_name ?? '').toLowerCase().includes(agentFilter)
    );
  }

  renderTicketsTable(rows, container);
}

/**
 * Inicializa la sección de todos los tickets: conecta el formulario de filtros
 * (submit para filtrar, reset para limpiar) y realiza la carga inicial.
 */
function initTicketsSection() {
  const filtersForm = document.getElementById('tickets-filters');

  if (filtersForm) {
    filtersForm.addEventListener('submit', (event) => {
      event.preventDefault();
      loadAndRenderTickets();
    });

    // El reset limpia los campos y recarga la tabla completa tras el ciclo.
    filtersForm.addEventListener('reset', () => {
      // Se difiere para que los inputs ya estén vacíos al reconsultar.
      setTimeout(loadAndRenderTickets, 0);
    });
  }

  // Carga inicial de la tabla completa.
  loadAndRenderTickets();
}

// ---------------------------------------------------------------------------
// Sección Bitácora de Incidentes
// ---------------------------------------------------------------------------

/**
 * Renderiza las filas de la bitácora en el <tbody> de la tabla. Reutiliza las
 * funciones puras del módulo bitacora (formateo y cálculo del Total) mediante
 * buildBitacoraRows para mantener una única fuente de verdad del mapeo de
 * columnas. Todos los valores se insertan con textContent (defensa XSS).
 *
 * @param {Array<Array<string>>} cellRows - Matriz de celdas ya formateadas.
 */
function renderBitacoraRows(cellRows) {
  const tbody = document.getElementById('bitacora-tbody');
  if (!tbody) return;
  tbody.replaceChildren();

  if (!cellRows || cellRows.length === 0) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    // La tabla de la bitácora tiene 10 columnas definidas en el HTML.
    emptyCell.colSpan = 10;
    emptyCell.className = 'empty-state';
    emptyCell.textContent = 'No hay registros en el período seleccionado.';
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
    return;
  }

  for (const cells of cellRows) {
    const row = document.createElement('tr');
    for (const value of cells) {
      row.appendChild(createTextCell(value));
    }
    tbody.appendChild(row);
  }
}

/**
 * Construye el objeto de filtros de la bitácora a partir de los inputs de fecha
 * del formulario. Sólo incluye los extremos presentes.
 *
 * @returns {{ fecha_desde?: string, fecha_hasta?: string }}
 */
function buildBitacoraFilters() {
  const filters = {};
  const from = document.getElementById('bitacora-date-from')?.value;
  const to = document.getElementById('bitacora-date-to')?.value;
  if (from) filters.fecha_desde = from;
  if (to) filters.fecha_hasta = to;
  return filters;
}

/**
 * Construye una descripción legible de los filtros aplicados para incluirla en
 * el PDF exportado.
 *
 * @param {{ fecha_desde?: string, fecha_hasta?: string }} filters
 * @returns {string}
 */
function describeBitacoraFilters(filters) {
  const parts = [];
  if (filters.fecha_desde) parts.push(`Desde ${filters.fecha_desde}`);
  if (filters.fecha_hasta) parts.push(`Hasta ${filters.fecha_hasta}`);
  return parts.length > 0 ? parts.join(' — ') : 'Todos los registros';
}

/**
 * Carga la bitácora aplicando los filtros de fecha actuales, guarda las filas
 * crudas para su posterior exportación y las renderiza en la tabla.
 */
async function loadAndRenderBitacora() {
  const errorContainer = document.getElementById('bitacora-error');

  const filters = buildBitacoraFilters();
  const result = await loadBitacora(filters);

  if (!result.ok) {
    setErrorMessage(errorContainer, result.error);
    return;
  }

  setErrorMessage(errorContainer, null);

  // Se conservan las filas crudas para exportarlas exactamente como se ven.
  currentBitacoraRows = result.data;

  // Se mapean a la matriz de celdas con la función pura del módulo bitacora,
  // manteniendo una única fuente de verdad para el mapeo y el cálculo del Total.
  renderBitacoraRows(buildBitacoraRows(result.data));
}

/**
 * Inicializa la sección de bitácora: conecta el formulario de filtros de fecha
 * y el botón de exportación a PDF, y realiza la carga inicial.
 */
function initBitacoraSection() {
  const filtersForm = document.getElementById('bitacora-filters');
  const exportButton = document.getElementById('bitacora-export');

  if (filtersForm) {
    filtersForm.addEventListener('submit', (event) => {
      event.preventDefault();
      loadAndRenderBitacora();
    });
  }

  if (exportButton) {
    exportButton.addEventListener('click', async () => {
      // Se exportan las filas crudas actualmente en pantalla con una
      // descripción de los filtros aplicados (Requisitos 4.7, 4.8).
      exportButton.disabled = true;
      await exportBitacoraToPDF(
        currentBitacoraRows,
        describeBitacoraFilters(buildBitacoraFilters())
      );
      exportButton.disabled = false;
    });
  }

  // Carga inicial de la bitácora completa.
  loadAndRenderBitacora();
}

// ---------------------------------------------------------------------------
// Sección Gestión de Usuarios
// ---------------------------------------------------------------------------

/**
 * Inicializa la sección de gestión de usuarios. listUsers renderiza la tabla y
 * ya cablea internamente las acciones de bloquear/desbloquear/eliminar y su
 * refresco tras cada operación (Requisito 2.9).
 */
function initUsersSection() {
  const container = document.getElementById('users-table');
  if (container) {
    listUsers(1, container);
  }
}

// ---------------------------------------------------------------------------
// Header: notificaciones y cierre de sesión
// ---------------------------------------------------------------------------

/**
 * Conecta la campana de notificaciones para abrir/cerrar el dropdown y refleja
 * el estado accesible aria-expanded del botón.
 */
function initNotificationsBell() {
  const bell = document.getElementById('notifications-bell');
  const dropdown = document.getElementById('notifications-dropdown');
  if (!bell || !dropdown) return;

  bell.addEventListener('click', () => {
    const isHidden = dropdown.hidden;
    dropdown.hidden = !isHidden;
    bell.setAttribute('aria-expanded', String(isHidden));
  });

  // Cerrar el dropdown al hacer clic fuera del componente de notificaciones.
  document.addEventListener('click', (event) => {
    const notifications = bell.closest('.notifications');
    if (notifications && !notifications.contains(event.target)) {
      dropdown.hidden = true;
      bell.setAttribute('aria-expanded', 'false');
    }
  });
}

/**
 * Conecta el botón de cierre de sesión: cierra la sesión en Supabase y redirige
 * a la pantalla de login. Aunque el signOut remoto falle, se redirige para no
 * dejar al Admin en una página protegida.
 */
function initLogout() {
  const logoutButton = document.getElementById('logout-button');
  if (!logoutButton) return;

  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('[admin-panel] Error al cerrar sesión:', error);
    }
    window.location.replace(LOGIN_PATH);
  });
}

// ---------------------------------------------------------------------------
// Inicialización de la página
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del panel de Administrador. Verifica la sesión y el rol
 * antes de inicializar la interfaz; si el acceso no es válido, requireAuth ya
 * redirige al login y se aborta la inicialización.
 */
async function init() {
  // Protección de la página: sesión activa + rol Admin (Requisito 2.9).
  const auth = await requireAuth(['Admin']);
  if (!auth) return; // requireAuth ya redirigió al login.

  const { session, profile } = auth;

  // Mostrar el nombre del Admin autenticado en el header (textContent, XSS-safe).
  const userNameEl = document.getElementById('admin-user-name');
  if (userNameEl) {
    userNameEl.textContent = profile.full_name ?? profile.email ?? '';
  }

  // Vigilancia de inactividad de la sesión (Requisito 10.8).
  initSessionWatcher();

  // Navegación entre secciones.
  initNavigation();

  // Inicialización de cada sección de dominio.
  initDashboardSection();
  initTicketsSection();
  initBitacoraSection();
  initUsersSection();

  // Header: notificaciones en tiempo real + cierre de sesión.
  initNotificationsBell();
  initLogout();

  // Notificaciones del Admin autenticado: carga acumulada + suscripción CDC.
  const userId = session.user.id;
  initNotifications(userId);
  loadUnreadNotifications(userId);

  // Mostrar la sección inicial (Dashboard) por defecto.
  showSection('dashboard');
}

// Se arranca la inicialización cuando el DOM está listo. Al cargarse como
// módulo ES el script se ejecuta tras el parseo del DOM, por lo que los
// contenedores ya están disponibles; aun así se contempla el caso de carga
// temprana por robustez.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
