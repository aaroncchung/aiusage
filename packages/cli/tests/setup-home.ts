import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Every test file gets its own empty home directory. src/config.ts resolves
// ~/.aiusage from homedir() when it is first imported, so this has to run
// before any source module loads: it is the first entry in setupFiles and
// imports nothing from src. Without it, a test that reaches loadConfig() or
// saveConfig() reads and rewrites the real ~/.aiusage/config.json of whoever
// runs the suite.
const testHome = mkdtempSync(join(tmpdir(), 'aiusage-test-home-'))

// homedir() reads HOME on POSIX and USERPROFILE on Windows.
process.env.HOME = testHome
process.env.USERPROFILE = testHome

// Removed once the file's tests have run. A test file that fails to load, or a
// run that is killed, never reaches this hook and leaves its directory behind
// in the OS temp directory.
afterAll(() => {
  try {
    // The retries cover a file that Windows has not finished releasing.
    rmSync(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    // A leftover temp directory is harmless; it should not fail the test file.
  }
})
