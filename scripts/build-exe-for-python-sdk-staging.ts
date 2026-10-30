/** Prepare a symlink-free executable runtime payload with shared workspace module instances. */
import { execFile } from 'node:child_process'
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import { pnpmInvocation } from './executable-packaging.ts'

/**
 * Run deployment with reviewed build decisions and remove its temporary global hook afterward.
 * An existing global hook is rejected without modification; workspace-local hooks remain selected.
 * @param workspace - Source workspace containing the reviewed pnpm build policy.
 * @param operation - Deployment operation that settles before its hook is removed.
 * @returns The deployment operation's result.
 */
export async function withDeploymentBuildPolicy<T>(workspace: string, operation: (hook: string) => Promise<T>): Promise<T> {
  const policy = await deploymentBuildPolicy(workspace)
  const [command, args] = pnpmInvocation(['config', 'get', 'global-pnpmfile'])
  const { stdout } = await promisify(execFile)(command, args, { cwd: workspace, timeout: 60_000 })
  if (stdout.trim() !== '' && stdout.trim() !== 'undefined') {
    throw new Error('build-exe-for-python-sdk: a configured global-pnpmfile cannot be replaced by the deployment build policy.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-python-deploy-policy-'))
  const hook = join(directory, 'pnpmfile.cjs')
  try {
    await writeFile(join(directory, 'policy.json'), JSON.stringify(policy) + '\n')
    await writeFile(hook, 'module.exports = { hooks: { updateConfig: config => ({ ...config, allowBuilds: require("./policy.json") }) } };\n')
    return await operation(hook)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Preserve build decisions while matching deployed workspace packages by their absolute file URLs.
 * Non-workspace selectors retain their existing identities.
 * @param workspace - Source workspace containing the reviewed pnpm build policy.
 * @returns Deployment-local build policy without additional package permissions.
 */
export async function deploymentBuildPolicy(workspace: string): Promise<Record<string, boolean | string>> {
  const base = await realpath(workspace)
  const file = join(base, 'pnpm-workspace.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('allowBuilds' in manifest)
    || typeof manifest.allowBuilds !== 'object' || manifest.allowBuilds === null || Array.isArray(manifest.allowBuilds)) {
    throw new Error(`${file}: allowBuilds must map package selectors to build decisions`)
  }
  const entries = await Promise.all(Object.entries(manifest.allowBuilds).map(async ([selector, decision]) => {
    if (typeof decision !== 'boolean' && typeof decision !== 'string') {
      throw new Error(`${file}: invalid build decision for ${selector}`)
    }
    const marker = selector.lastIndexOf('@file:')
    if (marker < 0 || selector.slice(marker).startsWith('@file://')) return [selector, decision] as const
    const directory = await realpath(resolve(base, selector.slice(marker + '@file:'.length)))
    const local = relative(base, directory)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || !(await lstat(directory)).isDirectory()) {
      return [selector, decision] as const
    }
    return [`${selector.slice(0, marker)}@${pathToFileURL(directory).href}`, decision] as const
  }))
  const policy = new Map<string, boolean | string>()
  for (const [selector, decision] of entries) {
    if (policy.has(selector) && policy.get(selector) !== decision) {
      throw new Error(`${file}: conflicting build decisions for ${selector}`)
    }
    policy.set(selector, decision)
  }
  return Object.fromEntries(policy)
}

function isHoistedLocations(value: unknown): value is Record<string, string[]> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(paths => Array.isArray(paths)
      && paths.every((path: unknown) => typeof path === 'string'))
}

/**
 * Share root workspace packages with nested consumers of the same pnpm dependency identity.
 * Different peer resolutions and third-party packages keep their installed locations.
 * All metadata paths are checked before deletion; the caller first materializes links.
 * @param staging - Symlink-free deployed payload root.
 * @param metadataRoot - Directory relative to which pnpm records hoisted locations.
 */
export async function deduplicateStagedWorkspacePackages(staging: string, metadataRoot: string): Promise<void> {
  const modules = resolve(staging, 'node_modules')
  const file = join(modules, '.modules.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('hoistedLocations' in manifest)
    || !isHoistedLocations(manifest.hoistedLocations)) {
    throw new Error(`${file}: hoistedLocations must map dependency identities to path lists`)
  }
  const duplicates: string[] = []
  for (const [identity, locations] of Object.entries(manifest.hoistedLocations)) {
    const paths = locations.map((location) => {
      const path = resolve(metadataRoot, location)
      const local = relative(modules, path)
      if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new Error(`${file}: hoistedLocations path is outside deployed node_modules: ${location}`)
      }
      return { path, parts: local.split(sep) }
    })
    if (!/^(?:@[^/]+\/)?[^@()]+@file:/.test(identity)) continue
    const root = paths.find(({ parts }) => parts.length === (parts[0]?.startsWith('@') === true ? 2 : 1))
    if (root === undefined) continue
    if (!(await lstat(root.path)).isDirectory()) {
      throw new Error(`${file}: hoistedLocations root package is not a directory: ${root.path}`)
    }
    duplicates.push(...paths.filter(({ path }) => path !== root.path).map(({ path }) => path))
  }
  for (const path of duplicates) await rm(path, { recursive: true, force: true })
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace every deploy-time package link below the staged payload with real files.
 *
 * Legacy deploy links workspace packages into the target's `node_modules`, and
 * those links must survive packaging as files. One link is not a package: when
 * the deploy target sits inside the deployed project, pnpm links that project
 * into its own `node_modules`. Dereferencing it would copy the payload into
 * itself, and the packaged payload never carries the project source, so the
 * entry is dropped instead.
 * @param staging - Deployed payload root whose `node_modules` becomes symlink-free.
 */
export async function materializeStagedLinks(staging: string): Promise<void> {
  const payload = await realpath(staging)
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      const directory = join(nodeModules, ...segments.slice(0, binIndex + 1))
      if ((await lstat(directory)).isSymbolicLink()) await unlink(directory)
      else await rm(directory, { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    if (payload === source || payload.startsWith(source + sep)) {
      await unlink(destination)
      remaining = await findSymlink(nodeModules)
      continue
    }
    const nestedNodeModules = join(source, 'node_modules')
    await unlink(destination)
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}
