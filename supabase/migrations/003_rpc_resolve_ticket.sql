-- =============================================================
-- MIGRACIÓN 003: Función RPC resolve_ticket_transaction
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================
-- Scope de esta migración:
--   Función PL/pgSQL invocable vía supabase.rpc() desde la Edge
--   Function resolve-ticket. Ejecuta de forma atómica:
--     1. Verificación de que el ticket está asignado al Agent
--     2. UPDATE del ticket (status, estado, solucion_aplicada, fecha_fin)
--     3. INSERT en ticket_history
--     4. INSERT en audit_log (acción TICKET_RESOLVED)
--     5. INSERT en notifications para el User propietario
--
-- Requisitos cubiertos: 5.5, 5.6, 5.7, 5.8, 5.9, 9.1, 9.3
-- Dependencia: debe ejecutarse después de 002_rls_indexes_triggers.sql
-- =============================================================

-- ---------------------------------------------------------------------------
-- Función: resolve_ticket_transaction
--
-- Parámetros:
--   p_ticket_id          UUID   — ID del ticket a resolver
--   p_agent_id           UUID   — ID del Agent que resuelve (del JWT)
--   p_solucion_aplicada  TEXT   — Solución aplicada (ya sanitizada, 10–1000 chars)
--
-- Retorna:
--   JSON con { ticket_id, ticket_number, status, estado, fecha_fin }
--
-- Errores (RAISE EXCEPTION):
--   'TICKET_NOT_FOUND'        — el ticket no existe
--   'TICKET_NOT_ASSIGNED'     — el ticket no está asignado a ningún Agent
--   'TICKET_WRONG_AGENT'      — el ticket está asignado a otro Agent
--   'TICKET_ALREADY_RESOLVED' — el ticket ya tiene status Finalizado
--
-- Seguridad:
--   SECURITY DEFINER permite que la función opere con los privilegios del
--   owner (postgres/service_role), sin requerir que el cliente de la Edge
--   Function tenga permisos de escritura directa en las tablas sensibles.
--   La validación del Agent se realiza dentro de la propia función.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_ticket_transaction(
  p_ticket_id         UUID,
  p_agent_id          UUID,
  p_solucion_aplicada TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket          tickets%ROWTYPE;
  v_ticket_number   TEXT;
  v_user_id         UUID;
  v_fecha_fin       TIMESTAMPTZ;
  v_notification_msg TEXT;
BEGIN
  -- -----------------------------------------------------------------------
  -- 1. Obtener el ticket y bloquear la fila para actualización concurrente
  -- -----------------------------------------------------------------------
  SELECT * INTO v_ticket
  FROM tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  -- Verificar que el ticket existe
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TICKET_NOT_FOUND'
      USING DETAIL = 'No existe un ticket con el ID proporcionado.',
            HINT   = p_ticket_id::TEXT;
  END IF;

  -- -----------------------------------------------------------------------
  -- 2. Verificar que el ticket esté asignado al Agent correcto
  -- -----------------------------------------------------------------------

  -- El ticket no puede estar ya resuelto
  IF v_ticket.status = 'Finalizado' THEN
    RAISE EXCEPTION 'TICKET_ALREADY_RESOLVED'
      USING DETAIL = 'El ticket ya se encuentra en estado Finalizado.',
            HINT   = p_ticket_id::TEXT;
  END IF;

  -- El ticket debe estar asignado a algún Agent
  IF v_ticket.agent_id IS NULL THEN
    RAISE EXCEPTION 'TICKET_NOT_ASSIGNED'
      USING DETAIL = 'El ticket no está asignado a ningún agente.',
            HINT   = p_ticket_id::TEXT;
  END IF;

  -- El ticket debe estar asignado exactamente al Agent autenticado
  IF v_ticket.agent_id <> p_agent_id THEN
    RAISE EXCEPTION 'TICKET_WRONG_AGENT'
      USING DETAIL = 'El ticket está asignado a otro agente.',
            HINT   = p_ticket_id::TEXT;
  END IF;

  -- -----------------------------------------------------------------------
  -- 3. Registrar la fecha de finalización
  -- -----------------------------------------------------------------------
  v_fecha_fin     := NOW();
  v_ticket_number := v_ticket.ticket_number;
  v_user_id       := v_ticket.user_id;

  -- -----------------------------------------------------------------------
  -- 4. Actualizar el ticket
  -- -----------------------------------------------------------------------
  UPDATE tickets
  SET
    status            = 'Finalizado',
    estado            = 'TICKET RESUELTO',
    solucion_aplicada = p_solucion_aplicada,
    fecha_fin         = v_fecha_fin
  WHERE id = p_ticket_id;

  -- -----------------------------------------------------------------------
  -- 5. Registrar en ticket_history
  -- -----------------------------------------------------------------------
  INSERT INTO ticket_history (
    ticket_id,
    estado_anterior,
    estado_nuevo,
    status_anterior,
    status_nuevo,
    actor_id,
    actor_role,
    comentario
  ) VALUES (
    p_ticket_id,
    v_ticket.estado,          -- estado anterior del ticket
    'TICKET RESUELTO',
    v_ticket.status,          -- status anterior del ticket
    'Finalizado',
    p_agent_id,
    'Agent',
    p_solucion_aplicada       -- la solución aplicada queda como comentario
  );

  -- -----------------------------------------------------------------------
  -- 6. Registrar en audit_log (acción TICKET_RESOLVED)
  -- -----------------------------------------------------------------------
  INSERT INTO audit_log (
    actor_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) VALUES (
    p_agent_id,
    'TICKET_RESOLVED',
    'ticket',
    p_ticket_id,
    jsonb_build_object(
      'ticket_number',    v_ticket_number,
      'estado_anterior',  v_ticket.estado::TEXT,
      'status_anterior',  v_ticket.status::TEXT,
      'estado_nuevo',     'TICKET RESUELTO',
      'status_nuevo',     'Finalizado',
      'fecha_fin',        v_fecha_fin
    )
  );

  -- -----------------------------------------------------------------------
  -- 7. Insertar notificación TICKET_STATUS_CHANGED para el User propietario
  -- -----------------------------------------------------------------------
  v_notification_msg := 'Tu ticket ' || v_ticket_number
    || ' ha sido resuelto. Estado: TICKET RESUELTO.';

  INSERT INTO notifications (
    recipient_id,
    ticket_id,
    type,
    message
  ) VALUES (
    v_user_id,
    p_ticket_id,
    'TICKET_STATUS_CHANGED',
    v_notification_msg
  );

  -- -----------------------------------------------------------------------
  -- 8. Retornar resultado
  -- -----------------------------------------------------------------------
  RETURN json_build_object(
    'ticket_id',     p_ticket_id,
    'ticket_number', v_ticket_number,
    'status',        'Finalizado',
    'estado',        'TICKET RESUELTO',
    'fecha_fin',     v_fecha_fin
  );

END;
$$;

-- Revocar acceso público y conceder solo al rol service_role
-- (las Edge Functions usan service_role internamente)
REVOKE ALL ON FUNCTION resolve_ticket_transaction(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_ticket_transaction(UUID, UUID, TEXT) TO service_role;
