-- =============================================================
-- MIGRACIÓN 002: Índices, Triggers, Funciones y RLS
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================
-- Scope de esta migración:
--   1. Índices de rendimiento
--   2. Función y trigger update_updated_at_column
--   3. Función y trigger prevent_audit_log_modification
--   4. Función auxiliar get_my_role() para RLS
--   5. Políticas Row Level Security (RLS) para todas las tablas
--   6. Publicación Realtime CDC
--
-- Requisitos cubiertos: 12.3, 12.6, 9.6, 10.6
-- Dependencia: debe ejecutarse después de 001_initial_schema.sql
-- =============================================================


-- -------------------------------------------------------
-- 1. ÍNDICES DE RENDIMIENTO
-- Requisito 12.6: índices en columnas de filtros frecuentes
-- -------------------------------------------------------

-- Índice para filtrar tickets por status (Pendiente, En proceso, Finalizado)
CREATE INDEX idx_tickets_status
  ON tickets (status);

-- Índice para filtrar tickets asignados a un Agent específico
CREATE INDEX idx_tickets_agent_id
  ON tickets (agent_id);

-- Índice para filtrar tickets creados por un User específico
CREATE INDEX idx_tickets_user_id
  ON tickets (user_id);

-- Índice para filtrar tickets por categoría (SOFTWARE, HARDWARE, etc.)
CREATE INDEX idx_tickets_categoria
  ON tickets (categoria);

-- Índice para ordenar/filtrar tickets por fecha de creación (descendente)
CREATE INDEX idx_tickets_fecha_creacion
  ON tickets (fecha_creacion DESC);

-- Índice para consultar notificaciones por destinatario, estado de lectura y fecha
CREATE INDEX idx_notifications_recipient
  ON notifications (recipient_id, is_read, created_at DESC);

-- Índice para consultar el historial de cambios de un ticket específico
CREATE INDEX idx_ticket_history_ticket
  ON ticket_history (ticket_id, created_at DESC);

-- Índice para filtrar el audit log por actor (usuario que realizó la acción)
CREATE INDEX idx_audit_log_actor
  ON audit_log (actor_id, created_at DESC);

-- Índice para filtrar el audit log por entidad afectada (ticket, usuario, etc.)
CREATE INDEX idx_audit_log_entity
  ON audit_log (entity_id, created_at DESC);

-- Índice para el rate limiting: consulta rápida por IP, endpoint y ventana de tiempo
CREATE INDEX idx_rate_limit_ip_endpoint_time
  ON rate_limit_log (ip_address, endpoint, created_at DESC);


-- -------------------------------------------------------
-- 2. FUNCIÓN Y TRIGGERS: update_updated_at_column
-- Actualiza automáticamente el campo updated_at en cada UPDATE
-- Requisito 12.4: mantenimiento de metadatos de tablas
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Asignar la marca de tiempo actual al campo updated_at de la fila modificada
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Trigger para la tabla profiles
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger para la tabla tickets
CREATE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- -------------------------------------------------------
-- 3. FUNCIÓN Y TRIGGER: prevent_audit_log_modification
-- Bloquea cualquier UPDATE o DELETE sobre audit_log
-- Requisito 9.6: el Audit Log es de solo lectura e inmutable
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Lanzar excepción en cualquier intento de modificar o eliminar un registro
  RAISE EXCEPTION 'El Audit Log es de solo lectura y no puede ser modificado ni eliminado.';
END;
$$;

-- Trigger que se dispara antes de cualquier UPDATE o DELETE en audit_log
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();


-- -------------------------------------------------------
-- 4. FUNCIÓN AUXILIAR: get_my_role()
-- Retorna el rol del usuario autenticado actualmente (auth.uid())
-- Usada por las políticas RLS para determinar el rol en cada petición
-- Requisito 12.3, 10.6: RLS basada en rol del usuario autenticado
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION get_my_role()
RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;


-- -------------------------------------------------------
-- 5. ROW LEVEL SECURITY (RLS)
-- Habilitar RLS y definir políticas por tabla
-- Requisito 12.3: RLS en todas las tablas con datos sensibles
-- Requisito 10.6: cada User accede solo a sus propios datos
-- -------------------------------------------------------

-- Habilitar RLS en todas las tablas con datos de usuarios o tickets
ALTER TABLE profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications  ENABLE ROW LEVEL SECURITY;


-- -------------------------------------------------------
-- 5.1 POLÍTICAS RLS: profiles
-- -------------------------------------------------------

-- Un usuario puede leer su propio perfil.
-- Agents y Admins pueden leer todos los perfiles (necesario para asignación de tickets).
CREATE POLICY "profiles_select_own_or_elevated"
  ON profiles FOR SELECT
  USING (
    id = auth.uid()
    OR get_my_role() IN ('Agent', 'Admin')
  );

-- Un usuario puede actualizar únicamente su propio perfil.
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (id = auth.uid());

-- El Admin puede realizar cualquier operación sobre perfiles
-- (incluyendo bloquear, desbloquear y eliminar cuentas de User/Agent).
CREATE POLICY "profiles_admin_all"
  ON profiles FOR ALL
  USING (get_my_role() = 'Admin');


-- -------------------------------------------------------
-- 5.2 POLÍTICAS RLS: tickets
-- Requisito 2.6: Users solo ven sus propios tickets
-- Requisito 2.7: Agents ven todos los tickets asignados + sin asignar
-- Requisito 2.9: Admins ven todos los tickets
-- -------------------------------------------------------

-- SELECT: User ve solo sus tickets; Agent y Admin ven todos
CREATE POLICY "tickets_select_by_role"
  ON tickets FOR SELECT
  USING (
    user_id = auth.uid()
    OR get_my_role() IN ('Agent', 'Admin')
  );

-- INSERT: el User solo puede insertar tickets donde user_id sea su propio id.
-- La Edge Function create-ticket valida adicionalmente el rol.
CREATE POLICY "tickets_insert_own"
  ON tickets FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- UPDATE: el User puede editar sus tickets en estado Pendiente o En proceso.
-- Agents y Admins pueden actualizar cualquier ticket.
CREATE POLICY "tickets_update_by_role"
  ON tickets FOR UPDATE
  USING (
    (user_id = auth.uid() AND status IN ('Pendiente', 'En proceso'))
    OR get_my_role() IN ('Agent', 'Admin')
  );

-- DELETE: el User elimina sus propios tickets solo si están en Pendiente.
-- El Agent elimina tickets en estado Finalizado (requisito 7.8).
-- El Admin puede eliminar cualquier ticket.
CREATE POLICY "tickets_delete_by_role"
  ON tickets FOR DELETE
  USING (
    (user_id = auth.uid() AND status = 'Pendiente')
    OR (get_my_role() = 'Agent' AND status = 'Finalizado')
    OR get_my_role() = 'Admin'
  );


-- -------------------------------------------------------
-- 5.3 POLÍTICAS RLS: ticket_history
-- El historial es visible para el User dueño del ticket,
-- para los Agents y para los Admins.
-- -------------------------------------------------------

-- SELECT: el User puede ver el historial de sus propios tickets.
-- Agents y Admins pueden ver el historial de todos los tickets.
CREATE POLICY "ticket_history_select_by_role"
  ON ticket_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tickets t
      WHERE t.id = ticket_history.ticket_id
        AND (
          t.user_id = auth.uid()
          OR get_my_role() IN ('Agent', 'Admin')
        )
    )
  );

-- INSERT: solo puede insertar entradas de historial el actor autenticado.
-- Las Edge Functions usan service_role para esta operación.
CREATE POLICY "ticket_history_insert_actor"
  ON ticket_history FOR INSERT
  WITH CHECK (actor_id = auth.uid());


-- -------------------------------------------------------
-- 5.4 POLÍTICAS RLS: audit_log
-- Solo los Admins pueden consultar el audit log.
-- El INSERT lo realizan las Edge Functions con service_role.
-- UPDATE y DELETE están bloqueados por el trigger audit_log_immutable.
-- Requisito 9.6: solo lectura para todos los roles
-- -------------------------------------------------------

-- SELECT: solo el Admin puede consultar el audit log
CREATE POLICY "audit_log_admin_select"
  ON audit_log FOR SELECT
  USING (get_my_role() = 'Admin');

-- INSERT: solo puede insertar el actor autenticado.
-- En producción las Edge Functions usan service_role y no pasan por esta política,
-- pero se define como salvaguarda para operaciones directas.
CREATE POLICY "audit_log_insert_authenticated"
  ON audit_log FOR INSERT
  WITH CHECK (actor_id = auth.uid());

-- Nota: UPDATE y DELETE no necesitan política ya que el trigger
-- prevent_audit_log_modification los bloquea antes de que RLS los evalúe.


-- -------------------------------------------------------
-- 5.5 POLÍTICAS RLS: notifications
-- Cada usuario solo accede a sus propias notificaciones.
-- El INSERT lo realizan las Edge Functions con service_role.
-- Requisito 8.1, 8.2, 10.6
-- -------------------------------------------------------

-- SELECT: cada usuario ve únicamente sus propias notificaciones
CREATE POLICY "notifications_select_own"
  ON notifications FOR SELECT
  USING (recipient_id = auth.uid());

-- UPDATE: el usuario puede marcar como leídas solo sus propias notificaciones
CREATE POLICY "notifications_update_own"
  ON notifications FOR UPDATE
  USING (recipient_id = auth.uid());

-- Nota: INSERT lo realizan las Edge Functions con service_role,
-- por lo que no se define política de INSERT aquí para el cliente.


-- -------------------------------------------------------
-- 6. PUBLICACIÓN REALTIME CDC
-- Habilitar Change Data Capture para notificaciones en tiempo real
-- Requisito 8.3: entrega de notificaciones en < 5 segundos
-- -------------------------------------------------------

-- Habilitar CDC para la tabla notifications (notificaciones individuales por usuario)
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

-- Habilitar CDC para la tabla tickets (actualizaciones visibles para Agents/Admin)
ALTER PUBLICATION supabase_realtime ADD TABLE tickets;
