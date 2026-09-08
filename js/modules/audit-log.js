/**
 * audit-log.js
 * Módulo de consulta del registro de auditoría (Audit Log) del lado cliente.
 *
 * Responsabilidades:
 *   - Consultar el Audit Log invocando la Edge Function `export-audit-log`,
 *     aplicando filtros (actor_id, action, date_from, date_to) y paginación.
 *   - Renderizar los resultados en una tabla paginada (máx. 100 registros por
 *     página) con las columnas: timestamp, actor, acción, tipo de entidad e
 *     identificador de entidad.
 *
 * Nota de arquitectura y seguridad:
 *   - La consulta del Audit Log se realiza a través de una Edge Function porque
 *     requiere rol Admin (verificado en el backend mediante Auth Guard) y usa
 *     la service_role para leer registros de todos los usuarios. El JWT del
 *     Admin autenticado se adjunta automáticamente por el cliente Supabase.
 *   - `export-audit-log` es una petición GET que recibe los filtros como query
 *     params y responde con `{ data, pagination, filters }`.
 *   - El renderizado usa `textContent` en todas las celdas para evitar la
 *     inyección de HTML (defensa XSS en el cliente).
 *
 * Requisitos cubiertos: 9.5
 */

import { supabase } from '../config.js';

// ---------------------------------------------------------------------------
// Constantes del módulo
// ---------------------------------------------------------------------------

/** Nombre de la Edge Function que consulta el Audit Log. */
const EDGE_FUNCTION_NAME = 'export-audit-log';

/**
 * Claves de filtro aceptadas por la Edge Function `export-audit-log`.
 * Se usan para construir la cadena de query params de forma controlada,
 * ignorando cualquier propiedad no reconocida del objeto de filtros.
 */
const ALLOWED_FILTER_KEYS = ['actor_id', 'action', 'date_from', 'date_to', 'page'];

/**
 * Definición de las columnas de la tabla del Audit Log en el orden de
 * renderizado. Cada columna incluye su encabezado visible y una función
 * `value` que extrae el valor a mostrar a partir de una fila del audit_log.
 */
const TABLE_COLUMNS = [
  {
    header: 'Fecha y hora',
    value: (row) => formatTimestamp(row.created_at),
  },
  {
    header: 'Actor',
    value: (row) => formatActor(row.actor),
  },
  {
    header: 'Acción',
    value: (row) => row.action || '',
  },
  {
    header: 'Tipo de entidad',
    value: (row) => row.entity_type || '',
  },
  {
    header: 'ID de entidad',
    value: (row) => row.entity_id || '',
  },
];

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/**
 * Traduce un código de estado HTTP proveniente de la Edge Function a un mensaje
 * claro para el Admin. Los mensajes de autenticación son genéricos para no
 * revelar información sensible (Requisito 9 / manejo de errores del diseño).
 *
 * @param {number} status - Código HTTP recibido de la Edge Function.
 * @param {string} [backendMessage] - Mensaje devuelto por el backend, si existe.
 * @returns {string} Mensaje descriptivo en español.
 */
function messageForHttpStatus(status, backendMessage) {
  switch (status) {
    case 400:
      // El backend indica el filtro específico inválido; se prioriza.
      return backendMessage || 'Los filtros enviados no son válidos.';
    case 401:
      return 'Su sesión no es válida o ha expirado. Inicie sesión nuevamente.';
    case 403:
      return 'No tiene autorización para consultar el registro de auditoría.';
    case 429:
      return 'Se ha superado el límite de peticiones. Intente más tarde.';
    default:
      return backendMessage || 'No fue posible obtener el registro de auditoría.';
  }
}

/**
 * Extrae el código de estado HTTP y el cuerpo JSON del error devuelto por
 * `supabase.functions.invoke()`. El SDK expone el response original en
 * `error.context` (un objeto Response de Fetch).
 *
 * @param {object} error - Objeto de error de FunctionsHttpError.
 * @returns {Promise<{ status: number, body: (object|null) }>}
 */
async function parseFunctionError(error) {
  const response = error?.context;
  let status = 500;
  let body = null;

  if (response && typeof response.status === 'number') {
    status = response.status;
    // El cuerpo puede leerse una sola vez; se clona antes de parsear.
    try {
      body = await response.clone().json();
    } catch {
      body = null;
    }
  }

  return { status, body };
}

/**
 * Construye la cadena de query params a partir de un objeto de filtros,
 * incluyendo únicamente las claves permitidas y con valor no vacío. Esto evita
 * enviar parámetros vacíos o no reconocidos a la Edge Function.
 *
 * @param {object} [filters] - Objeto con filtros opcionales.
 * @returns {string} Cadena de query params con prefijo '?' o cadena vacía.
 */
function buildQueryString(filters) {
  if (!filters || typeof filters !== 'object') {
    return '';
  }

  const params = new URLSearchParams();

  for (const key of ALLOWED_FILTER_KEYS) {
    const rawValue = filters[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    const value = String(rawValue).trim();
    if (value !== '') {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

// ---------------------------------------------------------------------------
// fetchAuditLog
// ---------------------------------------------------------------------------

/**
 * Consulta el Audit Log invocando la Edge Function `export-audit-log`.
 *
 * Los filtros de paginación y de consulta se envían como query params porque la
 * Edge Function es una petición GET. El JWT del Admin autenticado se adjunta
 * automáticamente por el cliente Supabase, que valida el rol en el backend.
 *
 * Manejo de errores HTTP con mensajes específicos:
 *   - 400: alguno de los filtros no es válido (se conserva el mensaje del backend).
 *   - 401: sesión inválida o expirada.
 *   - 403: el rol del usuario no es Admin.
 *   - 429: se superó el límite de peticiones (rate limit).
 *
 * @param {object} [filters] - Filtros opcionales:
 *   { actor_id, action, date_from, date_to, page }
 * @returns {Promise<{
 *   ok: boolean,
 *   data: object[],
 *   pagination: { page: number, pageSize: number, total: number, totalPages: number }|null,
 *   error: string|null,
 *   status: number|null
 * }>}
 */
export async function fetchAuditLog(filters) {
  // La Edge Function GET recibe los filtros como query params en la ruta.
  const functionPath = `${EDGE_FUNCTION_NAME}${buildQueryString(filters)}`;

  const { data, error } = await supabase.functions.invoke(functionPath, {
    method: 'GET',
  });

  if (error) {
    const { status, body } = await parseFunctionError(error);
    return {
      ok: false,
      data: [],
      pagination: null,
      error: messageForHttpStatus(status, body?.error),
      status,
    };
  }

  return {
    ok: true,
    data: Array.isArray(data?.data) ? data.data : [],
    pagination: data?.pagination ?? null,
    error: null,
    status: 200,
  };
}

// ---------------------------------------------------------------------------
// Renderizado del DOM
// ---------------------------------------------------------------------------

/**
 * Renderiza los registros del Audit Log en una tabla dentro del contenedor
 * indicado. La tabla incluye un encabezado con las columnas definidas y una
 * fila por cada registro. Todas las celdas usan `textContent` para prevenir la
 * inyección de HTML (defensa XSS).
 *
 * Si `pagination` está presente, se agrega un pie con la información de página
 * actual y total de páginas/registros.
 *
 * @param {HTMLElement} container - Contenedor donde se inserta la tabla.
 * @param {object[]} rows - Registros del audit_log a renderizar.
 * @param {object} [pagination] - Metadatos de paginación { page, pageSize, total, totalPages }.
 */
export function renderAuditLog(container, rows, pagination) {
  if (!(container instanceof HTMLElement)) {
    console.error('[audit-log] renderAuditLog: se requiere un contenedor DOM válido.');
    return;
  }

  const records = Array.isArray(rows) ? rows : [];

  // Se limpia el contenedor antes de repintar para evitar duplicados.
  container.replaceChildren();

  // Estado vacío accesible cuando no hay registros que mostrar.
  if (records.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'audit-log__empty';
    empty.textContent = 'No hay registros de auditoría para los filtros aplicados.';
    container.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'audit-log__table';

  // Encabezado de la tabla.
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const column of TABLE_COLUMNS) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column.header;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Cuerpo de la tabla: una fila por registro del audit_log.
  const tbody = document.createElement('tbody');
  for (const row of records) {
    const tr = document.createElement('tr');
    for (const column of TABLE_COLUMNS) {
      const td = document.createElement('td');
      // textContent evita la inyección de HTML desde los datos.
      td.textContent = String(column.value(row) ?? '');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.appendChild(table);

  // Pie de paginación (opcional) con la información de página y totales.
  if (pagination && typeof pagination === 'object') {
    container.appendChild(buildPaginationFooter(pagination));
  }
}

/**
 * Construye el pie de paginación con la información de página actual, total de
 * páginas y total de registros.
 *
 * @param {object} pagination - { page, pageSize, total, totalPages }.
 * @returns {HTMLElement} Elemento con el resumen de paginación.
 */
function buildPaginationFooter(pagination) {
  const footer = document.createElement('div');
  footer.className = 'audit-log__pagination';

  const page = Number(pagination.page) || 1;
  const totalPages = Number(pagination.totalPages) || 1;
  const total = Number(pagination.total) || 0;

  footer.textContent = `Página ${page} de ${totalPages} — ${total} registro(s) en total`;
  return footer;
}

// ---------------------------------------------------------------------------
// Utilidades de formato
// ---------------------------------------------------------------------------

/**
 * Formatea una marca temporal ISO en una cadena legible en español.
 *
 * @param {string} isoString - Fecha en formato ISO 8601 (UTC).
 * @returns {string} Fecha localizada, o la cadena original si no es parseable.
 */
function formatTimestamp(isoString) {
  if (!isoString) {
    return '';
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return String(isoString);
  }

  return date.toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Deriva una representación legible del actor a partir del objeto `actor`
 * incluido en el join con `profiles` de la Edge Function. Prioriza el nombre
 * completo, luego el correo y, como último recurso, deja la celda vacía.
 *
 * @param {object|null} actor - Objeto { full_name, email, role } o null.
 * @returns {string} Nombre o correo del actor, o cadena vacía.
 */
function formatActor(actor) {
  if (!actor || typeof actor !== 'object') {
    return '';
  }
  return actor.full_name || actor.email || '';
}
