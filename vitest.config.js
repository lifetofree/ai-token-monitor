// vitest.config.js
// Pure-function test suite for the AI Token Monitor. See `tests/format.test.js`
// for the rationale on why these re-implement the documented formulas
// (canonical implementations live in app.js, which is a browser script and
// not directly importable).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: false,
  },
});
