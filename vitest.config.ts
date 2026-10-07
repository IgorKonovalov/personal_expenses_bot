import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'webapp/src/**/*.test.ts'],
    environment: 'node',
    // Fixture users live in Europe/Belgrade, so the process runs far from it (UTC+14). Code
    // that reads the host's local time instead of the user's timezone then fails here.
    env: { TZ: 'Pacific/Kiritimati' },
  },
});
