-- =============================================================
-- MIGRACIÓN 003: Función SQL para creación atómica de ticket
-- =============================================================
-- Centraliza en un solo BEGIN/COMMIT todos los INSERTs que
-- ocurren al crear un ticket:
--   1. Obtener el siguiente valor de la secuencia ticket_seq_counter
--   2. Insertar el ticket
--   3. Insertar la entrada en ticket_history
--   4. Insertar la entrada en audit_log
--   5. Insertar notificaciones NEW_TICKET para todos los Agents activos
--
-- La función devuelve (ticket_id UUID, ticket_number TEXT).
-- Si cualquier paso falla el ROLLBACK es automático (transacción
-- implícita de PostgreSQL en funciones LANGUAGE plpgsql).
-- =============================================================

CREATE OR REPLACE FUNCTION create_ticket_transaction(
  p_area              TEXT,
  p_tipo_asistencia   TEXT,
  p_categoria         TEXT,
  p_subcategoria      TEXT,
  p_descripcion       TEXT,
  p_user_id           UUID,
  p_agent_id          UUID        -- puede ser NULL
)
RETURNS TABLE (ticket_id UUID, ticket_number TEXT)
LANGUAGE plpgsql
SECURITY DEFINER   -- ejecuta con los permisos del owner (service_role)
AS $$
DECLARE
  v_seq            INTEGER;
  v_ticket_id      UUID;
  v_ticket_number  TEXT;
  v_agent          RECORD;
  v_message        TEXT;
BEGIN
  -- ----------------------------------------------------------
  -- 1. Obtener el siguiente número de secuencia SSP-XXXX
  -- ----------------------------------------------------------
  SELECT nextval('ticket_seq_counter') INTO v_seq;

  -- Verificar que no se haya superado SSP-9999
  -- (la secuencia tiene MAXVALUE 9999 y NO CYCLE, por lo que
  -- nextval lanzaría una excepción antes de llegar aquí; esta
  -- comprobación es una capa extra de defensa).
  IF v_seq > 9999 THEN
    RAISE EXCEPTION 'SEQ_LIMIT_REACHED'
      USING HINT = 'El contador de tickets alcanzó el límite SSP-9999.';
  END IF;

  -- Construir el número de ticket con padding de 4 dígitos
  v_ticket_number := 'SSP-' || LPAD(v_seq::TEXT, 4, '0');

  -- ----------------------------------------------------------
  -- 2. Insertar el ticket
  -- ----------------------------------------------------------
  INSERT INTO tickets (
    ticket_number,
    ticket_seq,
    area,
    tipo_asistencia,
    categoria,
    subcategoria,
    descripcion,
    status,
    estado,
    user_id,
    agent_id
  )
  VALUES (
    v_ticket_number,
    v_seq,
    p_area::ticket_area,
    p_tipo_asistencia::ticket_tipo_asistencia,
    p_categoria::ticket_categoria,
    p_subcategoria,
    p_descripcion,
    'Pendiente',
    'TICKET PENDIENTE',
    p_user_id,
    p_agent_id
  )
  RETURNING id INTO v_ticket_id;

  -- ----------------------------------------------------------
  -- 3. Registrar en ticket_history (entrada inicial)
  -- ----------------------------------------------------------
  INSERT INTO ticket_history (
    ticket_id,
    estado_anterior,
    estado_nuevo,
    status_anterior,
    status_nuevo,
    actor_id,
    actor_role,
    comentario
  )
  VALUES (
    v_ticket_id,
    NULL,                    -- sin estado anterior (es creación)
    'TICKET PENDIENTE',
    NULL,                    -- sin status anterior (es creación)
    'Pendiente',
    p_user_id,
    'User',
    'Ticket creado'
  );

  -- ----------------------------------------------------------
  -- 4. Registrar en audit_log (acción TICKET_CREATED)
  -- ----------------------------------------------------------
  INSERT INTO audit_log (
    actor_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  VALUES (
    p_user_id,
    'TICKET_CREATED',
    'ticket',
    v_ticket_id,
    jsonb_build_object(
      'ticket_number', v_ticket_number,
      'area',          p_area,
      'categoria',     p_categoria,
      'agent_id',      p_agent_id
    )
  );

  -- ----------------------------------------------------------
  -- 5. Insertar notificaciones NEW_TICKET para Agents activos
  -- ----------------------------------------------------------
  -- Construir el mensaje una sola vez fuera del loop
  IF p_agent_id IS NOT NULL THEN
    v_message := 'Nuevo ticket ' || v_ticket_number || ' asignado a ti.';
  ELSE
    v_message := 'Nuevo ticket ' || v_ticket_number || ' sin asignar disponible.';
  END IF;

  FOR v_agent IN
    SELECT id FROM profiles
    WHERE role = 'Agent'
      AND is_active = TRUE
  LOOP
    INSERT INTO notifications (
      recipient_id,
      ticket_id,
      type,
      message
    )
    VALUES (
      v_agent.id,
      v_ticket_id,
      'NEW_TICKET',
      v_message
    );
  END LOOP;

  -- ----------------------------------------------------------
  -- 6. Retornar los datos del ticket creado
  -- ----------------------------------------------------------
  RETURN QUERY SELECT v_ticket_id, v_ticket_number;
END;
$$;
