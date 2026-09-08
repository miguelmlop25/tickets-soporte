/**
 * notifications.js
 * Módulo de notificaciones en tiempo real del lado cliente.
 *
 * Responsabilidades:
 *   - Suscribirse al canal Realtime de Supabase (Postgres CDC) para recibir
 *     nuevas notificaciones del usuario autenticado en tiempo real.
 *   - Cargar las notificaciones no leídas acumuladas al iniciar sesión.
 *   - Marcar notificaciones como leídas.
 *   - Renderizar el componente de notificaciones en el DOM (campana, badge,
 *     dropdown y lista).
 *
 * Nota de seguridad: la autoría de las notificaciones la garantiza Row Level
 * Security (RLS) en la base de datos. El módulo replica el filtro por
 * `recipient_id` como capa de defensa adicional en el cliente: el suscriptor
 * Realtime solo recibe eventos del propio usuario y `renderNewNotification`
 * descarta cualquier payload cuyo `recipient_id` no coincida con el `userId`
 * activo del módulo (Property 9).
 *
 * Requisitos cubiertos: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import { supabase } from '../config.js';

// ---------------------------------------------------------------------------
// Constantes del módulo
// ---------------------------------------------------------------------------

/** Número máximo de notificaciones no leídas que se cargan al iniciar sesión. */
const MAX_UNREAD_NOTIFICATIONS = 50;

/** Selectores de los elementos del componente de notificaciones en el DOM. */
const SELECTORS = {
  badge: '.notifications__badge',
  dropdown: '.notifications__dropdown',
  list: '.notifications__list',
};

// ---------------------------------------------------------------------------
// Estado interno del módulo
// ---------------------------------------------------------------------------

/**
 * Identificador del usuario propietario de las notificaciones gestionadas por
 * esta instancia del módulo. Se establece en `initNotifications` y se utiliza
 * como filtro de seguridad en `renderNewNotification` (Property 9).
 * @type {string|null}
 */
let currentUserId = null;

/**
 * Contador local de notificaciones no leídas mostrado en el badge de la campana.
 * @type {number}
 */
let unreadCount = 0;

// ---------------------------------------------------------------------------
// Suscripción en tiempo real (Realtime CDC)
// ---------------------------------------------------------------------------

/**
 * Inicializa la suscripción Realtime a las notificaciones del usuario.
 *
 * Se suscribe al canal `notifications:${userId}` escuchando eventos INSERT de
 * la tabla `notifications` filtrados por `recipient_id=eq.${userId}` (Postgres
 * CDC). Al recibir un evento válido, renderiza la nueva notificación e
 * incrementa el badge de no leídas (Requisitos 8.1, 8.2, 8.3).
 *
 * @param {string} userId - ID del usuario autenticado (recipient_id).
 * @returns {object|null} El canal Realtime suscrito, o `null` si falta `userId`.
 */
export function initNotifications(userId) {
  // Sin un userId válido no es posible construir el filtro de seguridad.
  if (!userId || typeof userId !== 'string') {
    console.error('initNotifications: se requiere un userId válido.');
    return null;
  }

  // Se fija el destinatario activo del módulo; sirve como filtro en el render.
  currentUserId = userId;

  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        // El servidor Realtime solo entrega eventos del propio destinatario.
        filter: `recipient_id=eq.${userId}`,
      },
      (payload) => {
        // `payload.new` contiene la fila insertada en la tabla notifications.
        renderNewNotification(payload.new);
      },
    )
    .subscribe();

  return channel;
}

// ---------------------------------------------------------------------------
// Carga de notificaciones acumuladas
// ---------------------------------------------------------------------------

/**
 * Carga las notificaciones no leídas acumuladas del usuario y las renderiza en
 * el dropdown. Consulta hasta 50 registros ordenados de más reciente a más
 * antiguo (Requisito 8.4).
 *
 * @param {string} userId - ID del usuario autenticado (recipient_id).
 * @returns {Promise<Array>} Lista de notificaciones no leídas (vacía si error).
 */
export async function loadUnreadNotifications(userId) {
  if (!userId || typeof userId !== 'string') {
    console.error('loadUnreadNotifications: se requiere un userId válido.');
    return [];
  }

  // Se mantiene sincronizado el destinatario activo del módulo.
  currentUserId = userId;

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', userId)
    .eq('is_read', false)
    .order('created_at', { ascending: false })
    .limit(MAX_UNREAD_NOTIFICATIONS);

  if (error) {
    // No se ocultan los errores: se informan para facilitar el diagnóstico.
    console.error('Error al cargar notificaciones no leídas:', error.message);
    return [];
  }

  const notifications = Array.isArray(data) ? data : [];
  renderNotifications(notifications);
  return notifications;
}

// ---------------------------------------------------------------------------
// Marcado como leída
// ---------------------------------------------------------------------------

/**
 * Marca una notificación como leída en la base de datos. El filtro por
 * `recipient_id` acompaña a RLS, que garantiza que solo el propietario puede
 * actualizar sus notificaciones (Requisito 8.5).
 *
 * @param {string} notificationId - ID de la notificación a marcar.
 * @param {string} userId - ID del usuario propietario (recipient_id).
 * @returns {Promise<{ success: boolean, error: (string|null) }>}
 */
export async function markAsRead(notificationId, userId) {
  if (!notificationId || !userId) {
    return {
      success: false,
      error: 'Se requieren notificationId y userId válidos.',
    };
  }

  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId)
    .eq('recipient_id', userId); // RLS garantiza autoría; filtro defensivo.

  if (error) {
    console.error('Error al marcar la notificación como leída:', error.message);
    return { success: false, error: error.message };
  }

  // Se elimina el elemento del DOM y se decrementa el contador de no leídas.
  removeNotificationFromDom(notificationId);
  decrementBadgeCount();

  return { success: true, error: null };
}

// ---------------------------------------------------------------------------
// Renderizado del DOM
// ---------------------------------------------------------------------------

/**
 * Renderiza una nueva notificación recibida en tiempo real, insertándola al
 * inicio de la lista, e incrementa el badge de no leídas.
 *
 * Filtro de seguridad (Property 9): solo se procesan notificaciones cuyo
 * `recipient_id` coincide exactamente con el `userId` activo del módulo. Un
 * payload dirigido a otro destinatario se descarta silenciosamente.
 *
 * @param {object} notification - Fila de la tabla `notifications`.
 */
export function renderNewNotification(notification) {
  // Se descartan payloads inválidos o dirigidos a otro destinatario.
  if (
    !notification ||
    typeof notification !== 'object' ||
    notification.recipient_id !== currentUserId
  ) {
    return;
  }

  const list = document.querySelector(SELECTORS.list);
  if (!list) {
    return;
  }

  // Si existía el estado vacío, se elimina antes de insertar el primer ítem.
  const emptyState = list.querySelector('.notifications__empty');
  if (emptyState) {
    emptyState.remove();
  }

  const item = buildNotificationItem(notification);
  list.prepend(item);

  incrementBadgeCount();
}

/**
 * Renderiza el conjunto completo de notificaciones no leídas en el dropdown,
 * reemplazando el contenido previo de la lista y actualizando el badge.
 *
 * @param {Array<object>} notifications - Notificaciones a renderizar.
 */
export function renderNotifications(notifications) {
  const list = document.querySelector(SELECTORS.list);
  if (!list) {
    return;
  }

  const items = Array.isArray(notifications) ? notifications : [];

  // Se limpia la lista antes de repintar para evitar duplicados.
  list.replaceChildren();

  if (items.length === 0) {
    // Estado vacío accesible cuando no hay notificaciones pendientes.
    const empty = document.createElement('li');
    empty.className = 'notifications__empty';
    empty.textContent = 'No tienes notificaciones nuevas.';
    list.appendChild(empty);
    setBadgeCount(0);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const notification of items) {
    fragment.appendChild(buildNotificationItem(notification));
  }
  list.appendChild(fragment);

  setBadgeCount(items.length);
}

// ---------------------------------------------------------------------------
// Utilidades internas del DOM
// ---------------------------------------------------------------------------

/**
 * Construye el elemento de lista (`<li>`) que representa una notificación.
 * Se usa `textContent` para insertar el mensaje, evitando la inyección de HTML
 * (defensa XSS en el cliente).
 *
 * @param {object} notification - Fila de la tabla `notifications`.
 * @returns {HTMLLIElement} Elemento listo para insertar en el DOM.
 */
function buildNotificationItem(notification) {
  const item = document.createElement('li');
  item.className = 'notifications__item notifications__item--unread';
  item.dataset.notificationId = notification.id;

  // Mensaje de la notificación (texto plano por seguridad).
  const message = document.createElement('p');
  message.className = 'notifications__item-message';
  message.textContent = notification.message || '';
  item.appendChild(message);

  // Marca temporal formateada de forma legible.
  const time = document.createElement('time');
  time.className = 'notifications__item-time';
  if (notification.created_at) {
    time.dateTime = notification.created_at;
    time.textContent = formatTimestamp(notification.created_at);
  }
  item.appendChild(time);

  // Al hacer clic se marca como leída para el destinatario activo del módulo.
  item.addEventListener('click', () => {
    markAsRead(notification.id, currentUserId);
  });

  return item;
}

/**
 * Elimina del DOM el elemento correspondiente a una notificación por su ID.
 * Si tras la eliminación la lista queda vacía, muestra el estado vacío.
 *
 * @param {string} notificationId - ID de la notificación a eliminar.
 */
function removeNotificationFromDom(notificationId) {
  const list = document.querySelector(SELECTORS.list);
  if (!list) {
    return;
  }

  const item = list.querySelector(
    `[data-notification-id="${notificationId}"]`,
  );
  if (item) {
    item.remove();
  }

  // Si ya no quedan notificaciones, se muestra el estado vacío.
  if (!list.querySelector('.notifications__item')) {
    const empty = document.createElement('li');
    empty.className = 'notifications__empty';
    empty.textContent = 'No tienes notificaciones nuevas.';
    list.appendChild(empty);
  }
}

/**
 * Formatea una marca temporal ISO en una cadena legible para el usuario.
 *
 * @param {string} isoString - Fecha en formato ISO 8601.
 * @returns {string} Fecha localizada, o la cadena original si no es parseable.
 */
function formatTimestamp(isoString) {
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

// ---------------------------------------------------------------------------
// Gestión del badge de no leídas
// ---------------------------------------------------------------------------

/**
 * Establece el contador del badge a un valor concreto y actualiza el DOM.
 *
 * @param {number} count - Nuevo número de notificaciones no leídas.
 */
function setBadgeCount(count) {
  unreadCount = Math.max(0, count);
  updateBadgeDom();
}

/** Incrementa en uno el contador del badge y actualiza el DOM. */
function incrementBadgeCount() {
  unreadCount += 1;
  updateBadgeDom();
}

/** Decrementa en uno el contador del badge (sin bajar de cero). */
function decrementBadgeCount() {
  unreadCount = Math.max(0, unreadCount - 1);
  updateBadgeDom();
}

/**
 * Refleja el valor de `unreadCount` en el badge del DOM. El badge se oculta
 * cuando no hay notificaciones no leídas.
 */
function updateBadgeDom() {
  const badge = document.querySelector(SELECTORS.badge);
  if (!badge) {
    return;
  }

  if (unreadCount > 0) {
    badge.textContent = String(unreadCount);
    badge.hidden = false;
  } else {
    badge.textContent = '';
    badge.hidden = true;
  }
}
