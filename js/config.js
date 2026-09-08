// config.js — Inicialización del cliente Supabase.
//
// La URL del proyecto y la anon key NUNCA se escriben directamente en el código
// fuente. El proceso de build de Netlify las inyecta en tiempo de despliegue como
// variables globales del navegador (window.__SUPABASE_URL__ y
// window.__SUPABASE_ANON_KEY__) a partir de las variables de entorno
// SUPABASE_URL y SUPABASE_ANON_KEY configuradas en Netlify.
//
// Requisito 10.1: toda comunicación cliente-servidor se realiza mediante HTTPS.
// La anon key es una clave pública destinada al cliente; la seguridad real de los
// datos se garantiza mediante Row Level Security (RLS) en la base de datos.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Se leen las variables inyectadas por el build de Netlify.
const SUPABASE_URL = window.__SUPABASE_URL__;
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__;

// Validación defensiva: si el proceso de build no inyectó las variables, se falla
// de forma explícita y temprana en lugar de crear un cliente inutilizable que
// produciría errores confusos más adelante.
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Configuración de Supabase ausente: window.__SUPABASE_URL__ y ' +
      'window.__SUPABASE_ANON_KEY__ deben ser inyectadas por el build de Netlify.'
  );
}

// Instancia única del cliente Supabase reutilizable en toda la aplicación.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
