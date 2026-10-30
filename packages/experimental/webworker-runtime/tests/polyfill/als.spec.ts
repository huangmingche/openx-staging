/**
 * Sync-stack AsyncLocalStorage semantics plus the causality faces the module
 * loader's `await` rewriting consumes: run boundaries, ambient snapshots, and
 * the context root the tunnel dispatches at.
 */
import { describe, expect, it } from 'vitest'
import {
  AsyncLocalStorage, alsCausality, captureAsyncContext, runAtAsyncContextRoot, runWithAsyncContext,
} from '../../src/node/builtin_modules/implemented/async_hooks.ts'

describe('AsyncLocalStorage', () => {
  it('publishes the store inside run and clears it outside', () => {
    const als = new AsyncLocalStorage<string>()
    expect(als.getStore()).toBeUndefined()
    const returned = als.run('inner', () => {
      expect(als.getStore()).toBe('inner')
      return 42
    })
    expect(returned).toBe(42)
    expect(als.getStore()).toBeUndefined()
  })

  it('shadows and restores across nested boundaries', () => {
    const als = new AsyncLocalStorage<string>()
    als.run('outer', () => {
      expect(als.getStore()).toBe('outer')
      als.run('inner', () => { expect(als.getStore()).toBe('inner') })
      expect(als.getStore()).toBe('outer')
    })
  })

  it('keeps the store visible until a returned promise settles', async () => {
    const als = new AsyncLocalStorage<string>()
    let during: string | undefined
    await als.run('async', async () => {
      await Promise.resolve()
      during = als.getStore()
    })
    expect(during).toBe('async')
  })
})

describe('causality faces', () => {
  it.each(['bind', 'snapshot'] as const)('allows enterWith inside an empty %s and restores its caller', (face) => {
    const als = new AsyncLocalStorage<string>()
    const enter = (): string | undefined => {
      als.enterWith('entered')
      expect(als.getStore()).toBe('entered')
      als.run('nested', () => { expect(als.getStore()).toBe('nested') })
      return als.getStore()
    }
    const snapshot = AsyncLocalStorage.snapshot()
    const invoke = face === 'bind' ? AsyncLocalStorage.bind(enter) : () => snapshot(enter)
    expect(invoke()).toBe('entered')
    expect(als.getStore()).toBeUndefined()
    als.run('outer', () => {
      expect(invoke()).toBe('entered')
      expect(als.getStore()).toBe('outer')
    })
  })

  it.each(['bind', 'snapshot'] as const)('restores the caller when enterWith inside an empty %s throws', (face) => {
    const als = new AsyncLocalStorage<string>()
    const error = new Error('entered callback failed')
    const enter = (): never => {
      als.enterWith('entered')
      expect(als.getStore()).toBe('entered')
      throw error
    }
    const snapshot = AsyncLocalStorage.snapshot()
    const invoke = face === 'bind' ? AsyncLocalStorage.bind(enter) : () => snapshot(enter)
    als.run('outer', () => {
      expect(invoke).toThrow(error)
      expect(als.getStore()).toBe('outer')
    })
    expect(als.getStore()).toBeUndefined()
  })

  it.each(['bind', 'snapshot'] as const)('clears an instance created after %s captured its context', (face) => {
    const snapshot = AsyncLocalStorage.snapshot()
    let readStore: () => string | undefined = () => undefined
    const read = face === 'bind' ? AsyncLocalStorage.bind(() => readStore()) : () => snapshot(() => readStore())
    const als = new AsyncLocalStorage<string>()
    readStore = () => als.getStore()
    als.run('unrelated', () => {
      expect(read()).toBeUndefined()
      expect(als.getStore()).toBe('unrelated')
    })
  })

  it('restores late instances after nested captured callbacks throw', () => {
    const captured = new AsyncLocalStorage<string>()
    const snapshot = captured.run('captured', () => AsyncLocalStorage.snapshot())
    const late = new AsyncLocalStorage<string>()
    const error = new Error('callback failed')
    captured.run('outer', () => {
      late.run('outer', () => {
        expect(() => snapshot(() => {
          expect(captured.getStore()).toBe('captured')
          expect(late.getStore()).toBeUndefined()
          late.run('nested', () => {
            expect(late.getStore()).toBe('nested')
            snapshot(() => { expect(late.getStore()).toBeUndefined() })
            expect(late.getStore()).toBe('nested')
          })
          expect(late.getStore()).toBeUndefined()
          throw error
        })).toThrow(error)
        expect(captured.getStore()).toBe('outer')
        expect(late.getStore()).toBe('outer')
      })
    })
  })

  it.each(['bind', 'snapshot'] as const)('retains an empty context through %s during an unrelated boundary', (face) => {
    const als = new AsyncLocalStorage<string>()
    const snapshot = AsyncLocalStorage.snapshot()
    const read = face === 'bind' ? AsyncLocalStorage.bind(() => als.getStore()) : () => snapshot(() => als.getStore())
    als.run('unrelated', () => {
      expect(read()).toBeUndefined()
      expect(als.getStore()).toBe('unrelated')
    })
  })

  it('captures an absent store alongside another instance with a store', () => {
    const first = new AsyncLocalStorage<string>()
    const second = new AsyncLocalStorage<string>()
    const snapshot = first.run('captured', () => AsyncLocalStorage.snapshot())
    second.run('unrelated', () => {
      snapshot(() => {
        expect(first.getStore()).toBe('captured')
        expect(second.getStore()).toBeUndefined()
      })
      expect(second.getStore()).toBe('unrelated')
    })
  })

  it('captures a context and republishes it inside runWithAsyncContext', () => {
    const als = new AsyncLocalStorage<string>()
    const snapshot = als.run('captured', () => captureAsyncContext())
    expect(als.getStore()).toBeUndefined()
    runWithAsyncContext(snapshot, () => {
      expect(als.getStore()).toBe('captured')
    })
    expect(als.getStore()).toBeUndefined()
  })

  it('restores every live instance through the alsCausality pair', () => {
    const first = new AsyncLocalStorage<string>()
    const second = new AsyncLocalStorage<number>()
    let paused: ReturnType<typeof alsCausality.snapshot> | undefined
    first.run('a', () => {
      second.run(7, () => { paused = alsCausality.snapshot() })
    })
    expect(first.getStore()).toBeUndefined()
    expect(second.getStore()).toBeUndefined()
    // The rewriting calls restore at a resume point with no place for a
    // disposer; the published context answers reads after the await.
    alsCausality.restore(paused!)
    expect(first.getStore()).toBe('a')
    expect(second.getStore()).toBe(7)
    // A fresh boundary still wins over the resumed ambient context.
    first.run('b', () => { expect(first.getStore()).toBe('b') })
  })

  it('dispatches at the context root without inheriting the caller boundary', () => {
    const als = new AsyncLocalStorage<string>()
    als.run('caller', () => {
      runAtAsyncContextRoot(() => {
        expect(als.getStore()).toBeUndefined()
      })
      expect(als.getStore()).toBe('caller')
    })
  })
})
