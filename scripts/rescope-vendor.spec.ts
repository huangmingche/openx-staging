/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, listRescopeFiles, rescopeText } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('rescope file selection', () => {
  it('checks an untracked import without entering upstream source copies or ignored output', () => {
    const root = mkdtempSync(join(tmpdir(), 'openx-rescope-import-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key.toUpperCase())))
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root, env })
      writeFileSync(join(root, '.gitignore'), 'ignored.ts\n')
      writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
      writeFileSync(join(root, 'ignored.ts'), 'generated\n')
      for (const directory of ['.submodules/deepseek-harness', '.sources/openharmony']) {
        mkdirSync(join(root, directory), { recursive: true })
        writeFileSync(join(root, directory, 'source.ts'), 'upstream\n')
      }
      expect(listRescopeFiles(root, env)).toEqual(['source.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})

describe('Cordis product identifiers', () => {
  const file = 'packages/client/ui-agent-preset/src/client/analytics.ts'

  it.each([
    "import { Context } from 'cordis'\n",
    "import 'cordis'\n",
    "export * from 'cordis/client'\n",
    "const framework = import(\n  'cordis'\n)\n",
    "const framework = require('cordis')\n",
    "type Context = import('cordis').Context\n",
  ])('keeps module references eligible beside preset ids: %s', (statement) => {
    const product = "const preset = 'cordis'\n"
    const expected = statement.replaceAll("'cordis", "'@deepseek-ai/cordis") + product
    expect(rescopeText(statement + product, file).text).toBe(expected)
    expect(rescopeText(expected, file).lines).toBe(0)
    expect(rescopeText(expected, file, true).text).toBe(statement + product)
  })

  it('checks imports in an audited Markdown fence while preserving preset prose', () => {
    const prose = 'The `cordis` preset creates plugins.\n'
    const code = "```ts\nimport { Context } from 'cordis'\nconst preset = 'cordis'\n```\n"
    const result = rescopeText(prose + code, 'docs/user/guide/schedule.md')
    expect(result.text).toBe(prose + code.replace("from 'cordis'", "from '@deepseek-ai/cordis'"))
    expect(result.lines).toBe(1)
  })

  it('checks YAML plugin names while preserving a preset id in its comment', () => {
    const comment = '# The `cordis` preset owns the reminder tools.\n'
    expect(rescopeText(comment + '- name: cordis\n', 'packages/bundle/web-app/cordis.patch.yml'))
      .toEqual({ text: comment + '- name: @deepseek-ai/cordis\n', lines: 1 })
  })

  it('preserves event names without hiding an imported module with the same spelling', () => {
    const source = "import query from 'cordis/inspect-query'\nctx.on('cordis/inspect-query', query)\n"
    expect(rescopeText(source, 'packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts').text)
      .toBe(source.replace("from 'cordis/inspect-query'", "from '@deepseek-ai/cordis/inspect-query'"))
  })

  it('keeps unaudited literal package references eligible', () => {
    expect(rescopeText("resolve('cordis')\n", 'packages/example/src/index.ts'))
      .toEqual({ text: "resolve('@deepseek-ai/cordis')\n", lines: 1 })
  })
})
