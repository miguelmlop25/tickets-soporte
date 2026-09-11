/**
 * validators.js
 * Módulo de validación y sanitización del lado cliente.
 *
 * Responsabilidades:
 *   - Validar el dominio corporativo del correo electrónico.
 *   - Validar los requisitos de seguridad de la contraseña.
 *   - Sanitizar texto libre eliminando HTML, scripts y patrones peligrosos.
 *   - Validar los campos del formulario de creación de ticket.
 *   - Validar el comentario de solución aplicada.
 *
 * Nota de seguridad: la validación en el cliente es una capa de conveniencia
 * para el usuario. La validación y sanitización autoritativa se realiza en el
 * backend (Edge Functions). Este módulo replica las mismas reglas para dar
 * retroalimentación inmediata sin depender de una petición al servidor.
 *
 * Requisitos cubiertos: 1.1, 1.2, 1.3, 3.4, 5.9, 11.6
 */

// ---------------------------------------------------------------------------
// Constantes del dominio
// ---------------------------------------------------------------------------

/**
 * Dominios corporativos permitidos para el registro de cuentas.
 * Para agregar o quitar dominios, edite unicamente esta lista. La validacion
 * del backend (trigger handle_new_user, migracion 007) debe reflejar los mismos
 * dominios para mantener la coherencia entre cliente y servidor.
 */
export const CORPORATE_DOMAINS = ['@solucionesteneria.com', '@rbpuebla.mx'];

/**
 * Dominio corporativo principal. Se conserva por compatibilidad con codigo que
 * pudiera importarlo; la validacion real usa la lista CORPORATE_DOMAINS.
 */
export const CORPORATE_DOMAIN = CORPORATE_DOMAINS[0];

/** Longitud mínima requerida para la contraseña. */
const MIN_PASSWORD_LENGTH = 8;

/** Longitud mínima y máxima del comentario de solución aplicada. */
const MIN_SOLUTION_LENGTH = 10;
const MAX_SOLUTION_LENGTH = 1000;

/** Longitud máxima de la descripción del problema tras sanitización. */
const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * Mapa de subcategorías válidas por categoría.
 * Es la fuente de verdad del cliente y refleja el mismo mapa usado por la
 * Edge Function `create-ticket` en el backend.
 */
export const SUBCATEGORIAS = {
  SOFTWARE: [
    'instalación de S.O.',
    'Instalación de Programa(s)',
    'Configuración estándar por área',
    'Configuración de Software',
    'Reconfiguración de Software',
    'Actualización de Software',
    'Error de Software',
    'Formateo de Equipo',
    'Licenciamientos',
    'Funcionamientos',
    'Controladores',
    'Capacitación de usuario',
    'Copiar Inf. A Disp. De Alm.',
  ],
  HARDWARE: [
    'Revisión de equipo',
    'Cambio de pieza',
    'Inventario',
    'Ponchado de Cable/Red',
    'Otro',
    'Descripción',
    'Re asignación',
    'Asignación',
    'Componentes',
    'Teclado',
    'Mouse',
    'Cámara',
    'Batería',
    'Puertos',
    'Display',
    'Capacitación usuarios',
    'D.D. Lleno',
    'Todas las anteriores',
  ],
  CONFIGURACIONES: [
    'Malware',
    'Licencias',
    'VPN',
    'CORREO',
    'Reinicio Servidor',
    'Revisión Servidor',
    'Apagado de Servidor',
    'Escritorio Remoto',
    'Nuevo usuario',
  ],
  SEGURIDAD: [
    'Respaldo de Información',
    'SharePoint',
    'Acces Point',
    'USB',
    'Recuperación de Información',
    'Virus',
    'Liberación IP',
    'Desbloqueos',
    'Sitios Web',
    'Robos',
  ],
  TELECOMUNICACIONES: [
    'Acceso Internet',
    'ETH/WL',
    'Telefonía IP',
    'Clik Clickshare',
    'Poly',
    'Nodos',
  ],
};

/** Áreas válidas para el campo 'area' del ticket (Requisito 4.2.1). */
export const VALID_AREAS = [
  'Administracion',
  'Auditoria',
  'Auditoria IMSS',
  'BPO Others',
  'Consultoria',
  'Contabilidad',
  'Eduacion Continua',
  'General',
  'Impuestos',
  'Mercadotecnia',
  'Nominas',
  'Precios T',
  'RH',
  'Sistemas TI',
  'SOCIOS',
];

/** Tipos de asistencia válidos (Requisito 4.2.2). */
export const VALID_TIPOS_ASISTENCIA = [
  'Asistencia remota',
  'Correo',
  'Llamada',
  'Presencial',
];

/** Categorías válidas (Requisito 4.2.3). */
export const VALID_CATEGORIAS = Object.keys(SUBCATEGORIAS);

// ---------------------------------------------------------------------------
// Validación de correo electrónico
// ---------------------------------------------------------------------------

/**
 * Valida que el correo pertenezca al dominio corporativo permitido.
 *
 * La comparación del dominio es insensible a mayúsculas/minúsculas, pero se
 * exige una estructura básica de correo (parte local no vacía antes de la @).
 *
 * @param {string} email - Correo electrónico a validar.
 * @returns {{ isValid: boolean, error: (string|null) }}
 *          Resultado con `isValid` y un `error` descriptivo cuando corresponde.
 */
export function validateEmail(email) {
  const MESSAGE =
    'Por favor ingrese un correo corporativo válido para la creación de su cuenta';

  // Rechazar entradas ausentes o de tipo incorrecto.
  if (typeof email !== 'string') {
    return { isValid: false, error: MESSAGE };
  }

  const normalized = email.trim();

  // Debe existir una única @ con parte local no vacía antes del dominio.
  const atIndex = normalized.indexOf('@');
  const localPart = atIndex > 0 ? normalized.slice(0, atIndex) : '';
  const hasSingleAt = normalized.indexOf('@') === normalized.lastIndexOf('@');

  // La parte local no debe contener espacios en blanco internos.
  const localIsValid = localPart.length > 0 && !/\s/.test(localPart);

  // El dominio debe coincidir (case-insensitive) con alguno de los dominios
  // corporativos permitidos.
  const normalizedLower = normalized.toLowerCase();
  const endsWithDomain = CORPORATE_DOMAINS.some((dominio) =>
    normalizedLower.endsWith(dominio.toLowerCase()),
  );

  const isValid = hasSingleAt && localIsValid && endsWithDomain;

  return {
    isValid,
    error: isValid ? null : MESSAGE,
  };
}

// ---------------------------------------------------------------------------
// Validación de contraseña
// ---------------------------------------------------------------------------

/**
 * Valida que la contraseña cumpla simultáneamente todos los requisitos de
 * seguridad: longitud >= 8, al menos una minúscula, una mayúscula, un dígito
 * y un carácter especial (no alfanumérico).
 *
 * @param {string} password - Contraseña a validar.
 * @returns {{ isValid: boolean, errors: string[] }}
 *          `isValid` es true solo si `errors` está vacío.
 */
export function validatePassword(password) {
  const errors = [];

  // Una entrada no textual no cumple ningún requisito.
  if (typeof password !== 'string') {
    return {
      isValid: false,
      errors: ['La contraseña es obligatoria.'],
    };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(
      `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    );
  }
  if (!/[a-z]/.test(password)) {
    errors.push('La contraseña debe incluir al menos una letra minúscula.');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('La contraseña debe incluir al menos una letra mayúscula.');
  }
  if (!/\d/.test(password)) {
    errors.push('La contraseña debe incluir al menos un dígito.');
  }
  // Carácter especial: cualquier carácter que no sea letra ni dígito.
  if (!/[^a-zA-Z0-9]/.test(password)) {
    errors.push('La contraseña debe incluir al menos un carácter especial.');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Sanitización de texto
// ---------------------------------------------------------------------------

/**
 * Sanitiza texto libre eliminando etiquetas HTML, scripts y patrones
 * potencialmente peligrosos. Replica la lógica del backend para mantener
 * coherencia entre cliente y servidor.
 *
 * Garantía de idempotencia (Property 4): aplicar `sanitizeText` una o más
 * veces sobre el mismo texto produce siempre el mismo resultado. Cada regla de
 * reemplazo opera sobre un patrón que no puede reaparecer a partir de su propia
 * salida, y el recorte final (`trim`) es idempotente.
 *
 * @param {string} text - Texto de entrada sin sanitizar.
 * @returns {string} Texto sanitizado.
 */
export function sanitizeText(text) {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    // Eliminar etiquetas HTML completas (incluyendo self-closing).
    .replace(/<[^>]*>/g, '')
    // Eliminar cualquier carácter '<' o '>' residual (etiquetas mal formadas).
    .replace(/[<>]/g, '')
    // Eliminar el prefijo peligroso javascript: usado en URIs/atributos.
    .replace(/javascript\s*:/gi, '')
    // Eliminar manejadores de eventos inline (p.ej. onerror=, onclick=).
    .replace(/\bon\w+\s*=/gi, '')
    // Eliminar entidades HTML numéricas hexadecimales (&#xXX;).
    .replace(/&#x[0-9a-fA-F]+;?/gi, '')
    // Eliminar entidades HTML numéricas decimales (&#NN;).
    .replace(/&#\d+;?/g, '')
    // Recortar espacios al inicio y al final.
    .trim();
}

// ---------------------------------------------------------------------------
// Validación de campos del ticket
// ---------------------------------------------------------------------------

/**
 * Valida todos los campos del formulario de creación de ticket contra las
 * opciones predefinidas y sanitiza la descripción.
 *
 * Campos esperados en `data`:
 *   - area            (obligatorio, debe estar en VALID_AREAS)
 *   - tipo_asistencia (obligatorio, debe estar en VALID_TIPOS_ASISTENCIA)
 *   - categoria       (obligatorio, debe estar en VALID_CATEGORIAS)
 *   - subcategoria    (obligatorio, debe pertenecer a la categoría elegida)
 *   - descripcion     (obligatorio, 1–1000 chars tras sanitización)
 *   - agente_asignado (opcional)
 *
 * @param {object} data - Datos del formulario de ticket.
 * @returns {{ isValid: boolean, errors: Object<string,string>, sanitized: object }}
 *          `errors` mapea el nombre del campo con error a su mensaje.
 *          `sanitized` contiene los valores normalizados/sanitizados.
 */
export function validateTicketFields(data) {
  const errors = {};
  const sanitized = {};

  // Un payload ausente o no objeto se considera enteramente inválido.
  const input = data && typeof data === 'object' ? data : {};

  // --- Área ---
  const area = typeof input.area === 'string' ? input.area.trim() : '';
  if (!area) {
    errors.area = 'El área es obligatoria.';
  } else if (!VALID_AREAS.includes(area)) {
    errors.area = 'El área seleccionada no es válida.';
  } else {
    sanitized.area = area;
  }

  // --- Tipo de asistencia ---
  const tipoAsistencia =
    typeof input.tipo_asistencia === 'string'
      ? input.tipo_asistencia.trim()
      : '';
  if (!tipoAsistencia) {
    errors.tipo_asistencia = 'El tipo de asistencia es obligatorio.';
  } else if (!VALID_TIPOS_ASISTENCIA.includes(tipoAsistencia)) {
    errors.tipo_asistencia = 'El tipo de asistencia seleccionado no es válido.';
  } else {
    sanitized.tipo_asistencia = tipoAsistencia;
  }

  // --- Categoría ---
  const categoria =
    typeof input.categoria === 'string' ? input.categoria.trim() : '';
  if (!categoria) {
    errors.categoria = 'La categoría es obligatoria.';
  } else if (!VALID_CATEGORIAS.includes(categoria)) {
    errors.categoria = 'La categoría seleccionada no es válida.';
  } else {
    sanitized.categoria = categoria;
  }

  // --- Subcategoría (depende de la categoría) ---
  const subcategoria =
    typeof input.subcategoria === 'string' ? input.subcategoria.trim() : '';
  if (!subcategoria) {
    errors.subcategoria = 'La subcategoría es obligatoria.';
  } else if (!categoria || !VALID_CATEGORIAS.includes(categoria)) {
    // Sin una categoría válida no es posible validar la subcategoría.
    errors.subcategoria =
      'Seleccione una categoría válida antes de la subcategoría.';
  } else if (!SUBCATEGORIAS[categoria].includes(subcategoria)) {
    errors.subcategoria =
      'La subcategoría no corresponde a la categoría seleccionada.';
  } else {
    sanitized.subcategoria = subcategoria;
  }

  // --- Descripción (sanitizada y con límite de longitud) ---
  const descripcion = sanitizeText(
    typeof input.descripcion === 'string' ? input.descripcion : '',
  );
  if (descripcion.length < 1) {
    errors.descripcion = 'La descripción del problema es obligatoria.';
  } else if (descripcion.length > MAX_DESCRIPTION_LENGTH) {
    errors.descripcion = `La descripción no puede superar ${MAX_DESCRIPTION_LENGTH} caracteres.`;
  } else {
    sanitized.descripcion = descripcion;
  }

  // --- Agente asignado (opcional) ---
  if (input.agente_asignado) {
    sanitized.agente_asignado = String(input.agente_asignado).trim();
  } else {
    sanitized.agente_asignado = null;
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    sanitized,
  };
}

// ---------------------------------------------------------------------------
// Validación del comentario de solución aplicada
// ---------------------------------------------------------------------------

/**
 * Valida el comentario de solución aplicada al resolver un ticket.
 * El texto se sanitiza y luego se verifica que su longitud esté entre 10 y
 * 1000 caracteres (Requisitos 5.6, 5.7, 5.9).
 *
 * @param {string} text - Comentario de solución sin sanitizar.
 * @returns {{ isValid: boolean, error: (string|null), sanitized: string }}
 */
export function validateSolution(text) {
  const sanitized = sanitizeText(typeof text === 'string' ? text : '');

  if (sanitized.length < MIN_SOLUTION_LENGTH) {
    return {
      isValid: false,
      error: `La solución debe tener al menos ${MIN_SOLUTION_LENGTH} caracteres.`,
      sanitized,
    };
  }
  if (sanitized.length > MAX_SOLUTION_LENGTH) {
    return {
      isValid: false,
      error: `La solución no puede superar ${MAX_SOLUTION_LENGTH} caracteres.`,
      sanitized,
    };
  }

  return { isValid: true, error: null, sanitized };
}
