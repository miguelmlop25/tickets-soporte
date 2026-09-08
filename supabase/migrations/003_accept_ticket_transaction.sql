-- =============================================================
-- MIGRACIÓN 003: Función transaccional accept_ticket_transaction
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================
-- Scope de esta migración:
--   Función SQL invocada vía supabase.rpc() desde la Edge Function
--   update-ticket-status para aceptar un ticket de forma atómica:
--     1. Verificar que el ticket exista y esté disponible para el Agent
--     2. Actualizar el ticket (status, estado, agent_id, fecha_inicio)
--     3. Insertar entrada en ticket_history
--     4. Insertar entrada en audit_log
--     5. Insertar notificación TICKET_STATUS_CHANGED para el User propietario
--
-- Al ser una única función SQL con BEGIN/COMMIT implícito, cualquier
-- fallo en cualquier paso revierte toda la operación (sin persistencia parcial).
--
-- Requisitos cubiertos: 5.1, 5.2, 5.3, 5.4, 8.2, 9.1
-- Dependencia: debe ejecutarse después de 002_rls_indexes_triggers.sql
-- =============================================================


-- -------------------------------------------------------
-- FUNCIÓN: accept_ticket_transaction
--
-- Parámetros de entrada:
--   p_ticket_id  UUID  — ID del ticket a aceptar
--   p_agent_id   UUID  — ID del Agent que ejecuta la acción
--
-- Retorna:
--   JSONB con { ticket_id, ticket_number, status, estado }
--
-- Errores controlados (RAISE EXCEPTION con SQLSTATE P0001):
--   'TICKET_NOT_FOUND'       — el ticket no existe
--   'TICKET_WRONG_STATUS'    — el ticket no está en estado Pendiente
--   'TICKET_ASSIGNED_OTHER'  — el ticket ya está asignado a otro Agent
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION accept_ticket_transaction(
  p_ticket_id UUID,
  p_agent_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket         RECORD;
  v_ticket_number  TEXT;
  v_user_id        UUID;
  v_message        TEXT;
BEGIN

  -- -------------------------------------------------------
  -- 1. Bloquear el ticket para actualización (FOR UPDATE)
  --    Evita condición de carrera cuando dos Agents aceptan
  --    simultáneamente el mismo ticket.
  -- -------------------------------------------------------
  SELECT
    id,
    ticket_number,
    status,
    estado,
    agent_id,
    user_id
  INTO v_ticket
  FROM tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  -- Verificar que el ticket existe
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TICKET_NOT_FOUND: El ticket % no existe.', p_ticket_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Verificar que el ticket esté en estado Pendiente (único estado aceptable)
  -- para transicionar a TICKET ACEPTADO / En proceso
  IF v_ticket.status <> 'Pendiente' THEN
    RAISE EXCEPTION 'TICKET_WRONG_STATUS: El ticket % no está en estado Pendiente (estado actual: %).', p_ticket_id, v_ticket.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Verificar que el ticket no esté asignado a otro Agent distinto.
  -- Un ticket sin asignar (agent_id IS NULL) o asignado al mismo Agent
  -- es válido para aceptar (auto-asignación o confirmación de recepción).
  IF v_ticket.agent_id IS NOT NULL AND v_ticket.agent_id <> p_agent_id THEN
    RAISE EXCEPTION 'TICKET_ASSIGNED_OTHER: El ticket % está asignado al agente % y no está disponible.', p_ticket_id, v_ticket.agent_id
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 2. Actualizar el ticket
  --    Requisitos 5.1, 5.2: status → En proceso, estado → TICKET ACEPTADO
  -- -------------------------------------------------------
  UPDATE tickets
  SET
    status       = 'En proceso',
    estado       = 'TICKET ACEPTADO',
    agent_id     = p_agent_id,
    fecha_inicio = NOW()
  WHERE id = p_ticket_id
  RETURNING ticket_number, user_id
  INTO v_ticket_number, v_user_id;

  -- -------------------------------------------------------
  -- 3. Insertar entrada en ticket_history
  --    Requisito 5.4: registrar estado anterior, nuevo estado, actor y timestamp
  -- -------------------------------------------------------
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
    v_ticket.estado,      -- estado anterior: 'TICKET PENDIENTE'
    'TICKET ACEPTADO',    -- estado nuevo
    v_ticket.status,      -- status anterior: 'Pendiente'
    'En proceso',         -- status nuevo
    p_agent_id,
    'Agent',
    'Ticket aceptado por el agente'
  );

  -- -------------------------------------------------------
  -- 4. Insertar entrada en audit_log (acción TICKET_ACCEPTED)
  --    Requisito 9.1: registrar toda acción de cambio de estado
  -- -------------------------------------------------------
  INSERT INTO audit_log (
    actor_id,
    action,
    entity_type,
    entity_id,
    metadata
  ) VALUES (
    p_agent_id,
    'TICKET_ACCEPTED',
    'ticket',
    p_ticket_id,
    jsonb_build_object(
      'ticket_number',  v_ticket_number,
      'status_anterior','Pendiente',
      'status_nuevo',   'En proceso',
      'estado_anterior','TICKET PENDIENTE',
      'estado_nuevo',   'TICKET ACEPTADO',
      'agent_id',       p_agent_id
    )
  );

  -- -------------------------------------------------------
  -- 5. Insertar notificación TICKET_STATUS_CHANGED para el User propietario
  --    Requisito 8.2: notificar al User sobre el cambio de estado del ticket
  -- -------------------------------------------------------
  v_message := 'Tu ticket ' || v_ticket_number || ' ha sido aceptado y está En proceso.';

  INSERT INTO notifications (
    recipient_id,
    ticket_id,
    type,
    message
  ) VALUES (
    v_user_id,
    p_ticket_id,
    'TICKET_STATUS_CHANGED',
    v_message
  );

  -- -------------------------------------------------------
  -- 6. Retornar el resultado de la operación
  -- -------------------------------------------------------
  RETURN jsonb_build_object(
    'ticket_id',     p_ticket_id,
    'ticket_number', v_ticket_number,
    'status',        'En proceso',
    'estado',        'TICKET ACEPTADO'
  );

END;
$$;


-- -------------------------------------------------------
-- Permisos: solo el rol service_role puede ejecutar esta función.
-- Las Edge Functions usan service_role; los clientes anon/authenticated
-- no tienen acceso directo para evitar bypass de la validación JWT.
-- -------------------------------------------------------
REVOKE ALL ON FUNCTION accept_ticket_transaction(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_ticket_transaction(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION accept_ticket_transaction(UUID, UUID) FROM authenticated;
