-- =============================================================
-- MIGRACIÓN 005: Creación automática del perfil de usuario
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================
-- Scope de esta migración:
--   Función y trigger que crean automáticamente una fila en la
--   tabla `profiles` cada vez que se registra un nuevo usuario en
--   `auth.users` (Supabase Auth).
--
--   El trigger lee la metadata enviada por el frontend en el
--   signUp (options.data => raw_user_meta_data):
--     - full_name : nombre completo capturado en el registro
--     - role      : rol solicitado ('User' o 'Agent')
--
--   Reglas de seguridad:
--     - El rol se fuerza a 'User' o 'Agent'. Cualquier otro valor
--       (incluido 'Admin' o metadata ausente) se normaliza a 'User'.
--       Esto impide que un visitante se registre como Admin mediante
--       manipulación del cliente (Requisitos 2.4, 2.5).
--     - Las cuentas Admin se crean manualmente en la base de datos
--       (INSERT directo en auth.users + profiles), no por esta vía.
--
-- Requisitos cubiertos: 1.4, 2.1, 2.4, 2.5, 11.2
-- Dependencia: debe ejecutarse después de 001_initial_schema.sql
--              (necesita la tabla profiles y el tipo user_role).
-- =============================================================


-- -------------------------------------------------------
-- FUNCIÓN: handle_new_user
--
-- Se ejecuta tras insertar una fila en auth.users. Crea el perfil
-- correspondiente en public.profiles usando la metadata del signUp.
--
-- SECURITY DEFINER: la función se ejecuta con los privilegios de su
-- owner (postgres), de modo que pueda insertar en public.profiles
-- pese a las políticas RLS de esa tabla. El search_path se fija de
-- forma explícita como práctica de seguridad recomendada.
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_role_raw  TEXT;
  v_role      user_role;
BEGIN
  -- Extraer la metadata enviada en el signUp (puede venir nula).
  v_full_name := NULLIF(TRIM(NEW.raw_user_meta_data ->> 'full_name'), '');
  v_role_raw  := NEW.raw_user_meta_data ->> 'role';

  -- Normalizar el rol: solo se permiten 'User' o 'Agent' por esta vía.
  -- Cualquier otro valor (Admin, nulo o inválido) se fuerza a 'User'
  -- para impedir el auto-registro de administradores (Requisitos 2.4, 2.5).
  IF v_role_raw = 'Agent' THEN
    v_role := 'Agent';
  ELSE
    v_role := 'User';
  END IF;

  -- Si no se recibió nombre, usar la parte local del correo como respaldo,
  -- ya que profiles.full_name es NOT NULL.
  IF v_full_name IS NULL THEN
    v_full_name := split_part(NEW.email, '@', 1);
  END IF;

  -- Crear el perfil. ON CONFLICT evita error si el perfil ya existe
  -- (por reintentos o ejecuciones repetidas del trigger).
  INSERT INTO public.profiles (id, full_name, email, role, is_active)
  VALUES (NEW.id, v_full_name, NEW.email, v_role, TRUE)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;


-- -------------------------------------------------------
-- TRIGGER: on_auth_user_created
--
-- Se dispara AFTER INSERT en auth.users. Se usa AFTER (no BEFORE)
-- para garantizar que la fila de auth.users ya existe cuando se
-- inserta el perfil que la referencia por clave foránea.
-- -------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
