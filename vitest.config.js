import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Entorno de ejecución: node (compatible con ES Modules sin DOM)
    environment: 'node',

    // Inclusión de archivos de test
    include: ['**/*.test.js', '**/*.spec.js'],

    // Exclusiones
    exclude: [
      'node_modules/**',
      'supabase/**',
      'dist/**'
    ],

    // Configuración de property-based tests (fast-check)
    // numRuns se controla directamente en cada test con { numRuns: 200 }

    // Cobertura de código
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['js/**/*.js'],
      exclude: ['js/config.js', 'node_modules/**']
    },

    // Soporte completo para ES Modules
    globals: false
  }
});
