-- =============================================================
-- MIGRACIÓN 008: Permitir que el User lea los perfiles de Agentes
-- Aplicación Web de Tickets de Soporte — Soluciones Tenería
-- =============================================================


-- Eliminar la política de SELECT existente para redefinirla.
DROP POLICY IF EXISTS "profiles_select_own_or_elevated" ON profiles;

-- Recrear la política incluyendo la lectura de perfiles de Agentes.
CREATE POLICY "profiles_select_own_or_elevated"
  ON profiles FOR SELECT
  USING (
    id = auth.uid()
    OR get_my_role() IN ('Agent', 'Admin')
    OR role = 'Agent'
  );