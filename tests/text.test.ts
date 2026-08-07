import { describe, expect, it } from 'vitest'
import { normalizeTechnicalPunctuation } from '../src/shared/text'

describe('normalizeTechnicalPunctuation', () => {
  it('repairs full-width punctuation inside technical identifiers', () => {
    expect(normalizeTechnicalPunctuation('读取 package。json、src/main/index。ts 和 config。base_url。'))
      .toBe('读取 package.json、src/main/index.ts 和 config.base_url。')
    expect(normalizeTechnicalPunctuation('访问 http：//localhost:5173/，检查 foo：bar。'))
      .toBe('访问 http://localhost:5173/，检查 foo:bar。')
  })

  it('keeps Chinese prose punctuation unchanged', () => {
    expect(normalizeTechnicalPunctuation('先读取配置，然后检查页面。'))
      .toBe('先读取配置，然后检查页面。')
  })
})
