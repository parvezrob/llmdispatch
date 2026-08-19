import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // `test/consumers` is deliberately absent: those are project templates that
          // are copied out and installed against the packed tarball, not tests to run
          // from here. `scripts/test-consumers.mjs` drives them.
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
        },
      },
      {
        // No integration tests exist yet, which is why `test:integration` passes
        // `--passWithNoTests`. That flag comes off when the first one lands.
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/core/**/*.ts',
        'src/errors/**/*.ts',
        'src/stores/**/*.ts',
        'src/conformance/**/*.ts',
      ],
      // `text` prints nothing at all when every measured file is fully covered, so
      // `text-summary` is what makes a green run say a number out loud.
      reporter: ['text', 'text-summary', 'lcov'],
      // Held to a threshold: what decides, and what is thrown. The stores and the harnesses
      // are measured and reported so their number is visible, and gated later rather than at
      // 90 % on the day they land — a ratchet only ever goes up.
      thresholds: {
        'src/core/**/*.ts': { lines: 90, branches: 90 },
        'src/errors/**/*.ts': { lines: 90, branches: 90 },
      },
    },
  },
})
