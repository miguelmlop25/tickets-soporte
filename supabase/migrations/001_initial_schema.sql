-- =============================================================
-- MIGRACIÓN 001: Esquema inicial
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================
-- Scope de esta migración:
--   1. Extensiones
--   2. Tipos enumerados
--   3. Tablas con claves foráneas y ON DELETE explícito
--
-- Nota: índices, triggers, funciones auxiliares y políticas RLS
--       se agregan en la migración 002 (tarea 2.2).
-- =============================================================


-- -------------------------------------------------------
-- 1. EXTENSIONES
-- -------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- -------------------------------------------------------
-- 2. TIPOS ENUMERADOS
-- -------------------------------------------------------

-- Roles de usuario disponibles en el sistema
CREATE TYPE user_role AS ENUM ('User', 'Agent', 'Admin');

-- Estado de ciclo de vida de un ticket (dos dimensiones)
CREATE TYPE ticket_status AS ENUM ('Pendiente', 'En proceso', 'Finalizado');
CREATE TYPE ticket_estado AS ENUM (
  'TICKET PENDIENTE',
  'TICKET ACEPTADO',
  'TICKET RESUELTO'
);

-- Áreas de la empresa que pueden reportar tickets
CREATE TYPE ticket_area AS ENUM (
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
  'SOCIOS'
);

-- Tipos de asistencia disponibles al crear un ticket
CREATE TYPE ticket_tipo_asistencia AS ENUM (
  'Asistencia remota',
  'Correo',
  'Llamada',
  'Presencial'
);

-- Categorías principales de soporte técnico
CREATE TYPE ticket_categoria AS ENUM (
  'SOFTWARE',
  'HARDWARE',
  'CONFIGURACIONES',
  'SEGURIDAD',
  'TELECOMUNICACIONES'
);

-- Acciones que se pueden registrar en el audit log
CREATE TYPE audit_action AS ENUM (
  'TICKET_CREATED',
  'TICKET_ACCEPTED',
  'TICKET_RESOLVED',
  'TICKET_UPDATED',
  'TICKET_DELETED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DELETED',
  'USER_BLOCKED',
  'USER_UNBLOCKED'
);

-- Tipos de notificación en el sistema
CREATE TYPE notification_type AS ENUM (
  'NEW_TICKET',
  'TICKET_STATUS_CHANGED'
);


-- -------------------------------------------------------
-- 3. TABLAS
-- -------------------------------------------------------

-- -----------------------------------------------------------
-- 3.1 profiles
-- Extiende auth.users de Supabase Auth.
-- ON DELETE CASCADE: si el usuario se elimina de auth.users,
-- su perfil se elimina también (integridad referencial).
-- -----------------------------------------------------------
CREATE TABLE profiles (
  id         UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT        NOT NULL,
  email      TEXT        NOT NULL UNIQUE,
  role       user_role   NOT NULL DEFAULT 'User',
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- -----------------------------------------------------------
-- 3.2 tickets
-- Secuencia separada para garantizar atomicidad en SSP-XXXX.
-- user_id  → RESTRICT: no se puede eliminar un perfil que
--            tenga tickets creados (preserva historial).
-- agent_id → SET NULL: si el agente es eliminado, el ticket
--            queda sin asignar (no se pierde el ticket).
-- -----------------------------------------------------------
CREATE SEQUENCE ticket_seq_counter
  START    0
  MINVALUE 0
  MAXVALUE 9999
  NO CYCLE;

CREATE TABLE tickets (
  id                UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_number     TEXT              NOT NULL UNIQUE,   -- formato SSP-XXXX
  ticket_seq        INTEGER           NOT NULL UNIQUE,   -- valor 0–9999
  area              ticket_area       NOT NULL,
  tipo_asistencia   ticket_tipo_asistencia NOT NULL,
  categoria         ticket_categoria  NOT NULL,
  subcategoria      TEXT              NOT NULL,
  descripcion       TEXT              NOT NULL
                      CHECK (char_length(descripcion) BETWEEN 1 AND 1000),
  status            ticket_status     NOT NULL DEFAULT 'Pendiente',
  estado            ticket_estado     NOT NULL DEFAULT 'TICKET PENDIENTE',
  solucion_aplicada TEXT
                      CHECK (
                        solucion_aplicada IS NULL
                        OR char_length(solucion_aplicada) BETWEEN 10 AND 1000
                      ),
  user_id           UUID              NOT NULL
                      REFERENCES profiles(id) ON DELETE RESTRICT,
  agent_id          UUID
                      REFERENCES profiles(id) ON DELETE SET NULL,
  fecha_creacion    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  fecha_inicio      TIMESTAMPTZ,                          -- cuando el Agent acepta
  fecha_fin         TIMESTAMPTZ,                          -- cuando se marca RESUELTO
  created_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);


-- -----------------------------------------------------------
-- 3.3 ticket_history
-- Historial de cambios de estado de cada ticket.
-- ticket_id → RESTRICT: mantiene la integridad del historial;
--             no se puede eliminar un ticket con historial.
-- actor_id  → RESTRICT: el actor debe existir para que el
--             registro tenga sentido auditablemente.
-- -----------------------------------------------------------
CREATE TABLE ticket_history (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id       UUID          NOT NULL
                    REFERENCES tickets(id) ON DELETE RESTRICT,
  estado_anterior ticket_estado,
  estado_nuevo    ticket_estado NOT NULL,
  status_anterior ticket_status,
  status_nuevo    ticket_status NOT NULL,
  actor_id        UUID          NOT NULL
                    REFERENCES profiles(id) ON DELETE RESTRICT,
  actor_role      user_role     NOT NULL,
  comentario      TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);


-- -----------------------------------------------------------
-- 3.4 audit_log
-- Registro de auditoría general — INMUTABLE por diseño.
-- El trigger prevent_audit_log_modification (migración 002)
-- bloqueará cualquier UPDATE o DELETE sobre esta tabla.
-- actor_id → RESTRICT: el actor debe existir para mantener
--            la trazabilidad del log.
-- -----------------------------------------------------------
CREATE TABLE audit_log (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID         NOT NULL
                REFERENCES profiles(id) ON DELETE RESTRICT,
  action      audit_action NOT NULL,
  entity_type TEXT         NOT NULL,
  entity_id   UUID         NOT NULL,
  metadata    JSONB,                         -- datos adicionales del evento
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- -----------------------------------------------------------
-- 3.5 notifications
-- Notificaciones en tiempo real para usuarios y agentes.
-- recipient_id → CASCADE: si el usuario se elimina, sus
--               notificaciones también se eliminan.
-- ticket_id    → CASCADE: si el ticket se elimina, las
--               notificaciones asociadas también (ya no
--               son relevantes).
-- -----------------------------------------------------------
CREATE TABLE notifications (
  id           UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID              NOT NULL
                 REFERENCES profiles(id) ON DELETE CASCADE,
  ticket_id    UUID
                 REFERENCES tickets(id) ON DELETE CASCADE,
  type         notification_type NOT NULL,
  message      TEXT              NOT NULL,
  is_read      BOOLEAN           NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);


-- -----------------------------------------------------------
-- 3.6 rate_limit_log
-- Registro de peticiones por IP para control de rate limiting
-- en las Edge Functions. No tiene relación con otras tablas.
-- -----------------------------------------------------------
CREATE TABLE rate_limit_log (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  ip_address TEXT        NOT NULL,
  endpoint   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
