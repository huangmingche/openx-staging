import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { deduplicateStagedWorkspacePackages, deploymentBuildPolicy, materializeStagedLinks, withDeploymentBuildPolicy } from './build-exe-for-python-sdk-staging.ts'

const temporaryDirectories: string[] = []
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(prefix: string) {
  const workspace = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(workspace)
  return workspace
}

async function policyHookFixture(globalHook = 'undefined') {
  const workspace = await fixture('dsh-python-policy-hook-')
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), JSON.stringify({ allowBuilds: { allowed: true, denied: false } }))
  const pnpm = join(workspace, 'pnpm.cjs')
  await writeFile(pnpm, `if (process.argv.slice(2).join(' ') !== 'config get global-pnpmfile') process.exit(2);\nprocess.stdout.write(${JSON.stringify(globalHook + '\n')});\n`)
  vi.stubEnv('npm_execpath', pnpm)
  return workspace
}

it('preserves typed build permissions and other configuration, then removes the successful deployment hook', async () => {
  const workspace = await policyHookFixture()
  let directory = ''
  const require = createRequire(import.meta.url)
  const result = await withDeploymentBuildPolicy(workspace, async (hook) => {
    directory = dirname(hook)
    const module = require(hook) as { hooks: { updateConfig: (config: object) => object } }
    try {
      expect(module.hooks.updateConfig({ registry: 'https://registry.example/' })).toEqual({
        registry: 'https://registry.example/', allowBuilds: { allowed: true, denied: false },
      })
    } finally {
      Reflect.deleteProperty(require.cache, require.resolve(hook))
      Reflect.deleteProperty(require.cache, require.resolve(join(directory, 'policy.json')))
    }
    return 'deployed'
  })
  expect(result).toBe('deployed')
  expect(directory).not.toBe('')
  expect(existsSync(directory)).toBe(false)
})

it('removes its policy and hook after deployment fails', async () => {
  const workspace = await policyHookFixture()
  let directory = ''
  const failure = new Error('deployment failed')
  await expect(withDeploymentBuildPolicy(workspace, async (hook) => {
    directory = dirname(hook)
    expect(await readFile(join(directory, 'policy.json'), 'utf8')).toContain('"denied":false')
    throw failure
  })).rejects.toBe(failure)
  expect(directory).not.toBe('')
  expect(existsSync(directory)).toBe(false)
})

it('rejects an existing global hook without executing deployment or overwriting it', async () => {
  const existing = await fixture('dsh-python-existing-hook-')
  const hook = join(existing, 'pnpmfile.cjs')
  await writeFile(hook, 'module.exports = {}\n')
  const workspace = await policyHookFixture(hook)
  const deployment = vi.fn(async () => {})
  await expect(withDeploymentBuildPolicy(workspace, deployment)).rejects.toThrow('configured global-pnpmfile cannot be replaced')
  expect(deployment).not.toHaveBeenCalled()
  expect(await readFile(hook, 'utf8')).toBe('module.exports = {}\n')
})

it('preserves allow and deny decisions for deployed workspace file URLs and other selectors', async () => {
  const workspace = await fixture('dsh-python-build-policy-')
  const allowed = join(workspace, 'packages', 'allowed space')
  const denied = join(workspace, 'packages', 'denied')
  const outside = await fixture('dsh-python-outside-policy-')
  for (const path of [allowed, denied]) await mkdir(path, { recursive: true })
  const unchanged = {
    esbuild: true,
    '@fixture/*': false,
    'dependency@1.0.0': false,
    'unreviewed': 'review required',
    [`outside@file:${relative(workspace, outside)}`]: true,
    [`existing@${pathToFileURL(allowed).href}`]: false,
  }
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), JSON.stringify({ allowBuilds: {
    ...unchanged,
    'allowed@file:packages/allowed space': true,
    'denied@file:packages/denied': false,
  } }))

  expect(await deploymentBuildPolicy(workspace)).toEqual({
    ...unchanged,
    [`allowed@${pathToFileURL(await realpath(allowed)).href}`]: true,
    [`denied@${pathToFileURL(await realpath(denied)).href}`]: false,
  })
})

it('does not grant a workspace identity to a link targeting an external package', async () => {
  const workspace = await fixture('dsh-python-link-policy-')
  const outside = await fixture('dsh-python-external-policy-')
  await symlink(outside, join(workspace, 'external'), directoryLinkType)
  const allowBuilds = { 'external@file:external': true }
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), JSON.stringify({ allowBuilds }))
  expect(await deploymentBuildPolicy(workspace)).toEqual(allowBuilds)
})

it.each([{}, { allowBuilds: [] }, { allowBuilds: { invalid: 1 } }])('rejects invalid build policy: %j', async (manifest) => {
  const workspace = await fixture('dsh-python-invalid-policy-')
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), JSON.stringify(manifest))
  await expect(deploymentBuildPolicy(workspace)).rejects.toThrow(/build decisions|build decision/)
})

it('rejects conflicting permissions for the same deployed package', async () => {
  const workspace = await fixture('dsh-python-conflicting-policy-')
  await mkdir(join(workspace, 'package'))
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), JSON.stringify({ allowBuilds: {
    'fixture@file:package': true,
    'fixture@file:./package': false,
  } }))
  await expect(deploymentBuildPolicy(workspace)).rejects.toThrow('conflicting build decisions')
})

/** List every symbolic link below a directory. */
async function listSymlinks(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) return [path]
    if (entry.isDirectory()) return listSymlinks(path)
    return []
  }))
  return nested.flat()
}

it('drops the deploy root link that points back into the payload', async () => {
  const workspace = await fixture('dsh-python-staging-root-')
  const project = join(workspace, 'python', 'sdk-runtime')
  const staging = join(project, 'src', 'runtime', 'node')
  await mkdir(join(staging, 'node_modules'), { recursive: true })
  await writeFile(join(project, 'package.json'), '{"name":"dsh-python-runtime-closure"}\n')
  await symlink(project, join(staging, 'node_modules', 'dsh-python-runtime-closure'), directoryLinkType)

  await materializeStagedLinks(staging)

  expect(existsSync(join(staging, 'node_modules', 'dsh-python-runtime-closure'))).toBe(false)
  await expect(readFile(join(project, 'package.json'), 'utf8')).resolves.toContain('dsh-python-runtime-closure')
})

it('copies workspace package links as files and removes command shims', async () => {
  const workspace = await fixture('dsh-python-staging-packages-')
  const staging = join(workspace, 'runtime', 'node')
  const packageDirectory = join(workspace, 'packages', 'dsh-base')
  await mkdir(join(packageDirectory, 'lib'), { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), '{"name":"@deepseek-ai/dsh-base"}\n')
  await writeFile(join(packageDirectory, 'lib', 'index.js'), 'export {}\n')
  await mkdir(join(staging, 'node_modules', '@deepseek-ai'), { recursive: true })
  await mkdir(join(staging, 'node_modules', '.bin'), { recursive: true })
  await writeFile(join(staging, 'package.json'), '{"name":"dsh-python-runtime-closure"}\n')
  await symlink(packageDirectory, join(staging, 'node_modules', '@deepseek-ai', 'dsh-base'), directoryLinkType)
  await symlink(packageDirectory, join(staging, 'node_modules', '.bin', 'dsh'), directoryLinkType)

  await materializeStagedLinks(staging)

  expect(existsSync(join(staging, 'node_modules', '.bin'))).toBe(false)
  await expect(readFile(join(staging, 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js'), 'utf8'))
    .resolves.toBe('export {}\n')
  expect(await listSymlinks(staging)).toEqual([])
})

it.each(['workspace', 'staging'])('shares identical workspace packages with %s-relative metadata while retaining distinct peers and third-party copies', async (base) => {
  const workspace = await fixture('dsh-python-staging-dedupe-')
  const staging = join(workspace, 'payload')
  const modules = join(staging, 'node_modules')
  const root = join(modules, '@fixture', 'tools')
  const duplicate = join(modules, 'app', 'node_modules', '@fixture', 'tools')
  const differentPeers = join(modules, 'other', 'node_modules', '@fixture', 'tools')
  const external = join(modules, 'external')
  const externalCopy = join(modules, 'app', 'node_modules', 'external')
  for (const directory of [root, duplicate, differentPeers, external, externalCopy]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.js'), 'exports.scheduler = Symbol("scheduler")\n')
  }
  const metadataRoot = base === 'staging' ? staging : workspace
  const locations = (paths: string[]) => paths.map(path => relative(metadataRoot, path))
  await writeFile(join(modules, '.modules.yaml'), JSON.stringify({ hoistedLocations: {
    '@fixture/tools@file:packages/tools(peer@1)': locations([root, duplicate]),
    '@fixture/tools@file:packages/tools(peer@2)': locations([differentPeers]),
    'external@1.0.0(@fixture/tools@file:packages/tools)': locations([external, externalCopy]),
  } }))

  await deduplicateStagedWorkspacePackages(staging, metadataRoot)

  expect(existsSync(duplicate)).toBe(false)
  for (const directory of [root, differentPeers, external, externalCopy]) {
    expect(existsSync(join(directory, 'index.js'))).toBe(true)
  }
  const fromRoot = createRequire(join(staging, 'entry.cjs'))
  const fromApp = createRequire(join(modules, 'app', 'entry.cjs'))
  const fromOther = createRequire(join(modules, 'other', 'entry.cjs'))
  expect(fromApp('@fixture/tools')).toBe(fromRoot('@fixture/tools'))
  expect(fromOther('@fixture/tools')).not.toBe(fromRoot('@fixture/tools'))
})

it('rejects invalid deployment metadata before removing any package', async () => {
  const workspace = await fixture('dsh-python-staging-metadata-')
  const staging = join(workspace, 'payload')
  const modules = join(staging, 'node_modules')
  const root = join(modules, 'tools')
  const duplicate = join(modules, 'app', 'node_modules', 'tools')
  const outside = join(workspace, 'source')
  for (const directory of [root, duplicate, outside]) await mkdir(directory, { recursive: true })
  const valid = { 'tools@file:packages/tools': [root, duplicate].map(path => relative(workspace, path)) }
  for (const invalid of [
    {},
    { hoistedLocations: { invalid: [42] } },
    { hoistedLocations: { ...valid, 'other@file:packages/other': [relative(workspace, outside)] } },
  ]) {
    await writeFile(join(modules, '.modules.yaml'), JSON.stringify(invalid))
    await expect(deduplicateStagedWorkspacePackages(staging, workspace)).rejects.toThrow('hoistedLocations')
    expect(existsSync(duplicate)).toBe(true)
    expect(existsSync(outside)).toBe(true)
  }
})
