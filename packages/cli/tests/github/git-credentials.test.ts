import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
// Keep the Windows empty global config out of the real ~/.aiusage.
vi.mock('../../src/config.js', async () => {
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')])
  return { AIUSAGE_DIR: mkdtempSync(join(tmpdir(), 'aiusage-dir-')) }
})
import { AIUSAGE_DIR as aiusageDir } from '../../src/config.js'
import { emptyGitConfigPath, gitCredentialOptions, gitFailureSummary, GitIsolationError } from '../../src/github/git-credentials.js'
const exec = promisify(execFile)
const dirs: string[] = []
const platform = process.platform
function stubPlatform(value: NodeJS.Platform) { Object.defineProperty(process, 'platform', { value, configurable: true }) }
afterEach(() => { vi.unstubAllEnvs(); stubPlatform(platform); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
afterAll(() => rmSync(aiusageDir, { recursive: true, force: true }))

function credential(action: string, input: string, cwd: string) {
  const options = gitCredentialOptions('owner/data', 'integration-secret')
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('git', [...options.args, 'credential', action], { cwd, env: options.env, windowsHide: true })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d)
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}
describe('real Git ephemeral credential helper', () => {
  it('provides credentials only over the Git protocol pipe and never persists them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiusage-git-helper-')); dirs.push(dir)
    await exec('git', ['init', dir])
    await exec('git', ['remote', 'add', 'origin', 'https://github.com/owner/data.git'], { cwd: dir })
    const local = gitCredentialOptions('owner/data')
    await exec('git', [...local.args, 'commit', '--allow-empty', '-m', 'sync test'], { cwd: dir, env: local.env })
    const prompt = 'protocol=https\nhost=github.com\npath=owner/data.git\n\n'
    const response = await credential('fill', prompt, dir)
    expect(response.code).toBe(0)
    expect(response.stdout).toContain('password=integration-secret')
    expect(response.stderr).not.toContain('integration-secret')
    await credential('approve', prompt.trimEnd() + '\nusername=x-access-token\npassword=integration-secret\n\n', dir)
    const config = readFileSync(join(dir, '.git/config'), 'utf8')
    expect(config).not.toContain('integration-secret'); expect(config).not.toContain('credential.helper')
    expect(config).toContain('https://github.com/owner/data.git')
    expect(JSON.stringify(gitCredentialOptions('owner/data', 'integration-secret').args)).not.toContain('integration-secret')
  })
  it.each(['protocol=https\nhost=evil.example\npath=owner/data.git\n\n', 'protocol=https\nhost=github.com\npath=other/data.git\n\n', 'protocol=http\nhost=github.com\npath=owner/data.git\n\n'])('refuses credentials for an unrelated destination', async input => {
    const dir = mkdtempSync(join(tmpdir(), 'aiusage-git-helper-')); dirs.push(dir)
    const result = await credential('fill', input, dir)
    expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).not.toContain('integration-secret')
  })
  it('disables inherited tracing and credential injection; local Git receives no token', () => {
    vi.stubEnv('GIT_TRACE', '1'); vi.stubEnv('GIT_CURL_VERBOSE', '1'); vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('AIUSAGE_GITHUB_TOKEN', 'inherited'); vi.stubEnv('AIUSAGE_GIT_CREDENTIAL', 'inherited')
    const options = gitCredentialOptions('owner/data')
    expect(options.env.GIT_TRACE).toBeUndefined(); expect(options.env.GIT_CURL_VERBOSE).toBeUndefined()
    expect(options.env.GIT_CONFIG_COUNT).toBeUndefined(); expect(options.env.AIUSAGE_GIT_CREDENTIAL).toBeUndefined()
    expect(options.env.AIUSAGE_GITHUB_TOKEN).toBeUndefined()
  })
})

describe('isolated Git config', () => {
  it('uses an aiusage-owned empty file for global config on Windows, never the NUL device', () => {
    stubPlatform('win32')
    const options = gitCredentialOptions('owner/data')
    expect(options.env.GIT_CONFIG_GLOBAL).toBe(join(aiusageDir, 'git-empty-config'))
    expect(options.env.GIT_CONFIG_GLOBAL).not.toMatch(/^nul$/i)
    expect(statSync(options.env.GIT_CONFIG_GLOBAL!).size).toBe(0)
    expect(options.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(options.args).toContain('core.hooksPath=/dev/null')
  })
  it.each(['linux', 'darwin'] as const)('keeps /dev/null for global config on %s', value => {
    stubPlatform(value)
    const options = gitCredentialOptions('owner/data')
    expect(options.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(options.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(options.args).toEqual(expect.arrayContaining(['credential.helper=', 'http.extraHeader=', 'http.followRedirects=false', 'core.hooksPath=/dev/null']))
  })
  it('creates the empty config once, reuses it, and truncates anything written to it', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiusage-empty-')); dirs.push(root)
    const dir = join(root, 'nested')
    const path = emptyGitConfigPath(dir)
    expect(readFileSync(path, 'utf8')).toBe('')
    expect(emptyGitConfigPath(dir)).toBe(path)
    writeFileSync(path, '[core]\n\thooksPath = /tmp/evil\n')
    expect(emptyGitConfigPath(dir)).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('')
  })
  it('refuses to use a non-file in place of the empty config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiusage-empty-')); dirs.push(dir)
    mkdirSync(join(dir, 'git-empty-config'))
    expect(() => emptyGitConfigPath(dir)).toThrow(GitIsolationError)
  })
  it('runs real Git with no global or system config and no hooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiusage-git-isolated-')); dirs.push(dir)
    await exec('git', ['init', dir])
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho hook-ran >&2\nexit 1\n', { mode: 0o755 })
    const options = gitCredentialOptions('owner/data')
    await exec('git', [...options.args, 'status'], { cwd: dir, env: options.env })
    const { stdout } = await exec('git', [...options.args, 'config', '--show-origin', '--list'], { cwd: dir, env: options.env })
    for (const line of stdout.split('\n').filter(Boolean)) expect(line).toMatch(/^(file:\.git\/config|command line:)/)
    await exec('git', [...options.args, 'commit', '--allow-empty', '-m', 'no hooks'], { cwd: dir, env: options.env })
  })
})

describe('gitFailureSummary', () => {
  it('returns the first fatal line, else the first error line', () => {
    expect(gitFailureSummary({ stderr: "warning: x\nfatal: unable to access 'NUL': Invalid argument\n" })).toBe("fatal: unable to access 'NUL': Invalid argument")
    expect(gitFailureSummary({ stderr: 'error: failed to push some refs\n' })).toBe('error: failed to push some refs')
    expect(gitFailureSummary({ stderr: 'remote: hello\n' })).toBeUndefined()
    expect(gitFailureSummary(new Error('no stderr'))).toBeUndefined()
  })
  it('redacts the token, GitHub token shapes and URL userinfo', () => {
    const stderr = "fatal: unable to access 'https://x-access-token:s3cret-value@github.com/o/r.git/' (s3cret-value ghs_abcDEF123 github_pat_11AB_cd)\n"
    expect(gitFailureSummary({ stderr }, 's3cret-value')).toBe("fatal: unable to access 'https://github.com/o/r.git/' ([redacted] [redacted] [redacted])")
  })
  it('never echoes credential-helper configuration or server-relayed errors', () => {
    expect(gitFailureSummary({ stderr: "fatal: bad config value for 'credential.helper': !node -e 'if(process.argv[1]===\"get\")'\n" })).toBe('fatal: credential helper failed')
    expect(gitFailureSummary({ stderr: 'fatal: remote error: token ghs_x was echoed\n' })).toBe('fatal: remote error')
  })
  it('describes a missing git binary and a timeout', () => {
    expect(gitFailureSummary({ code: 'ENOENT' })).toBe('git was not found on PATH')
    expect(gitFailureSummary({ killed: true, stderr: '' })).toBe('git timed out')
  })
  it('truncates long lines and strips control characters', () => {
    const summary = gitFailureSummary({ stderr: `fatal: \u001b[31m${'x'.repeat(400)}\n` })!
    expect(summary.length).toBe(200)
    expect(summary).not.toContain('\u001b')
  })
})
