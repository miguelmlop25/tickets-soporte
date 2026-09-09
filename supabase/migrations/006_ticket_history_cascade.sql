-- =============================================================
-- MIGRACIÓN 006: Permitir eliminación de tickets (CASCADE de historial)
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================
-- Contexto del problema:
--   La tabla ticket_history define su clave foránea ticket_id con
--   ON DELETE RESTRICT. Como cada ticket tiene al menos una entrada
--   de historial (creada por create_ticket_transaction al generarlo),
--   la base de datos rechaza el DELETE de cualquier ticket, impidiendo
--   la eliminación por parte del User (Pendiente) y del Agent (Finalizado).
--
-- Solución:
--   Cambiar la restricción de ticket_history.ticket_id a ON DELETE CASCADE,
--   de modo que al eliminar un ticket se elimine también su historial
--   asociado (comportamiento coherente con "eliminar permanentemente").
--
--   La tabla notifications ya usa ON DELETE CASCADE para ticket_id, por lo
--   que sus filas se eliminan automáticamente y no requieren cambios.
--
-- Nota: El registro de auditoría en audit_log NO referencia al ticket por
--   clave foránea (usa entity_id sin FK), por lo que la traza de eliminación
--   permanece intacta tras borrar el ticket.
--
-- Dependencia: debe ejecutarse después de 001_initial_schema.sql
-- =============================================================

-- Eliminar la restricción de clave foránea existente (nombre autogenerado
-- por PostgreSQL: <tabla>_<columna>_fkey).
ALTER TABLE ticket_history
  DROP CONSTRAINT IF EXISTS ticket_history_ticket_id_fkey;

-- Volver a crear la clave foránea con ON DELETE CASCADE.
ALTER TABLE ticket_history
  ADD CONSTRAINT ticket_history_ticket_id_fkey
  FOREIGN KEY (ticket_id)
  REFERENCES tickets(id)
  ON DELETE CASCADE;