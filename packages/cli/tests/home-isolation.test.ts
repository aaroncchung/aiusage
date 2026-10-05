import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { AIUSAGE_DIR, CONFIG_PATH, loadConfig, saveConfig } from '../src/config.js'

function expectTemporaryHome(dir: string): void {
  expect(dirname(dir)).toBe(tmpdir())
  expect(basename(dir)).toMatch(/^aiusage-test-home-/)
}

describe('test home isolation', () => {
  it('runs each test file against a temporary home directory', () => {
    expectTemporaryHome(homedir())
  })

  it('resolves the aiusage directory inside the temporary home', () => {
    expect(AIUSAGE_DIR).toBe(join(homedir(), '.aiusage'))
    expect(CONFIG_PATH).toBe(join(homedir(), '.aiusage', 'config.json'))
  })

  it('starts without a config and keeps saved config inside the temporary home', () => {
    // saveConfig() writes to the path src/config.ts resolved when it was
    // imported, which is not necessarily under the current homedir(). Check
    // that path itself, so this throws before writing if it is a real home.
    expect(dirname(CONFIG_PATH)).toBe(AIUSAGE_DIR)
    expectTemporaryHome(dirname(AIUSAGE_DIR))
    expect(loadConfig()).toBeNull()

    saveConfig({ device: 'home-isolation-test' })

    expect(existsSync(CONFIG_PATH)).toBe(true)
    expect(loadConfig()).toEqual({ device: 'home-isolation-test' })
  })
})
