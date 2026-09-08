// Script de build de Netlify — Inyección segura de variables de entorno.
//
// Objetivo:
//   Generar el archivo js/env.js en tiempo de build a partir de las variables
//   de entorno configuradas en el panel de Netlify (Site settings > Environment).
//   De esta forma los secretos NUNCA se escriben en el código fuente versionado.
//
// Variables requeridas (definidas en Netlify, no en el repositorio):
//   - SUPABASE_URL       : URL del proyecto Supabase.
//   - SUPABASE_ANON_KEY  : clave pública anónima de Supabase.
//
// El archivo generado expone las variables como window.__SUPABASE_URL__ y
// window.__SUPABASE_ANON_KEY__, que son consumidas por js/config.js.
//
// Ejecución: node scripts/inject-env.js (configurado en netlify.toml como build command).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resuelve la ruta raíz del proyecto de forma independiente del cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const outputPath = join(projectRoot, 'js', 'env.js');

// Lee las variables de entorno inyectadas por Netlify.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Falla el build de forma explícita si faltan variables; así se evita
// desplegar un frontend sin configuración válida de Supabase.
const missing = [];
if (!supabaseUrl) missing.push('SUPABASE_URL');
if (!supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');

if (missing.length > 0) {
  console.error(
    `[inject-env] Error: faltan variables de entorno requeridas: ${missing.join(', ')}.\n` +
      '[inject-env] Configúrelas en Netlify (Site settings > Environment) antes de desplegar.'
  );
  process.exit(1);
}

// Serializa los valores con JSON.stringify para escaparlos de forma segura
// y evitar inyección de código en el archivo generado.
const fileContent =
  '// Archivo generado automáticamente por scripts/inject-env.js durante el build de Netlify.\n' +
  '// NO editar manualmente ni versionar: contiene la configuración pública de Supabase.\n' +
  `window.__SUPABASE_URL__ = ${JSON.stringify(supabaseUrl)};\n` +
  `window.__SUPABASE_ANON_KEY__ = ${JSON.stringify(supabaseAnonKey)};\n`;

// Garantiza la existencia del directorio js/ antes de escribir.
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, fileContent, 'utf8');

// No se registran los valores de los secretos en el log del build.
console.log('[inject-env] js/env.js generado correctamente con la configuración de Supabase.');
