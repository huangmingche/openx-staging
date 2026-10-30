/** Locale paths shared by document pairing and link resolution. */

/** The three repository-relative paths that form one bilingual pair. */
export interface TranslationPairPaths {
  /** English document path. */
  source: string
  /** Simplified Chinese document path. */
  zh: string
  /** Consistency-record path. */
  meta: string
}

/**
 * Whether a Markdown path is the Chinese member of its pair.
 * @param path - Repository-relative Markdown path.
 * @returns True for the root Chinese README or a `.zh.md` document.
 */
export function isChineseDocument(path: string): boolean {
  return path === 'README.md' || path.endsWith('.zh.md')
}

/**
 * Resolve a pair member or bare stem to its English document path.
 * @param path - Repository-relative pair member or bare stem.
 * @returns The English path with normalized separators.
 */
export function translationPairAnchor(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  if (['README', 'README.md', 'README.en.md', 'README.i18n.yaml'].includes(normalized)) return 'README.en.md'
  if (normalized.endsWith('.zh.md')) return normalized.replace(/\.zh\.md$/, '.md')
  if (normalized.endsWith('.i18n.yaml')) return normalized.replace(/\.i18n\.yaml$/, '.md')
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`
}

/**
 * Resolve an English document to its locale counterpart and consistency record.
 * @param source - Repository-relative English Markdown path.
 * @returns The complete pair and record paths.
 */
export function translationPairPaths(source: string): TranslationPairPaths {
  if (!source.endsWith('.md') || isChineseDocument(source)) {
    throw new Error(`expected an English Markdown path, received ${JSON.stringify(source)}`)
  }
  return source === 'README.en.md'
    ? { source, zh: 'README.md', meta: 'README.i18n.yaml' }
    : { source, zh: source.replace(/\.md$/, '.zh.md'), meta: source.replace(/\.md$/, '.i18n.yaml') }
}
