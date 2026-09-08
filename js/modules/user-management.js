/**
 * user-management.js
 * Módulo de gestión de usuarios del lado cliente (rol Admin).
 *
 * Responsabilidades:
 *   - Listar usuarios (User/Agent) de forma paginada y renderizar la tabla
 *     (listUsers).
 *   - Bloquear o desbloquear una cuenta actualizando el campo is_active
 *     (blockUser / unblockUser).
 *   - Eliminar permanentemente una cuenta previa confirmación (deleteUser).
 *
 * Nota de arquitectura y seguridad:
 *   - Todas las operaciones se realizan a través de la Edge Function
 *     `admin-user-management`, que aplica el pipeline de seguridad autoritativo
 *     (CORS → Auth Guard rol Admin → Rate Limiter → validación) y registra las
 *     acciones en `audit_log`. El cliente NUNCA modifica la tabla `profiles`
 *     directamente; la Edge Function es la única barrera de negocio.
 *   - El JWT de la sesión activa se adjunta automáticamente por el cliente
 *     Supabase al usar `functions.invoke()`.
 *   - Los datos de usuario provenientes del backend se renderizan con
 *     `textContent` (nunca innerHTML) para evitar inyección de HTML/XSS.
 *
 * Requisitos cubiertos: 2.9
 */

import { supabase } from '../config.js';

// ---------------------------------------------------------------------------
// Constantes del módulo
// ---------------------------------------------------------------------------

/** Nombre de la Edge Function que expone la gestión de usuarios. */
const FUNCTION_NAME = 'admin-user-management';

/** Tamaño de página por defecto (debe coincidir con el backend). */
const DEFAULT_PAGE_SIZE = 20;

/** Mapa de rol → sufijo de clase CSS para el badge de rol. */
const ROLE_BADGE_MODIFIER = {
  User: 'role-badge--user',
  Agent: 'role-badge--agent',
  Admin: 'role-badge--admin',
};

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/**
 * Traduce un código de estado HTTP proveniente de la Edge Function a un mensaje
 * específico y claro para el usuario final.
 *
 * @param {number} status - Código HTTP recibido.
 * @param {string} [backendMessage] - Mensaje devuelto por el backend, si existe.
 * @returns {string} Mensaje descriptivo en español.
 */
function messageForHttpStatus(status, backendMessage) {
  switch (status) {
    case 400:
      return backendMessage || 'Los datos enviados no son válidos.';
    case 401:
      return 'Su sesión no es válida o ha expirado. Inicie sesión nuevamente.';
    case 403:
      return (
        backendMessage ||
        'No tiene autorización para realizar esta acción sobre esta cuenta.'
      );
    case 404:
      return backendMessage || 'El usuario solicitado no existe.';
    case 429:
      return 'Ha realizado demasiadas peticiones. Intente nuevamente en unos momentos.';
    default:
      return backendMessage || 'Ocurrió un error al procesar la solicitud.';
  }
}

/**
 * Extrae el código de estado HTTP y el cuerpo JSON del error devuelto por
 * `supabase.functions.invoke()`. El SDK expone el response original (objeto
 * Response de Fetch) en `error.context`.
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
    try {
      // El cuerpo puede leerse una sola vez; se clona para parsear como JSON.
      body = await response.clone().json();
    } catch {
      body = null;
    }
  }

  return { status, body };
}

/**
 * Invoca la Edge Function `admin-user-management` con el método HTTP indicado y
 * normaliza el manejo de errores. El JWT de la sesión activa lo adjunta
 * automáticamente el cliente Supabase.
 *
 * @param {('GET'|'PATCH'|'DELETE')} method - Método HTTP de la petición.
 * @param {object} [options] - Opciones adicionales.
 * @param {object} [options.query] - Parámetros de query (se serializan en la URL).
 * @param {object} [options.body] - Cuerpo JSON de la petición.
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null, status: number|null }>}
 */
async function invokeUserManagement(method, { query, body } = {}) {
  // Se construye el nombre de la función con los parámetros de query, ya que la
  // función soporta GET con paginación (?page=&pageSize=).
  let functionPath = FUNCTION_NAME;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }
    const queryString = params.toString();
    if (queryString) {
      functionPath = `${FUNCTION_NAME}?${queryString}`;
    }
  }

  const invokeOptions = { method };
  if (body !== undefined) {
    invokeOptions.body = body;
  }

  const { data, error } = await supabase.functions.invoke(
    functionPath,
    invokeOptions
  );

  if (error) {
    const { status, body: errorBody } = await parseFunctionError(error);
    return {
      ok: false,
      data: null,
      error: messageForHttpStatus(status, errorBody?.error),
      status,
    };
  }

  return { ok: true, data, error: null, status: 200 };
}

/**
 * Formatea una fecha ISO a un formato legible en español (fecha corta).
 * Si el valor es inválido, retorna una cadena vacía para no romper el render.
 *
 * @param {string} isoDate - Fecha en formato ISO 8601.
 * @returns {string} Fecha formateada o cadena vacía.
 */
function formatDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

/**
 * Crea una celda de tabla (<td>) con texto seguro mediante `textContent`.
 * Usar textContent (nunca innerHTML) evita la inyección de HTML/XSS al
 * renderizar datos de usuario provenientes del backend.
 *
 * @param {string} text - Texto a insertar.
 * @param {string} [className] - Clase CSS opcional para la celda.
 * @returns {HTMLTableCellElement}
 */
function createTextCell(text, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text ?? '';
  return cell;
}

/**
 * Crea un botón de acción para la tabla de usuarios.
 *
 * @param {string} label - Texto del botón.
 * @param {string} className - Clases CSS del botón.
 * @param {Function} onClick - Manejador del evento click.
 * @returns {HTMLButtonElement}
 */
function createActionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// ---------------------------------------------------------------------------
// Renderizado de la tabla de usuarios
// ---------------------------------------------------------------------------

/**
 * Construye la fila (<tr>) de un usuario con sus columnas y botones de acción.
 * Los datos se insertan con textContent para evitar XSS. Los botones de acción
 * (bloquear/desbloquear/eliminar) actualizan la UI in situ tras completarse la
 * operación, sin recargar la página.
 *
 * @param {object} user - Registro de usuario del backend:
 *   { id, full_name, email, role, is_active, created_at }
 * @param {object} handlers - Callbacks para refrescar la lista tras una acción.
 * @param {Function} handlers.onChanged - Se invoca tras bloquear/desbloquear/eliminar.
 * @returns {HTMLTableRowElement}
 */
function buildUserRow(user, handlers) {
  const row = document.createElement('tr');
  row.dataset.userId = user.id;

  // Columna: nombre
  row.appendChild(createTextCell(user.full_name));

  // Columna: email
  row.appendChild(createTextCell(user.email));

  // Columna: rol (badge con clase según el rol)
  const roleCell = document.createElement('td');
  const roleBadge = document.createElement('span');
  const roleModifier = ROLE_BADGE_MODIFIER[user.role] || '';
  roleBadge.className = `role-badge ${roleModifier}`.trim();
  roleBadge.textContent = user.role ?? '';
  roleCell.appendChild(roleBadge);
  row.appendChild(roleCell);

  // Columna: estado de la cuenta (activo / bloqueado)
  const statusCell = document.createElement('td');
  const statusBadge = document.createElement('span');
  const isActive = user.is_active !== false;
  statusBadge.className = isActive
    ? 'account-status account-status--active'
    : 'account-status account-status--blocked';
  statusBadge.textContent = isActive ? 'Activo' : 'Bloqueado';
  statusCell.appendChild(statusBadge);
  row.appendChild(statusCell);

  // Columna: fecha de registro
  row.appendChild(createTextCell(formatDate(user.created_at)));

  // Columna: acciones (bloquear/desbloquear y eliminar)
  const actionsCell = document.createElement('td');
  const actions = document.createElement('div');
  actions.className = 'user-actions';

  // Botón bloquear/desbloquear según el estado actual.
  const toggleLabel = isActive ? 'Bloquear' : 'Desbloquear';
  const toggleButton = createActionButton(
    toggleLabel,
    'btn btn--sm btn--secondary',
    async () => {
      toggleButton.disabled = true;
      const result = isActive
        ? await blockUser(user.id)
        : await unblockUser(user.id);
      toggleButton.disabled = false;

      if (!result.ok) {
        showActionError(result.error);
        return;
      }
      // Refrescar la lista para reflejar el nuevo estado sin recargar la página.
      handlers.onChanged();
    }
  );
  actions.appendChild(toggleButton);

  // Botón eliminar (con confirmación previa dentro de deleteUser).
  const deleteButton = createActionButton(
    'Eliminar',
    'btn btn--sm btn--danger',
    async () => {
      deleteButton.disabled = true;
      const result = await deleteUser(user.id, user.full_name);
      // Si el usuario canceló la confirmación, no se hace nada.
      if (result.cancelled) {
        deleteButton.disabled = false;
        return;
      }
      if (!result.ok) {
        deleteButton.disabled = false;
        showActionError(result.error);
        return;
      }
      // Actualizar la lista tras eliminar.
      handlers.onChanged();
    }
  );
  actions.appendChild(deleteButton);

  actionsCell.appendChild(actions);
  row.appendChild(actionsCell);

  return row;
}

/**
 * Muestra un mensaje de error de acción en el contenedor dedicado, si existe.
 * No se ocultan errores silenciosamente: si no hay contenedor, se registra en
 * consola para facilitar el diagnóstico.
 *
 * @param {string} message - Mensaje de error a mostrar.
 */
function showActionError(message) {
  const errorContainer = document.getElementById('user-management-error');
  if (errorContainer) {
    errorContainer.textContent = message;
    errorContainer.hidden = false;
  } else {
    console.error('[user-management]', message);
  }
}

/**
 * Renderiza la tabla completa de usuarios dentro del contenedor indicado.
 * Reconstruye la tabla desde cero en cada llamada para reflejar el estado
 * actual (por ejemplo, tras bloquear o eliminar una cuenta).
 *
 * @param {object[]} users - Lista de usuarios a renderizar.
 * @param {object} pagination - Metadatos de paginación { page, pageSize, total, totalPages }.
 * @param {HTMLElement} container - Elemento donde se inserta la tabla.
 * @param {Function} onChanged - Callback para refrescar tras una acción.
 */
function renderUsersTable(users, pagination, container, onChanged) {
  // Limpiar el contenido previo del contenedor de forma segura.
  container.replaceChildren();

  // Contenedor de errores de acción (bloquear/desbloquear/eliminar).
  const errorBox = document.createElement('div');
  errorBox.id = 'user-management-error';
  errorBox.className = 'form-error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  container.appendChild(errorBox);

  if (!users || users.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No hay usuarios para mostrar.';
    container.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';

  // Encabezado de la tabla.
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = ['Nombre', 'Email', 'Rol', 'Estado', 'Fecha de registro', 'Acciones'];
  for (const headerText of headers) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = headerText;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Cuerpo de la tabla con una fila por usuario.
  const tbody = document.createElement('tbody');
  for (const user of users) {
    tbody.appendChild(buildUserRow(user, { onChanged }));
  }
  table.appendChild(tbody);

  container.appendChild(table);

  // Información de paginación (si el backend la proporcionó).
  if (pagination && typeof pagination.total === 'number') {
    const info = document.createElement('p');
    info.className = 'pagination__info';
    const { page, totalPages, total } = pagination;
    info.textContent = `Página ${page} de ${totalPages} — ${total} usuario(s) en total.`;
    container.appendChild(info);
  }
}

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

/**
 * Obtiene el listado paginado de usuarios (User/Agent) invocando la Edge
 * Function `admin-user-management` (GET) y lo renderiza en la tabla.
 *
 * Si se proporciona un contenedor, la tabla se renderiza con columnas: nombre,
 * email, rol, estado (activo/bloqueado) y fecha de registro, más los botones de
 * acción. Los datos se insertan con textContent para evitar XSS.
 *
 * @param {number} [page=1] - Número de página a solicitar (>= 1).
 * @param {HTMLElement} [container] - Contenedor donde renderizar la tabla.
 *   Si se omite, solo se retornan los datos sin renderizar.
 * @returns {Promise<{ ok: boolean, data: object[], pagination: object|null, error: string|null }>}
 */
export async function listUsers(page = 1, container) {
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;

  const result = await invokeUserManagement('GET', {
    query: { page: safePage, pageSize: DEFAULT_PAGE_SIZE },
  });

  if (!result.ok) {
    // Mostrar el error en el contenedor si está disponible.
    if (container) {
      container.replaceChildren();
      const errorEl = document.createElement('p');
      errorEl.className = 'form-error';
      errorEl.setAttribute('role', 'alert');
      errorEl.textContent = result.error;
      container.appendChild(errorEl);
    }
    return { ok: false, data: [], pagination: null, error: result.error };
  }

  const users = result.data?.data ?? [];
  const pagination = result.data?.pagination ?? null;

  if (container) {
    // El callback onChanged recarga la página actual para reflejar los cambios
    // (bloqueo/desbloqueo/eliminación) sin recargar toda la página del navegador.
    renderUsersTable(users, pagination, container, () => {
      const currentPage = pagination?.page ?? safePage;
      listUsers(currentPage, container);
    });
  }

  return { ok: true, data: users, pagination, error: null };
}

// ---------------------------------------------------------------------------
// blockUser / unblockUser
// ---------------------------------------------------------------------------

/**
 * Bloquea una cuenta de usuario (is_active = false) invocando PATCH sobre la
 * Edge Function. El backend rechaza (HTTP 403) el bloqueo de cuentas Admin.
 *
 * @param {string} userId - UUID del usuario a bloquear.
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null, status: number|null }>}
 */
export async function blockUser(userId) {
  if (!userId) {
    return { ok: false, data: null, error: 'Identificador de usuario ausente.', status: null };
  }
  return invokeUserManagement('PATCH', {
    body: { user_id: userId, is_active: false },
  });
}

/**
 * Desbloquea una cuenta de usuario (is_active = true) invocando PATCH sobre la
 * Edge Function.
 *
 * @param {string} userId - UUID del usuario a desbloquear.
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null, status: number|null }>}
 */
export async function unblockUser(userId) {
  if (!userId) {
    return { ok: false, data: null, error: 'Identificador de usuario ausente.', status: null };
  }
  return invokeUserManagement('PATCH', {
    body: { user_id: userId, is_active: true },
  });
}

// ---------------------------------------------------------------------------
// deleteUser
// ---------------------------------------------------------------------------

/**
 * Elimina permanentemente una cuenta de usuario (rol User o Agent) invocando
 * DELETE sobre la Edge Function, previa confirmación en la UI.
 *
 * La confirmación se solicita mediante `window.confirm`. Si el usuario cancela,
 * se retorna `{ cancelled: true }` sin invocar el backend. El backend rechaza
 * (HTTP 403) la eliminación de cuentas Admin.
 *
 * @param {string} userId - UUID del usuario a eliminar.
 * @param {string} [displayName] - Nombre a mostrar en el mensaje de confirmación.
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, data: object|null, error: string|null, status: number|null }>}
 */
export async function deleteUser(userId, displayName) {
  if (!userId) {
    return { ok: false, data: null, error: 'Identificador de usuario ausente.', status: null };
  }

  // Confirmación previa en la UI. Se usa el nombre si está disponible.
  const label = displayName ? `"${displayName}"` : 'esta cuenta';
  const confirmed = window.confirm(
    `¿Está seguro de eliminar ${label}? Esta acción es permanente y no se puede deshacer.`
  );

  if (!confirmed) {
    return { ok: false, cancelled: true, data: null, error: null, status: null };
  }

  return invokeUserManagement('DELETE', {
    body: { user_id: userId },
  });
}
