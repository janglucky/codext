import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../src/shared/unified-diff'

describe('parseUnifiedDiff', () => {
  it('adds line numbers and separates added, deleted and modified lines', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/app.ts b/app.ts',
      'index 1111111..2222222 100644',
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -2,5 +2,6 @@',
      ' unchanged',
      '-old value',
      '+new value',
      ' stable',
      '+extra one',
      '+extra two',
      '-removed only'
    ].join('\n'))

    expect(parsed).toMatchObject({ added: 1, deleted: 0, modified: 2 })
    expect(parsed.lines).toEqual([
      { kind: 'hunk', content: '@@ -2,5 +2,6 @@' },
      { kind: 'context', content: 'unchanged', oldLine: 2, newLine: 2 },
      { kind: 'modify-old', content: 'old value', oldLine: 3 },
      { kind: 'modify-new', content: 'new value', newLine: 3 },
      { kind: 'context', content: 'stable', oldLine: 4, newLine: 4 },
      { kind: 'modify-old', content: 'removed only', oldLine: 5 },
      { kind: 'modify-new', content: 'extra one', newLine: 5 },
      { kind: 'add', content: 'extra two', newLine: 6 }
    ])
  })

  it('counts a pure deletion without treating it as an edit', () => {
    const parsed = parseUnifiedDiff('@@ -8,2 +8,1 @@\n keep\n-remove')

    expect(parsed).toMatchObject({ added: 0, deleted: 1, modified: 0 })
    expect(parsed.lines.at(-1)).toEqual({ kind: 'delete', content: 'remove', oldLine: 9 })
  })
})
