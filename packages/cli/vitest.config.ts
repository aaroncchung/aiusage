import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Test files run in child processes. tests/setup-home.ts redirects the home
    // directory through process.env, and homedir() does not see that change
    // from a worker thread.
    pool: 'forks',
    // setup-home.ts must stay first: it redirects the home directory before
    // any source module resolves a path from it.
    setupFiles: ['tests/setup-home.ts', 'tests/setup.ts'],
  },
})
