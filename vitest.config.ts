import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('./migrations/outbox');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // The outbox on real D1, in workerd.
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: '2026-11-23',
              d1Databases: ['DB'],
              bindings: { TEST_MIGRATIONS: migrations },
            },
          }),
        ],
        test: {
          name: 'd1',
          include: ['tests/d1/*.test.ts'],
          setupFiles: ['./tests/d1/setup.ts'],
        },
      },
    ],
  },
});
