-- =============================================================
-- MIGRACIÓN 007: Validación de dominio de correo en el backend
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================
-- Objetivo:
--   Reforzar la validación del dominio corporativo en el backend
--   (además de la validación del frontend en validators.js), de modo
--   que ningún usuario pueda registrarse con un dominio distinto al
--   permitido aunque manipule el cliente. Esta es la barrera de
--   seguridad autoritativa (Requisitos 1.1, 1.2, 11.5).
--
-- Cómo funciona:
--   Reemplaza la función handle_new_user() (definida en la migración
--   005) para que, antes de crear el perfil, verifique que el correo
--   pertenezca al dominio corporativo. Si no coincide, lanza una
--   excepción que aborta el registro completo (no se crea el perfil
--   ni queda una cuenta utilizable).
--
-- Cómo cambiar el dominio en el futuro:
--   Modifique el valor de la constante v_dominio_permitido más abajo
--   (por ejemplo '@nuevodominio.com') y vuelva a ejecutar esta misma
--   migración en el SQL Editor de Supabase. Debe coincidir con el
--   valor de CORPORATE_DOMAIN en js/modules/validators.js.
--
-- Dependencia: debe ejecutarse después de 005_handle_new_user.sql
-- =============================================================

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
  -- Dominio corporativo permitido. Debe coincidir con CORPORATE_DOMAIN
  -- del frontend (js/modules/validators.js). Cambiar aquí al actualizar.
  v_dominio_permitido TEXT := '@solucionesteneria.com';
BEGIN
  -- ---------------------------------------------------------------
  -- Validación de dominio en el backend (barrera autoritativa).
  -- Se rechaza cualquier correo que no termine con el dominio permitido.
  -- La comparación es insensible a mayúsculas/minúsculas.
  -- ---------------------------------------------------------------
  IF lower(NEW.email) NOT LIKE ('%' || lower(v_dominio_permitido)) THEN
    RAISE EXCEPTION 'DOMINIO_NO_PERMITIDO: solo se permiten correos del dominio %', v_dominio_permitido
      USING ERRCODE = 'P0001';
  END IF;

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

-- Nota: el trigger on_auth_user_created (creado en la migración 005) sigue
-- vigente y ahora ejecuta esta versión reforzada de la función. No es
-- necesario recrearlo.