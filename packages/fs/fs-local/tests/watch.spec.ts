/** Watch initialization and asynchronous release at the Chokidar adapter. */
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { EventEmitter } from 'node:events'
import * as nativeFs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as chokidar from 'chokidar'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocalFileSystem } from '../src/index.ts'

vi.mock('chokidar', async (importOriginal) => {
  const original = await importOriginal<typeof import('chokidar')>()
  return { ...original, watch: vi.fn(original.watch) }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, watch: vi.fn(original.watch) }
})

const originalPlatform = process.platform

afterEach(() => {
  Reflect.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
})

class NativeWatcher extends EventEmitter implements nativeFs.FSWatcher {
  close = vi.fn(() => { this.emit('close') })
  ref(): this { return this }
  unref(): this { return this }
}

async function setup(kind: 'file' | 'directory' | 'missing' = 'file') {
  const watcher = new chokidar.FSWatcher()
  onTestFinished(() => watcher.close())
  const started = Promise.withResolvers<undefined>()
  const watch = vi.mocked(chokidar.watch).mockReset().mockImplementation(() => {
    started.resolve(undefined)
    return watcher
  })
  const nativeWatcher = new NativeWatcher()
  onTestFinished(() => { nativeWatcher.emit('close') })
  const nativeWatch = vi.mocked(nativeFs.watch).mockReset().mockReturnValue(nativeWatcher)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem)
  const path = resolve('/workspace/file.txt')
  const target = { targetKey: FsTargetKey(path), displayPath: 'file.txt' }
  const stat = vi.spyOn(ctx.fs, 'stat').mockResolvedValue(kind === 'missing'
    ? undefined : { type: kind, version: FsVersion('v1'), size: 1 })
  const changed = vi.fn<(error?: Error) => void>()
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  return { watcher, watch, nativeWatcher, nativeWatch, fs: ctx.fs, target, changed, controller, path, stat, started: started.promise }
}

describe('local filesystem watch', () => {
  it.each(['file', 'missing'] as const)('waits for the parent watch of a %s target and awaits closure', async (kind) => {
    const h = await setup(kind)
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    const ignored = h.watch.mock.calls[0]![1]!.ignored
    if (typeof ignored !== 'function') throw new Error('Expected a target filter')
    expect(h.watch).toHaveBeenCalledExactlyOnceWith(dirname(h.path), { ignoreInitial: true, depth: 0, ignored })
    expect(ignored(dirname(h.path))).toBe(false)
    expect(ignored(h.path)).toBe(false)
    expect(ignored(join(dirname(h.path), 'unrelated.txt'))).toBe(true)
    let ready = false
    void pending.then(() => { ready = true })
    await Promise.resolve(undefined)
    expect(ready).toBe(false)
    h.watcher.emit('ready')
    const close = await pending
    h.watcher.emit('all', 'addDir', dirname(h.path))
    h.watcher.emit('all', 'change', join(dirname(h.path), 'unrelated.txt'))
    expect(h.changed).not.toHaveBeenCalled()
    h.watcher.emit('all', 'change', h.path)
    expect(h.changed).toHaveBeenCalledExactlyOnceWith()
    const closed = Promise.withResolvers<undefined>()
    onTestFinished(() => { closed.resolve(undefined) })
    const nativeClose = h.watcher.close.bind(h.watcher)
    vi.spyOn(h.watcher, 'close').mockImplementationOnce(async () => { await closed.promise; await nativeClose() })
    const closing = close()
    try {
      expect(h.watcher.closed).toBe(false)
    } finally {
      closed.resolve(undefined)
      await closing
    }
    expect(h.watcher.closed).toBe(true)
  })

  it('watches a directory itself without filtering its direct entries', async () => {
    const h = await setup('directory')
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    expect(h.watch.mock.calls[0]![0]).toBe(h.path)
    const ignored = h.watch.mock.calls[0]![1]!.ignored
    if (typeof ignored !== 'function') throw new Error('Expected a target filter')
    expect(ignored(join(h.path, 'child.txt'))).toBe(false)
    h.watcher.emit('ready')
    const close = await pending
    h.watcher.emit('all', 'change', join(h.path, 'child.txt'))
    expect(h.changed).toHaveBeenCalledExactlyOnceWith()
    await close()
  })

  it('does not acquire a watcher when cancelled during metadata lookup', async () => {
    const h = await setup()
    const metadata = Promise.withResolvers<undefined>()
    h.stat.mockReturnValueOnce(metadata.promise)
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    h.controller.abort()
    metadata.resolve(undefined)
    await rejected
    expect(h.watch).not.toHaveBeenCalled()
  })

  it('rejects an already-cancelled initialization without acquiring a watcher', async () => {
    const h = await setup()
    h.controller.abort()
    await expect(h.fs.watch(h.target, h.changed, h.controller.signal)).rejects.toThrow()
    expect(h.watch).not.toHaveBeenCalled()
  })

  it('closes the acquired watcher when initialization is cancelled', async () => {
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await h.started
    h.controller.abort()
    await rejected
    expect(h.watcher.closed).toBe(true)
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('reports initialization errors and closes before rejecting', async () => {
    const h = await setup()
    const error = new Error('watch failed')
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toBe(error)
    await h.started
    h.watcher.emit('error', error)
    await rejected
    expect(h.changed).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.watcher.closed).toBe(true)
  })

  it('normalizes watcher errors after initialization', async () => {
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    h.watcher.emit('ready')
    const close = await pending
    const error = new Error('watch failed')
    h.watcher.emit('error', error)
    // EventEmitter callbacks can receive non-Error values from the external watcher.
    h.watcher.emit('error', 'watch unavailable')
    expect(h.changed.mock.calls).toEqual([[error], [new Error('watch unavailable')]])
    await close()
    expect(h.watcher.closed).toBe(true)
  })

  it.each(['file', 'directory', 'missing'] as const)('waits for the Darwin native close barrier before reporting a %s watch ready', async (kind) => {
    Reflect.defineProperty(process, 'platform', { value: 'darwin' })
    const h = await setup(kind)
    const closing = Promise.withResolvers<undefined>()
    h.nativeWatcher.close.mockImplementation(() => { closing.resolve(undefined) })
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    expect(h.nativeWatch).not.toHaveBeenCalled()
    h.watcher.emit('ready')
    try {
      const first = await Promise.race([
        closing.promise.then(() => 'closing'),
        pending.then(() => 'ready'),
      ])
      expect(first).toBe('closing')
      expect(h.nativeWatch.mock.calls.map(([path]) => path)).toEqual([
        kind === 'directory' ? h.path : dirname(h.path),
      ])
      expect(h.nativeWatcher.close).toHaveBeenCalledTimes(1)
      let ready = false
      void pending.then(() => { ready = true })
      await Promise.resolve()
      expect(ready).toBe(false)
      expect(h.changed).not.toHaveBeenCalled()
    } finally {
      h.nativeWatcher.emit('close')
      await (await pending)()
    }
    expect(h.watcher.closed).toBe(true)
  })

  it.each(['linux', 'win32'] as const)('uses Chokidar readiness without a native barrier on %s', async (platform) => {
    Reflect.defineProperty(process, 'platform', { value: platform })
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    h.watcher.emit('ready')
    const close = await pending
    expect(h.nativeWatch).not.toHaveBeenCalled()
    await close()
    expect(h.watcher.closed).toBe(true)
  })

  it('uses an existing ancestor when the Darwin watch root is missing', async () => {
    Reflect.defineProperty(process, 'platform', { value: 'darwin' })
    const h = await setup('missing')
    h.nativeWatch.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing parent'), { code: 'ENOENT' })
    })
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    h.watcher.emit('ready')
    const close = await pending
    expect(h.nativeWatch.mock.calls.map(([path]) => path)).toEqual([
      dirname(h.path), dirname(dirname(h.path)),
    ])
    expect(h.nativeWatcher.close).toHaveBeenCalledTimes(1)
    expect(h.changed).not.toHaveBeenCalled()
    await close()
  })

  it.each([
    { label: 'uncoded error', error: new Error('native watch failed') },
    { label: 'permission error', error: Object.assign(new Error('denied'), { code: 'EACCES' }) },
    { label: 'non-directory error', error: Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }) },
    { label: 'non-Error failure', error: 'native watch failed' },
  ])('closes the main watcher and propagates a native barrier $label', async ({ error }) => {
    Reflect.defineProperty(process, 'platform', { value: 'darwin' })
    const h = await setup()
    h.nativeWatch.mockImplementation(() => { throw error })
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toBe(error)
    await h.started
    h.watcher.emit('ready')
    await rejected
    expect(h.nativeWatch).toHaveBeenCalledTimes(1)
    expect(h.nativeWatcher.close).not.toHaveBeenCalled()
    expect(h.watcher.closed).toBe(true)
  })

  it('propagates a missing filesystem root without retrying it indefinitely', async () => {
    Reflect.defineProperty(process, 'platform', { value: 'darwin' })
    const h = await setup('missing')
    const error = Object.assign(new Error('missing root'), { code: 'ENOENT' })
    h.nativeWatch.mockImplementation(() => { throw error })
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toBe(error)
    await h.started
    h.watcher.emit('ready')
    await rejected
    expect(h.nativeWatch.mock.calls.map(([path]) => path)).toEqual([
      dirname(h.path), dirname(dirname(h.path)),
    ])
    expect(h.watcher.closed).toBe(true)
  })

  it('closes the main watcher when the native barrier emits an error during closure', async () => {
    Reflect.defineProperty(process, 'platform', { value: 'darwin' })
    const h = await setup()
    const error = new Error('native close failed')
    h.nativeWatcher.close.mockImplementation(() => { h.nativeWatcher.emit('error', error) })
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toBe(error)
    await h.started
    h.watcher.emit('ready')
    await rejected
    expect(h.nativeWatcher.close).toHaveBeenCalledTimes(1)
    expect(h.nativeWatcher.listenerCount('close')).toBe(0)
    expect(h.watcher.closed).toBe(true)
  })

  it('does not acquire a native barrier when cancelled as Chokidar becomes ready', async () => {
    Reflect.defineProperty(process, 'platform', { value: 'darwin' })
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await h.started
    h.watcher.emit('ready')
    h.controller.abort()
    await rejected
    expect(h.nativeWatch).not.toHaveBeenCalled()
    expect(h.watcher.closed).toBe(true)
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('closes both watchers when cancelled while the Darwin barrier is closing', async () => {
    Reflect.defineProperty(process, 'platform', { value: 'darwin' })
    const h = await setup()
    const closing = Promise.withResolvers<undefined>()
    h.nativeWatcher.close.mockImplementation(() => { closing.resolve(undefined) })
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await h.started
    h.watcher.emit('ready')
    await closing.promise
    h.controller.abort()
    h.nativeWatcher.emit('close')
    await rejected
    expect(h.nativeWatcher.close).toHaveBeenCalledTimes(1)
    expect(h.watcher.closed).toBe(true)
    expect(h.changed).not.toHaveBeenCalled()
  })
})
