/**
 * bitacora.js
 * Módulo de la Bitácora de incidentes (solo Admin) y su exportación a PDF.
 *
 * Responsabilidades:
 *   - Consultar los tickets con join a `profiles` para construir las filas de
 *     la bitácora, aplicando filtros por rango de fechas (loadBitacora).
 *   - Exportar las filas visibles a un archivo PDF con jsPDF + autoTable,
 *     manejando cualquier error sin alterar los datos en pantalla
 *     (exportBitacoraToPDF).
 *
 * Nota de arquitectura y seguridad:
 *   - La lectura es una consulta directa a la base de datos. La visibilidad
 *     está gobernada por las políticas de Row Level Security (RLS): solo un
 *     Admin puede leer la totalidad de los tickets. Los filtros de este módulo
 *     son de conveniencia y nunca amplían la visibilidad más allá de RLS.
 *   - jsPDF y jspdf-autotable se cargan bajo demanda desde `cdnjs.cloudflare.com`,
 *     origen explícitamente permitido por la Content Security Policy del
 *     proyecto (`script-src`). La generación del PDF ocurre íntegramente en el
 *     navegador del cliente; no se transmiten datos a terceros.
 *
 * Nota de testabilidad:
 *   - El cálculo del Total y el formateo de fecha/hora se implementan como
 *     funciones puras exportadas (calcTotal, formatDate, formatTime,
 *     buildBitacoraRows) para poder verificarlas de forma unitaria sin
 *     depender del navegador ni de la librería PDF.
 *
 * Requisitos cubiertos: 4.6, 4.7, 4.8
 */

import { supabase } from '../config.js';

// ---------------------------------------------------------------------------
// Constantes del módulo
// ---------------------------------------------------------------------------

/**
 * URLs de las librerías de generación de PDF, servidas desde cdnjs (origen
 * permitido por la CSP). Se cargan como scripts UMD que exponen sus globales
 * en `window.jspdf` y registran el plugin autoTable sobre jsPDF.
 */
const JSPDF_CDN_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.2.1/jspdf.umd.min.js';
const AUTOTABLE_CDN_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.5/jspdf.plugin.autotable.min.js';

/**
 * Encabezados de las 10 columnas de la Bitácora de incidentes, en el orden
 * definido por el Requisito 4.6.
 */
export const BITACORA_COLUMNS = [
  'Número de Ticket',
  'Area que reporta',
  'Solicitado por',
  'Fecha de apertura',
  'Descripción del problema',
  'Inicio',
  'Fin',
  'Total',
  'Status actual',
  'Solución aplicada',
];

/**
 * Proyección de columnas para la consulta con join a `profiles`. El alias
 * `creator` referencia la clave foránea tickets.user_id para obtener el
 * `full_name` del User que reporta el ticket (columna "Solicitado por").
 */
const SELECT_BITACORA = `
  ticket_number,
  area,
  descripcion,
  status,
  solucion_aplicada,
  fecha_creacion,
  fecha_inicio,
  fecha_fin,
  creator:profiles!tickets_user_id_fkey ( full_name )
`;

// ---------------------------------------------------------------------------
// Funciones puras de formateo y cálculo (testeables sin navegador)
// ---------------------------------------------------------------------------

/**
 * Formatea una marca de tiempo ISO a la fecha local en formato DD/MM/YYYY.
 * Retorna cadena vacía si el valor es nulo o inválido (p. ej. tickets sin
 * fecha de finalización).
 *
 * @param {string|null|undefined} isoDate - Fecha en formato ISO 8601.
 * @returns {string} Fecha formateada como DD/MM/YYYY o cadena vacía.
 */
export function formatDate(isoDate) {
  if (!isoDate) {
    return '';
  }
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Formatea una marca de tiempo ISO a la hora local en formato HH:MM (24 h).
 * Retorna cadena vacía si el valor es nulo o inválido.
 *
 * @param {string|null|undefined} isoDate - Fecha en formato ISO 8601.
 * @returns {string} Hora formateada como HH:MM o cadena vacía.
 */
export function formatTime(isoDate) {
  if (!isoDate) {
    return '';
  }
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Calcula el tiempo total transcurrido entre el inicio y el fin de atención de
 * un ticket, expresado en horas y minutos (formato "Xh Ym").
 *
 * Reglas (Requisito 4.6):
 *   - Si el ticket aún no ha finalizado (fin ausente) o el inicio es ausente,
 *     retorna cadena vacía (la columna aparece en blanco).
 *   - Si alguna de las fechas es inválida, retorna cadena vacía.
 *   - Si el fin es anterior al inicio (dato inconsistente), retorna cadena
 *     vacía para no mostrar un total negativo.
 *
 * Función pura: no depende del navegador ni de la librería PDF, por lo que es
 * directamente testeable de forma unitaria.
 *
 * @param {string|null|undefined} inicio - Fecha/hora de inicio (ISO 8601).
 * @param {string|null|undefined} fin - Fecha/hora de fin (ISO 8601).
 * @returns {string} Duración formateada como "Xh Ym" o cadena vacía.
 */
export function calcTotal(inicio, fin) {
  if (!inicio || !fin) {
    return '';
  }

  const start = new Date(inicio);
  const end = new Date(fin);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return '';
  }

  const diffMs = end.getTime() - start.getTime();
  if (diffMs < 0) {
    return '';
  }

  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}h ${minutes}m`;
}

/**
 * Transforma las filas crudas devueltas por la consulta en la matriz de celdas
 * lista para la tabla del PDF, en el orden de columnas de BITACORA_COLUMNS.
 *
 * Función pura: recibe los datos ya cargados y devuelve las celdas formateadas
 * sin efectos secundarios, lo que permite verificar el mapeo de columnas y el
 * cálculo del Total de forma unitaria.
 *
 * @param {object[]} rows - Filas crudas de la bitácora. Cada fila puede incluir
 *   `creator.full_name` (join) o `full_name` directamente.
 * @returns {Array<Array<string>>} Matriz de celdas (una fila por ticket).
 */
export function buildBitacoraRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((r) => {
    // El nombre del solicitante puede venir del join (`creator`) o aplanado.
    const solicitadoPor = r.creator?.full_name ?? r.full_name ?? '';

    return [
      r.ticket_number ?? '',
      r.area ?? '',
      solicitadoPor,
      formatDate(r.fecha_creacion),
      r.descripcion ?? '',
      formatTime(r.fecha_inicio),
      formatTime(r.fecha_fin),
      calcTotal(r.fecha_inicio, r.fecha_fin),
      r.status ?? '',
      r.solucion_aplicada ?? '',
    ];
  });
}

// ---------------------------------------------------------------------------
// Utilidades internas de UI y carga de librerías
// ---------------------------------------------------------------------------

/**
 * Muestra un mensaje de error de exportación sin alterar los datos visibles en
 * pantalla (Requisito 4.8). Se apoya en un contenedor con id
 * `bitacora-error` si existe; en caso contrario, degrada a `alert`.
 *
 * @param {string} message - Mensaje a mostrar al usuario.
 */
function showErrorMessage(message) {
  if (typeof document !== 'undefined') {
    const container = document.getElementById('bitacora-error');
    if (container) {
      container.textContent = message;
      container.hidden = false;
      return;
    }
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message);
      return;
    }
  }
  // Último recurso: registrar en consola si no hay entorno de UI disponible.
  console.error(message);
}

/**
 * Carga un script externo de forma dinámica y resuelve cuando termina de
 * cargarse. Reutiliza scripts ya insertados para evitar cargas duplicadas.
 *
 * @param {string} src - URL del script a cargar.
 * @returns {Promise<void>}
 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    // Si el script ya fue insertado previamente, no volver a cargarlo.
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () =>
        reject(new Error(`No se pudo cargar el recurso: ${src}`))
      );
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    });
    script.addEventListener('error', () =>
      reject(new Error(`No se pudo cargar el recurso: ${src}`))
    );
    document.head.appendChild(script);
  });
}

/**
 * Garantiza que jsPDF y el plugin autoTable estén disponibles en el navegador,
 * cargándolos desde cdnjs si aún no lo están. El archivo UMD de jsPDF expone la
 * constructora en `window.jspdf.jsPDF`, y el plugin autoTable se registra tanto
 * como método de instancia (`doc.autoTable`) como función independiente.
 *
 * @returns {Promise<Function>} La constructora `jsPDF`.
 */
async function ensurePdfLibraries() {
  await loadScript(JSPDF_CDN_URL);
  await loadScript(AUTOTABLE_CDN_URL);

  const jsPDFCtor = window.jspdf?.jsPDF;
  if (typeof jsPDFCtor !== 'function') {
    throw new Error('La librería de generación de PDF no está disponible.');
  }
  return jsPDFCtor;
}

// ---------------------------------------------------------------------------
// loadBitacora
// ---------------------------------------------------------------------------

/**
 * Consulta los tickets para construir la Bitácora de incidentes, aplicando un
 * filtro opcional por rango de fechas de creación (Requisito 4.7). Realiza un
 * join a `profiles` para resolver el nombre del User que reporta cada ticket.
 *
 * La visibilidad está gobernada por RLS (solo Admin ve todos los tickets); los
 * filtros aquí son de conveniencia y no amplían dicha visibilidad.
 *
 * @param {object} [filters] - Filtros opcionales:
 *   { fecha_desde, fecha_hasta } (ISO 8601).
 * @returns {Promise<{ ok: boolean, data: object[], error: string|null }>}
 */
export async function loadBitacora(filters) {
  let query = supabase
    .from('tickets')
    .select(SELECT_BITACORA)
    .order('fecha_creacion', { ascending: false });

  if (filters && typeof filters === 'object') {
    if (filters.fecha_desde) {
      query = query.gte('fecha_creacion', filters.fecha_desde);
    }
    if (filters.fecha_hasta) {
      query = query.lte('fecha_creacion', filters.fecha_hasta);
    }
  }

  const { data, error } = await query;

  if (error) {
    console.error('[bitacora] Error al consultar loadBitacora:', error);
    return {
      ok: false,
      data: [],
      error: 'No fue posible cargar la bitácora. Intente nuevamente.',
    };
  }

  return { ok: true, data: data ?? [], error: null };
}

// ---------------------------------------------------------------------------
// exportBitacoraToPDF
// ---------------------------------------------------------------------------

/**
 * Exporta las filas de la Bitácora de incidentes a un archivo PDF en
 * orientación horizontal (landscape, A4). Agrega el título "Bitácora de
 * incidentes", la fecha de exportación, los filtros aplicados y una tabla con
 * las 10 columnas definidas (Requisitos 4.6, 4.7).
 *
 * Manejo de errores (Requisito 4.8): toda la generación se envuelve en
 * `try/catch`; ante cualquier fallo se muestra un mensaje de error y NO se
 * modifican los datos visibles en pantalla.
 *
 * Si no hay filas, se informa al usuario y no se genera ningún PDF.
 *
 * @param {object[]} rows - Filas de la bitácora (crudas, provenientes de
 *   loadBitacora). Cada fila incluye `creator.full_name` (join) o `full_name`.
 * @param {string} [filtros] - Descripción legible de los filtros aplicados.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function exportBitacoraToPDF(rows, filtros) {
  // Validación previa: sin datos no se genera PDF, solo se informa.
  if (!Array.isArray(rows) || rows.length === 0) {
    showErrorMessage('No hay datos para exportar.');
    return { ok: false, error: 'No hay datos para exportar.' };
  }

  try {
    const JsPDFCtor = await ensurePdfLibraries();
    const doc = new JsPDFCtor({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4',
    });

    // Título de la bitácora.
    doc.setFontSize(16);
    doc.text('Bitácora de incidentes', 14, 15);

    // Metadatos: fecha de exportación y filtros aplicados.
    doc.setFontSize(10);
    doc.text(`Exportado: ${new Date().toLocaleString('es-MX')}`, 14, 22);
    if (filtros) {
      doc.text(`Filtros: ${filtros}`, 14, 28);
    }

    // Construcción de la tabla con las 10 columnas (celdas ya formateadas).
    const body = buildBitacoraRows(rows);

    // El plugin autoTable puede exponerse como método de instancia o como
    // función independiente sobre el módulo `window.jspdf`; se soportan ambas.
    const autoTableOptions = {
      startY: 35,
      head: [BITACORA_COLUMNS],
      body,
      styles: { fontSize: 8, cellPadding: 2 },
      // Columnas anchas: Descripción (índice 4) y Solución aplicada (índice 9).
      columnStyles: { 4: { cellWidth: 45 }, 9: { cellWidth: 45 } },
    };

    if (typeof doc.autoTable === 'function') {
      doc.autoTable(autoTableOptions);
    } else if (typeof window.jspdf?.autoTable === 'function') {
      window.jspdf.autoTable(doc, autoTableOptions);
    } else {
      throw new Error('El generador de tablas del PDF no está disponible.');
    }

    // Nombre de archivo: bitacora_YYYYMMDD.pdf
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    doc.save(`bitacora_${stamp}.pdf`);

    return { ok: true, error: null };
  } catch (error) {
    // Mostrar mensaje de error sin alterar los datos en pantalla (Req. 4.8).
    const message =
      'La exportación no pudo completarse. Los datos permanecen disponibles en pantalla.';
    showErrorMessage(message);
    console.error('[bitacora] Error exportando PDF:', error);
    return { ok: false, error: message };
  }
}
