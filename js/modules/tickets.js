/**
 * tickets.js
 * Módulo de gestión de tickets del lado cliente.
 *
 * Responsabilidades:
 *   - Crear tickets invocando la Edge Function `create-ticket`.
 *   - Consultar los tickets propios del User (getMyTickets).
 *   - Consultar todos los tickets para Agent/Admin (getAllTickets).
 *   - Actualizar un ticket propio del User en estado editable (updateTicket).
 *   - Eliminar un ticket validando estado y rol (deleteTicket).
 *
 * Nota de arquitectura y seguridad:
 *   - La creación de tickets se realiza a través de una Edge Function porque
 *     involucra lógica de negocio que no puede ejecutarse en el cliente
 *     (generación atómica del número SSP-XXXX, registro en audit_log,
 *     notificaciones a los Agents). El JWT del usuario se adjunta
 *     automáticamente por el cliente Supabase al usar `functions.invoke()`.
 *   - Las lecturas (getMyTickets, getAllTickets) son consultas directas a la
 *     base de datos. El aislamiento de datos NO depende de estos filtros del
 *     cliente sino de las políticas de Row Level Security (RLS) definidas en la
 *     base de datos (Requisito 10.6). Los filtros aquí son de conveniencia y
 *     nunca amplían la visibilidad más allá de lo que RLS permite.
 *
 * Nota de extensibilidad:
 *   La tarea 16.1 extenderá este módulo con la lógica de transición de estados
 *   (acceptTicket, resolveTicket, canAgentAccept). Por ello el módulo expone
 *   utilidades reutilizables (invokeEdgeFunction, SELECT_WITH_PROFILES) y
 *   mantiene un estilo homogéneo de manejo de errores que dichas funciones
 *   podrán reutilizar sin duplicar lógica.
 *
 * Requisitos cubiertos: 3.1, 4.1, 4.2, 4.5, 7.6, 7.7
 */

import { supabase } from '../config.js';
import { validateSolution } from './validators.js';

// ---------------------------------------------------------------------------
// Constantes del módulo
// ---------------------------------------------------------------------------

/**
 * Estados (Status) en los que un User puede editar su propio ticket.
 * Coincide con la política RLS `tickets_user_update` del backend.
 * Requisito 7.6.
 */
const USER_EDITABLE_STATUSES = ['Pendiente', 'En proceso'];

/**
 * Campos del ticket que un User tiene permitido modificar al editar.
 * Se restringe explícitamente para impedir que el cliente altere columnas
 * sensibles (status, estado, agent_id, ticket_number, fechas, etc.), aunque
 * la RLS y los triggers del backend son la barrera de seguridad autoritativa.
 */
const USER_UPDATABLE_FIELDS = [
  'area',
  'tipo_asistencia',
  'categoria',
  'subcategoria',
  'descripcion',
  'agente_asignado',
];

/**
 * Proyección de columnas para consultas con join a `profiles`, usada por
 * getAllTickets para resolver el nombre del User creador y del Agent asignado.
 * Los alias `creator` y `agent` referencian las claves foráneas
 * tickets.user_id y tickets.agent_id respectivamente.
 */
const SELECT_WITH_PROFILES = `
  *,
  creator:profiles!tickets_user_id_fkey ( id, full_name, email ),
  agent:profiles!tickets_agent_id_fkey ( id, full_name, email )
`;

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/**
 * Traduce un código de estado HTTP proveniente de una Edge Function a un
 * mensaje específico y claro para el usuario final.
 *
 * @param {number} status - Código HTTP recibido de la Edge Function.
 * @param {string} [backendMessage] - Mensaje devuelto por el backend, si existe.
 * @returns {string} Mensaje descriptivo en español.
 */
function messageForHttpStatus(status, backendMessage) {
  switch (status) {
    case 400:
      // El backend suele indicar el campo específico con error; se prioriza.
      return backendMessage || 'Los datos enviados no son válidos.';
    case 401:
      return 'Su sesión no es válida o ha expirado. Inicie sesión nuevamente.';
    case 403:
      return 'No tiene autorización para realizar esta acción.';
    case 503:
      return (
        backendMessage ||
        'El servicio no está disponible temporalmente. Intente más tarde.'
      );
    default:
      return backendMessage || 'Ocurrió un error al procesar la solicitud.';
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
    // El cuerpo puede leerse una sola vez; se intenta parsear como JSON.
    try {
      body = await response.clone().json();
    } catch {
      body = null;
    }
  }

  return { status, body };
}

/**
 * Invoca una Edge Function adjuntando automáticamente el JWT de la sesión
 * activa (lo hace el cliente Supabase) y normaliza el manejo de errores HTTP.
 *
 * Esta utilidad es compartida: la extensión de la tarea 16.1 (acceptTicket,
 * resolveTicket) la reutilizará para invocar `update-ticket-status` y
 * `resolve-ticket` con el mismo tratamiento de errores.
 *
 * @param {string} functionName - Nombre de la Edge Function a invocar.
 * @param {object} payload - Cuerpo JSON de la petición.
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null, status: number|null }>}
 */
export async function invokeEdgeFunction(functionName, payload) {
  const { data, error } = await supabase.functions.invoke(functionName, {
    body: payload,
  });

  if (error) {
    const { status, body } = await parseFunctionError(error);
    return {
      ok: false,
      data: null,
      error: messageForHttpStatus(status, body?.error),
      status,
    };
  }

  return { ok: true, data, error: null, status: 200 };
}

/**
 * Aplica los filtros opcionales comunes de tickets a un query builder de
 * Supabase. Reutilizado por getMyTickets y getAllTickets para evitar
 * duplicación.
 *
 * Filtros soportados:
 *   - status       → columna `status`
 *   - estado       → columna `estado`
 *   - categoria    → columna `categoria`
 *   - fecha_desde  → `fecha_creacion >= fecha_desde`
 *   - fecha_hasta  → `fecha_creacion <= fecha_hasta`
 *
 * @param {object} query - Query builder de Supabase (postgrest).
 * @param {object} [filters] - Objeto con filtros opcionales.
 * @returns {object} El query builder con los filtros aplicados.
 */
function applyTicketFilters(query, filters) {
  if (!filters || typeof filters !== 'object') {
    return query;
  }

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.estado) {
    query = query.eq('estado', filters.estado);
  }
  if (filters.categoria) {
    query = query.eq('categoria', filters.categoria);
  }
  if (filters.fecha_desde) {
    query = query.gte('fecha_creacion', filters.fecha_desde);
  }
  if (filters.fecha_hasta) {
    query = query.lte('fecha_creacion', filters.fecha_hasta);
  }

  return query;
}

// ---------------------------------------------------------------------------
// createTicket
// ---------------------------------------------------------------------------

/**
 * Crea un nuevo ticket invocando la Edge Function `create-ticket`.
 *
 * El JWT del usuario autenticado se adjunta automáticamente por el cliente
 * Supabase. El backend valida el rol (solo User), sanitiza la descripción,
 * genera el número SSP-XXXX y registra la auditoría de forma atómica.
 *
 * Manejo de errores HTTP con mensajes específicos:
 *   - 400: datos de formulario inválidos (se conserva el mensaje del campo).
 *   - 401: sesión inválida o expirada.
 *   - 403: el rol del usuario no tiene permiso para crear tickets.
 *   - 503: se alcanzó el límite máximo de tickets del sistema (SSP-9999).
 *
 * @param {object} ticketData - Datos del ticket. Campos esperados:
 *   { area, tipo_asistencia, categoria, subcategoria, descripcion, agente_asignado? }
 * @returns {Promise<{ ok: boolean, data: {ticket_id: string, ticket_number: string}|null, error: string|null, status: number|null }>}
 */
export async function createTicket(ticketData) {
  return invokeEdgeFunction('create-ticket', ticketData);
}

// ---------------------------------------------------------------------------
// getMyTickets
// ---------------------------------------------------------------------------

/**
 * Consulta los tickets del User autenticado mediante una consulta directa a la
 * base de datos. RLS garantiza que solo se devuelvan los tickets cuyo
 * `user_id` coincide con el usuario autenticado (Requisitos 4.1, 10.6).
 *
 * Los filtros son opcionales y de conveniencia; nunca amplían la visibilidad
 * más allá de lo que RLS permite (Requisito 4.4).
 *
 * @param {object} [filters] - Filtros opcionales:
 *   { status, estado, categoria, fecha_desde, fecha_hasta }
 * @returns {Promise<{ ok: boolean, data: object[], error: string|null }>}
 */
export async function getMyTickets(filters) {
  let query = supabase
    .from('tickets')
    .select('*')
    .order('fecha_creacion', { ascending: false });

  query = applyTicketFilters(query, filters);

  const { data, error } = await query;

  if (error) {
    console.error('[tickets] Error al consultar getMyTickets:', error);
    return {
      ok: false,
      data: [],
      error: 'No fue posible cargar sus tickets. Intente nuevamente.',
    };
  }

  return { ok: true, data: data ?? [], error: null };
}

// ---------------------------------------------------------------------------
// getAllTickets
// ---------------------------------------------------------------------------

/**
 * Consulta todos los tickets visibles para el usuario autenticado (Agent o
 * Admin) mediante una consulta directa con joins a `profiles` para resolver el
 * nombre del User creador y del Agent asignado (Requisito 4.5).
 *
 * La visibilidad real está gobernada por RLS:
 *   - Agent: ve sus tickets asignados y los tickets sin asignar.
 *   - Admin: ve todos los tickets del sistema.
 *
 * @param {object} [filters] - Filtros opcionales:
 *   { status, estado, categoria, fecha_desde, fecha_hasta, agent_id, user_id }
 * @returns {Promise<{ ok: boolean, data: object[], error: string|null }>}
 */
export async function getAllTickets(filters) {
  let query = supabase
    .from('tickets')
    .select(SELECT_WITH_PROFILES)
    .order('fecha_creacion', { ascending: false });

  query = applyTicketFilters(query, filters);

  // Filtros adicionales disponibles para Agent/Admin.
  if (filters && typeof filters === 'object') {
    if (filters.agent_id) {
      query = query.eq('agent_id', filters.agent_id);
    }
    if (filters.user_id) {
      query = query.eq('user_id', filters.user_id);
    }
  }

  const { data, error } = await query;

  if (error) {
    console.error('[tickets] Error al consultar getAllTickets:', error);
    return {
      ok: false,
      data: [],
      error: 'No fue posible cargar los tickets. Intente nuevamente.',
    };
  }

  return { ok: true, data: data ?? [], error: null };
}

// ---------------------------------------------------------------------------
// updateTicket
// ---------------------------------------------------------------------------

/**
 * Actualiza los datos de un ticket propio del User. Solo se permite cuando el
 * ticket está en estado 'Pendiente' o 'En proceso' (Requisito 7.6).
 *
 * La verificación autoritativa la realiza la política RLS `tickets_user_update`
 * en la base de datos; aquí se aplica una comprobación previa por conveniencia
 * (evita una petición destinada a fallar) y se restringen los campos
 * modificables a `USER_UPDATABLE_FIELDS`.
 *
 * @param {string} ticketId - UUID del ticket a actualizar.
 * @param {object} data - Campos a modificar (subconjunto de USER_UPDATABLE_FIELDS).
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null }>}
 */
export async function updateTicket(ticketId, data) {
  if (!ticketId) {
    return { ok: false, data: null, error: 'Identificador de ticket ausente.' };
  }
  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      data: null,
      error: 'No se proporcionaron datos para actualizar.',
    };
  }

  // Restringir el payload a los campos que el User puede modificar.
  const payload = {};
  for (const field of USER_UPDATABLE_FIELDS) {
    if (data[field] !== undefined) {
      payload[field] = data[field];
    }
  }

  if (Object.keys(payload).length === 0) {
    return {
      ok: false,
      data: null,
      error: 'No hay campos válidos para actualizar.',
    };
  }

  // Comprobación previa del estado editable (conveniencia; RLS es autoritativa).
  const { data: current, error: fetchError } = await supabase
    .from('tickets')
    .select('status')
    .eq('id', ticketId)
    .single();

  if (fetchError) {
    console.error('[tickets] Error al obtener el ticket a actualizar:', fetchError);
    return {
      ok: false,
      data: null,
      error: 'No fue posible localizar el ticket a actualizar.',
    };
  }

  if (!USER_EDITABLE_STATUSES.includes(current.status)) {
    return {
      ok: false,
      data: null,
      error:
        'Solo es posible editar tickets en estado Pendiente o En proceso.',
    };
  }

  const { data: updated, error } = await supabase
    .from('tickets')
    .update(payload)
    .eq('id', ticketId)
    .select()
    .single();

  if (error) {
    console.error('[tickets] Error al actualizar el ticket:', error);
    return {
      ok: false,
      data: null,
      error: 'No fue posible actualizar el ticket. Intente nuevamente.',
    };
  }

  return { ok: true, data: updated, error: null };
}

// ---------------------------------------------------------------------------
// deleteTicket
// ---------------------------------------------------------------------------

/**
 * Elimina permanentemente un ticket validando el estado permitido según el rol:
 *   - User:  solo puede eliminar tickets en estado 'Pendiente' (Requisito 7.7).
 *   - Agent: solo puede eliminar tickets en estado 'Finalizado' (Requisito 7.8).
 *
 * La política RLS `tickets_user_delete` es la barrera autoritativa; esta
 * función replica la regla del lado cliente para dar retroalimentación
 * inmediata y evitar peticiones destinadas a fallar.
 *
 * Registro de auditoría (Requisito 9.1): la eliminación se registra en
 * `audit_log` con la acción `TICKET_DELETED`. Si el registro de auditoría
 * falla, se aborta antes de eliminar para no dejar la operación sin traza.
 *
 * @param {string} ticketId - UUID del ticket a eliminar.
 * @param {('User'|'Agent'|'Admin')} role - Rol del usuario que solicita la eliminación.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function deleteTicket(ticketId, role) {
  if (!ticketId) {
    return { ok: false, error: 'Identificador de ticket ausente.' };
  }

  // Estado requerido para eliminar según el rol.
  const requiredStatusByRole = {
    User: 'Pendiente',
    Agent: 'Finalizado',
  };

  // Obtener el estado actual del ticket (RLS restringe la visibilidad).
  const { data: current, error: fetchError } = await supabase
    .from('tickets')
    .select('id, status')
    .eq('id', ticketId)
    .single();

  if (fetchError) {
    console.error('[tickets] Error al obtener el ticket a eliminar:', fetchError);
    return {
      ok: false,
      error: 'No fue posible localizar el ticket a eliminar.',
    };
  }

  // Validar el estado permitido para User y Agent. Admin puede eliminar
  // cualquier ticket (según la política RLS `tickets_user_delete`).
  if (role === 'User' || role === 'Agent') {
    const requiredStatus = requiredStatusByRole[role];
    if (current.status !== requiredStatus) {
      const detail =
        role === 'User'
          ? 'Un usuario solo puede eliminar tickets en estado Pendiente.'
          : 'Un agente solo puede eliminar tickets en estado Finalizado.';
      return { ok: false, error: detail };
    }
  } else if (role !== 'Admin') {
    return { ok: false, error: 'No tiene autorización para eliminar tickets.' };
  }

  // Obtener el usuario autenticado para registrar el actor de la auditoría.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      ok: false,
      error: 'Su sesión no es válida o ha expirado. Inicie sesión nuevamente.',
    };
  }

  // Registrar la auditoría ANTES de eliminar. Si falla, se aborta para no
  // dejar la eliminación sin traza (Requisito 9.4: sin cambios parciales).
  const { error: auditError } = await supabase.from('audit_log').insert({
    actor_id: user.id,
    action: 'TICKET_DELETED',
    entity_type: 'ticket',
    entity_id: ticketId,
    metadata: { role, previous_status: current.status },
  });

  if (auditError) {
    console.error('[tickets] Error al registrar la auditoría de eliminación:', auditError);
    return {
      ok: false,
      error: 'No fue posible registrar la auditoría; la eliminación se canceló.',
    };
  }

  // Eliminar el ticket (RLS es la barrera de seguridad autoritativa).
  const { error: deleteError } = await supabase
    .from('tickets')
    .delete()
    .eq('id', ticketId);

  if (deleteError) {
    console.error('[tickets] Error al eliminar el ticket:', deleteError);
    return {
      ok: false,
      error: 'No fue posible eliminar el ticket. Intente nuevamente.',
    };
  }

  return { ok: true, error: null };
}

// ===========================================================================
// Extensión — Máquina de estados de tickets (Tarea 16.1)
// ===========================================================================
//
// Esta sección extiende el módulo con la lógica de transición de estados que
// ejecuta el Agent: aceptar un ticket y resolverlo. Ambas operaciones se
// realizan a través de Edge Functions porque involucran lógica de negocio
// transaccional (cambio de status/estado, ticket_history, audit_log y
// notificaciones) que no puede ejecutarse en el cliente.
//
// Se reutiliza la utilidad compartida `invokeEdgeFunction` para mantener un
// tratamiento de errores HTTP homogéneo, y `validateSolution` (validators.js)
// para validar el comentario de solución antes de enviarlo al backend.
//
// Requisitos cubiertos: 5.1, 5.2, 5.3, 5.6, 5.7
// ---------------------------------------------------------------------------

/**
 * Estado (columna `estado`) en el que un ticket admite la acción ACEPTAR.
 * Solo un ticket en "TICKET PENDIENTE" puede ser aceptado por un Agent
 * (Requisitos 5.1, 5.2).
 */
const ESTADO_ACEPTABLE = 'TICKET PENDIENTE';

// ---------------------------------------------------------------------------
// acceptTicket
// ---------------------------------------------------------------------------

/**
 * Acepta un ticket invocando la Edge Function `update-ticket-status` con la
 * acción 'ACEPTAR'. El backend auto-asigna el ticket si está sin asignar o
 * confirma la recepción si ya está asignado al mismo Agent; en ambos casos
 * cambia el Status a 'En proceso' y el Estado a 'TICKET ACEPTADO'
 * (Requisitos 5.1, 5.2).
 *
 * Manejo de errores HTTP con mensajes descriptivos:
 *   - 403: el ticket está asignado a otro Agent y no está disponible
 *          (Requisito 5.3). Se sobrescribe el mensaje genérico por uno
 *          específico del contexto de aceptación.
 *   - 400/401/503/otros: se delega en `invokeEdgeFunction` el mensaje estándar.
 *
 * @param {string} ticketId - UUID del ticket a aceptar.
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null, status: number|null }>}
 */
export async function acceptTicket(ticketId) {
  if (!ticketId) {
    return {
      ok: false,
      data: null,
      error: 'Identificador de ticket ausente.',
      status: null,
    };
  }

  const result = await invokeEdgeFunction('update-ticket-status', {
    ticket_id: ticketId,
    action: 'ACEPTAR',
  });

  // Mensaje descriptivo específico para el caso 403 en el contexto de aceptar.
  if (!result.ok && result.status === 403) {
    return {
      ...result,
      error:
        'No puede aceptar este ticket porque está asignado a otro agente.',
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// resolveTicket
// ---------------------------------------------------------------------------

/**
 * Resuelve un ticket invocando la Edge Function `resolve-ticket`. Antes de
 * enviar la petición, valida el comentario de solución con `validateSolution`
 * (longitud entre 10 y 1000 caracteres tras sanitización) para dar
 * retroalimentación inmediata y evitar una petición destinada a fallar
 * (Requisitos 5.6, 5.7). La validación autoritativa se repite en el backend.
 *
 * Se envía la solución ya sanitizada por `validateSolution`; el backend vuelve
 * a sanitizar y validar como barrera de seguridad autoritativa.
 *
 * @param {string} ticketId - UUID del ticket a resolver.
 * @param {string} solucion - Comentario con la solución aplicada.
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null, status: number|null }>}
 */
export async function resolveTicket(ticketId, solucion) {
  if (!ticketId) {
    return {
      ok: false,
      data: null,
      error: 'Identificador de ticket ausente.',
      status: null,
    };
  }

  // Validación previa del comentario de solución (Requisitos 5.6, 5.7).
  const validation = validateSolution(solucion);
  if (!validation.isValid) {
    return {
      ok: false,
      data: null,
      error: validation.error,
      status: null,
    };
  }

  return invokeEdgeFunction('resolve-ticket', {
    ticket_id: ticketId,
    solucion_aplicada: validation.sanitized,
  });
}

// ---------------------------------------------------------------------------
// canAgentAccept
// ---------------------------------------------------------------------------

/**
 * Determina si el botón "ACEPTAR" debe mostrarse a un Agent para un ticket
 * dado. Es una regla de UI (Property 12); la autorización real la aplica la
 * Edge Function `update-ticket-status` en el backend.
 *
 * El Agent puede aceptar un ticket cuando:
 *   - el ticket está en estado "TICKET PENDIENTE"  Y
 *   - el ticket no está asignado (agent_id null/ausente)  O
 *     el ticket está asignado a ese mismo Agent (agent_id === agentId).
 *
 * En consecuencia, si el ticket está asignado a otro Agent el botón no se
 * muestra (Requisito 5.3), y si el ticket ya fue aceptado/resuelto tampoco.
 *
 * @param {object} ticket - Ticket a evaluar. Se usan `estado` y `agent_id`.
 * @param {string} agentId - UUID del Agent autenticado.
 * @returns {boolean} true si el botón ACEPTAR debe mostrarse.
 */
export function canAgentAccept(ticket, agentId) {
  // Entradas inválidas: por seguridad, no se muestra el botón.
  if (!ticket || typeof ticket !== 'object' || !agentId) {
    return false;
  }

  // El estado del ticket debe permitir la aceptación.
  if (ticket.estado !== ESTADO_ACEPTABLE) {
    return false;
  }

  // Ticket sin asignar (auto-asignación) o asignado al mismo Agent.
  const assignedAgentId = ticket.agent_id ?? null;
  return assignedAgentId === null || assignedAgentId === agentId;
}
