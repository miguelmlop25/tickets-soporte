/**
 * dashboard.js
 * Módulo de métricas del Dashboard (panel de Admin).
 *
 * Responsabilidades:
 *   - Consultar los tickets desde Supabase aplicando un filtro opcional de
 *     rango de fechas sobre `fecha_creacion` (loadDashboardMetrics).
 *   - Calcular los conteos por Status y por categoría a partir de un array de
 *     tickets mediante una función pura y testeable (computeMetrics).
 *   - Renderizar las cards de conteos (Pendiente, En proceso, Finalizado,
 *     Total) y un gráfico de barras por categoría dibujado con SVG nativo,
 *     sin depender de librerías externas.
 *   - Validar el rango de fechas seleccionado por el Admin (validateDateRange).
 *   - Refrescar automáticamente las métricas cada 30 segundos (setInterval).
 *
 * Nota de arquitectura:
 *   La lógica de cálculo (computeMetrics) se mantiene deliberadamente separada
 *   del acceso a datos (loadDashboardMetrics) y del renderizado (render*), de
 *   modo que pueda verificarse de forma aislada. Esto corresponde a la
 *   Property 11 del diseño: los conteos calculados deben reflejar el estado
 *   real de los tickets para cualquier conjunto de entrada.
 *
 * Nota de seguridad:
 *   El aislamiento y la visibilidad de los datos los garantizan las políticas
 *   de Row Level Security (RLS) del backend, que permiten al rol Admin
 *   consultar todos los tickets. Los filtros aplicados aquí son de
 *   conveniencia y nunca amplían la visibilidad más allá de lo que RLS
 *   autoriza (Requisito 10.6).
 *
 * Requisitos cubiertos: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import { supabase } from '../config.js';

// ---------------------------------------------------------------------------
// Constantes del módulo
// ---------------------------------------------------------------------------

/**
 * Valores posibles del campo `status` de un ticket, en el orden en que se
 * presentan las cards de métricas. Deben coincidir con el tipo enumerado
 * `ticket_status` de la base de datos.
 */
const TICKET_STATUSES = ['Pendiente', 'En proceso', 'Finalizado'];

/**
 * Categorías principales de soporte. Deben coincidir con el tipo enumerado
 * `ticket_categoria` de la base de datos. Se listan explícitamente para que el
 * gráfico muestre siempre las cinco categorías, incluso las que tengan cero
 * tickets en el período consultado.
 */
const TICKET_CATEGORIES = [
  'SOFTWARE',
  'HARDWARE',
  'CONFIGURACIONES',
  'SEGURIDAD',
  'TELECOMUNICACIONES',
];

/** Intervalo de auto-actualización de métricas: 30 segundos (Requisito 7.1). */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * Mapa de status a la clase modificadora CSS de la card correspondiente,
 * definida en dashboard-admin.css.
 */
const STATUS_CARD_MODIFIER = {
  Pendiente: 'metric-card--pendiente',
  'En proceso': 'metric-card--en-proceso',
  Finalizado: 'metric-card--finalizado',
};

// Espacio de nombres SVG requerido para crear elementos con createElementNS.
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// Lógica de cálculo (función pura y testeable)
// ---------------------------------------------------------------------------

/**
 * Calcula los conteos de tickets por Status y por categoría.
 *
 * Función pura: no accede a la red ni al DOM y no muta la entrada. Dado el
 * mismo array de tickets y el mismo rango de fechas, retorna siempre el mismo
 * resultado. Es la pieza verificada por la Property 11 del diseño.
 *
 * El filtro de rango de fechas se aplica de forma inclusiva sobre el campo
 * `fecha_creacion` de cada ticket. Si `dateRange` es nulo o no define límites,
 * se contabiliza el total histórico (Requisitos 7.2 y 7.5).
 *
 * @param {Array<Object>} tickets - Tickets con al menos `status`, `categoria`
 *   y `fecha_creacion`.
 * @param {{ from?: string|Date|null, to?: string|Date|null }} [dateRange] -
 *   Rango de fechas opcional. `from` y `to` pueden ser ISO strings o Date.
 * @returns {{
 *   byStatus: { Pendiente: number, 'En proceso': number, Finalizado: number },
 *   total: number,
 *   byCategory: Object<string, number>
 * }} Conteos por status, total y conteos por categoría.
 */
export function computeMetrics(tickets, dateRange = null) {
  // Se inicializan todos los contadores en cero para garantizar que las claves
  // existan aunque no haya tickets, evitando `undefined` en el renderizado.
  const byStatus = TICKET_STATUSES.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});

  const byCategory = TICKET_CATEGORIES.reduce((acc, categoria) => {
    acc[categoria] = 0;
    return acc;
  }, {});

  // Límites del rango normalizados a milisegundos (o null si no aplican).
  const fromMs = parseBoundary(dateRange?.from);
  const toMs = parseBoundary(dateRange?.to);

  const safeTickets = Array.isArray(tickets) ? tickets : [];
  let total = 0;

  for (const ticket of safeTickets) {
    if (!ticket) continue;

    // Filtro inclusivo por rango de fechas de creación.
    if (fromMs !== null || toMs !== null) {
      const createdMs = parseBoundary(ticket.fecha_creacion);
      // Un ticket sin fecha válida no puede ubicarse en el rango: se excluye.
      if (createdMs === null) continue;
      if (fromMs !== null && createdMs < fromMs) continue;
      if (toMs !== null && createdMs > toMs) continue;
    }

    total += 1;

    // Sólo se contabilizan valores de status/categoría conocidos, para no
    // introducir claves inesperadas provenientes de datos corruptos.
    if (Object.prototype.hasOwnProperty.call(byStatus, ticket.status)) {
      byStatus[ticket.status] += 1;
    }
    if (Object.prototype.hasOwnProperty.call(byCategory, ticket.categoria)) {
      byCategory[ticket.categoria] += 1;
    }
  }

  return { byStatus, total, byCategory };
}

/**
 * Convierte un valor de fecha (Date o string ISO) a milisegundos epoch.
 * Retorna null si el valor es ausente o no representa una fecha válida, de
 * modo que las comparaciones puedan omitir límites indefinidos.
 *
 * @param {string|Date|null|undefined} value
 * @returns {number|null}
 */
function parseBoundary(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Validación de rango de fechas
// ---------------------------------------------------------------------------

/**
 * Valida un rango de fechas seleccionado por el Admin.
 *
 * Retorna un error cuando la fecha de inicio es posterior a la fecha de fin
 * (Requisito 7.4). Un rango con alguno de sus extremos vacío se considera
 * válido, ya que representa un filtro parcial o el total histórico.
 *
 * @param {string|Date|null} from - Fecha de inicio del rango.
 * @param {string|Date|null} to - Fecha de fin del rango.
 * @returns {{ isValid: boolean, error: string|null }}
 */
export function validateDateRange(from, to) {
  const fromMs = parseBoundary(from);
  const toMs = parseBoundary(to);

  // Sin ambos extremos definidos no hay inconsistencia posible de orden.
  if (fromMs === null || toMs === null) {
    return { isValid: true, error: null };
  }

  if (fromMs > toMs) {
    return {
      isValid: false,
      error: 'El rango de fechas no es válido: la fecha de inicio no puede ser posterior a la fecha de fin.',
    };
  }

  return { isValid: true, error: null };
}

// ---------------------------------------------------------------------------
// Acceso a datos
// ---------------------------------------------------------------------------

/**
 * Consulta los tickets desde Supabase y calcula las métricas del Dashboard.
 *
 * Aplica el filtro de rango de fechas sobre `fecha_creacion` directamente en la
 * consulta cuando el rango es válido, delegando el filtrado en la base de datos
 * para no transferir filas innecesarias. El cálculo de conteos se realiza con
 * la función pura `computeMetrics`.
 *
 * @param {{ from?: string|Date|null, to?: string|Date|null }} [dateRange]
 * @returns {Promise<{
 *   byStatus: Object, total: number, byCategory: Object
 * }>}
 * @throws {Error} Si el rango de fechas es inválido o si falla la consulta.
 */
export async function loadDashboardMetrics(dateRange = null) {
  const from = dateRange?.from ?? null;
  const to = dateRange?.to ?? null;

  // Validación temprana del rango: no se consulta si es inconsistente.
  const validation = validateDateRange(from, to);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  // Sólo se seleccionan las columnas necesarias para el cálculo de métricas.
  let query = supabase.from('tickets').select('status, categoria, fecha_creacion');

  // Filtro inclusivo por rango de fechas de creación.
  if (from) {
    query = query.gte('fecha_creacion', new Date(from).toISOString());
  }
  if (to) {
    query = query.lte('fecha_creacion', new Date(to).toISOString());
  }

  const { data, error } = await query;

  if (error) {
    // No se oculta el error: se propaga con un mensaje claro para el llamador,
    // que decidirá cómo informar al usuario.
    throw new Error(`No se pudieron cargar las métricas del Dashboard: ${error.message}`);
  }

  return computeMetrics(data ?? [], dateRange);
}

// ---------------------------------------------------------------------------
// Renderizado de cards de métricas
// ---------------------------------------------------------------------------

/**
 * Renderiza las cards de conteos por Status más la card de Total dentro del
 * contenedor indicado, reutilizando las clases de dashboard-admin.css.
 *
 * @param {Object} metrics - Resultado de computeMetrics.
 * @param {HTMLElement} container - Contenedor con clase `.metrics-grid`.
 */
export function renderMetricCards(metrics, container) {
  if (!container) return;

  // Se reconstruye el contenido de forma controlada usando textContent para
  // los valores numéricos, evitando cualquier inyección de HTML.
  container.innerHTML = '';

  for (const status of TICKET_STATUSES) {
    container.appendChild(
      buildMetricCard(status, metrics.byStatus[status] ?? 0, STATUS_CARD_MODIFIER[status])
    );
  }

  // Card de total, con su modificador propio.
  container.appendChild(buildMetricCard('Total', metrics.total ?? 0, 'metric-card--total'));
}

/**
 * Construye el nodo DOM de una card de métrica individual.
 *
 * @param {string} label - Etiqueta visible de la métrica.
 * @param {number} value - Valor numérico a mostrar.
 * @param {string} modifierClass - Clase modificadora de color del borde.
 * @returns {HTMLElement}
 */
function buildMetricCard(label, value, modifierClass) {
  const card = document.createElement('div');
  card.className = 'metric-card';
  if (modifierClass) card.classList.add(modifierClass);

  const labelEl = document.createElement('span');
  labelEl.className = 'metric-card__label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'metric-card__value';
  valueEl.textContent = String(value);

  card.append(labelEl, valueEl);
  return card;
}

// ---------------------------------------------------------------------------
// Renderizado del gráfico de barras por categoría (SVG nativo)
// ---------------------------------------------------------------------------

/**
 * Dibuja un gráfico de barras verticales con los conteos por categoría usando
 * SVG nativo (sin librerías externas). El SVG es responsivo mediante un
 * `viewBox` y `preserveAspectRatio`, ocupando el ancho del `.chart-canvas`.
 *
 * @param {Object<string, number>} byCategory - Conteos por categoría.
 * @param {HTMLElement} container - Contenedor con clase `.chart-canvas`.
 */
export function renderCategoryChart(byCategory, container) {
  if (!container) return;

  container.innerHTML = '';

  // Dimensiones del lienzo lógico del SVG (el viewBox escala al contenedor).
  const width = 600;
  const height = 260;
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const categories = TICKET_CATEGORIES;
  const values = categories.map((c) => byCategory[c] ?? 0);
  // El máximo determina la escala vertical; se usa 1 como mínimo para evitar
  // división por cero cuando todos los conteos son cero.
  const maxValue = Math.max(1, ...values);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Gráfico de tickets por categoría');

  // Eje X (línea base) para dar contexto visual a las barras.
  const baseline = document.createElementNS(SVG_NS, 'line');
  baseline.setAttribute('x1', String(padding.left));
  baseline.setAttribute('y1', String(padding.top + chartHeight));
  baseline.setAttribute('x2', String(padding.left + chartWidth));
  baseline.setAttribute('y2', String(padding.top + chartHeight));
  baseline.setAttribute('stroke', 'currentColor');
  baseline.setAttribute('stroke-opacity', '0.25');
  svg.appendChild(baseline);

  // Cálculo del ancho de cada barra dejando espacio de separación (gap).
  const slot = chartWidth / categories.length;
  const barWidth = slot * 0.6;

  categories.forEach((categoria, index) => {
    const value = values[index];
    const barHeight = (value / maxValue) * chartHeight;
    const x = padding.left + index * slot + (slot - barWidth) / 2;
    const y = padding.top + chartHeight - barHeight;

    // Barra de la categoría.
    const bar = document.createElementNS(SVG_NS, 'rect');
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', String(y));
    bar.setAttribute('width', String(barWidth));
    bar.setAttribute('height', String(barHeight));
    bar.setAttribute('fill', 'var(--color-primary, #2f5fa3)');
    bar.setAttribute('rx', '3');
    // Título accesible por barra (tooltip nativo del navegador).
    const barTitle = document.createElementNS(SVG_NS, 'title');
    barTitle.textContent = `${categoria}: ${value}`;
    bar.appendChild(barTitle);
    svg.appendChild(bar);

    // Valor numérico sobre la barra.
    const valueLabel = document.createElementNS(SVG_NS, 'text');
    valueLabel.setAttribute('x', String(x + barWidth / 2));
    valueLabel.setAttribute('y', String(y - 6));
    valueLabel.setAttribute('text-anchor', 'middle');
    valueLabel.setAttribute('font-size', '12');
    valueLabel.setAttribute('fill', 'currentColor');
    valueLabel.textContent = String(value);
    svg.appendChild(valueLabel);

    // Etiqueta de la categoría bajo el eje X.
    const catLabel = document.createElementNS(SVG_NS, 'text');
    catLabel.setAttribute('x', String(x + barWidth / 2));
    catLabel.setAttribute('y', String(padding.top + chartHeight + 16));
    catLabel.setAttribute('text-anchor', 'middle');
    catLabel.setAttribute('font-size', '9');
    catLabel.setAttribute('fill', 'currentColor');
    catLabel.textContent = categoria;
    svg.appendChild(catLabel);
  });

  container.appendChild(svg);
}

// ---------------------------------------------------------------------------
// Orquestación: carga + render + auto-actualización
// ---------------------------------------------------------------------------

/**
 * Carga las métricas y actualiza la interfaz (cards y gráfico), delegando la
 * gestión de errores en un callback opcional para que la página decida cómo
 * mostrarlos.
 *
 * @param {{
 *   dateRange?: Object|null,
 *   cardsContainer?: HTMLElement|null,
 *   chartContainer?: HTMLElement|null,
 *   onError?: (message: string) => void
 * }} options
 * @returns {Promise<Object|null>} Las métricas calculadas, o null si hubo error.
 */
export async function refreshDashboard({
  dateRange = null,
  cardsContainer = null,
  chartContainer = null,
  onError = null,
} = {}) {
  try {
    const metrics = await loadDashboardMetrics(dateRange);
    if (cardsContainer) renderMetricCards(metrics, cardsContainer);
    if (chartContainer) renderCategoryChart(metrics.byCategory, chartContainer);
    return metrics;
  } catch (err) {
    // El error se comunica hacia arriba sin ocultarlo. Si no hay manejador,
    // se registra en consola para no perder la traza.
    if (typeof onError === 'function') {
      onError(err.message);
    } else {
      console.error('[dashboard] Error al refrescar métricas:', err);
    }
    return null;
  }
}

/**
 * Inicia el Dashboard: realiza una carga inmediata y programa la
 * actualización automática cada 30 segundos (Requisito 7.1).
 *
 * @param {Object} options - Mismas opciones que refreshDashboard, más un
 *   `getDateRange` opcional que permite recalcular el rango vigente en cada
 *   ciclo (por ejemplo, leyendo los selectores de fecha del DOM).
 * @param {() => (Object|null)} [options.getDateRange] - Proveedor del rango
 *   de fechas actual, evaluado en cada refresco.
 * @returns {{ stop: () => void, refresh: () => Promise<Object|null> }}
 *   Controlador con `stop` para detener el intervalo y `refresh` para forzar
 *   una actualización manual.
 */
export function startDashboardAutoRefresh(options = {}) {
  const { getDateRange, ...renderOptions } = options;

  // Resuelve el rango vigente en cada ciclo: dinámico si se provee getDateRange,
  // estático (renderOptions.dateRange) en caso contrario.
  const resolveDateRange = () =>
    typeof getDateRange === 'function' ? getDateRange() : renderOptions.dateRange ?? null;

  const runRefresh = () =>
    refreshDashboard({ ...renderOptions, dateRange: resolveDateRange() });

  // Carga inicial inmediata.
  runRefresh();

  // Actualización periódica cada 30 segundos.
  const intervalId = setInterval(runRefresh, REFRESH_INTERVAL_MS);

  return {
    stop: () => clearInterval(intervalId),
    refresh: runRefresh,
  };
}
