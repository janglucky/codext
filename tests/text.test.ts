import { describe, expect, it } from 'vitest'
import { hideReactObservationReferences, isInternalAgentPlaceholder, normalizeTechnicalPunctuation } from '../src/shared/text'

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

describe('hideReactObservationReferences', () => {
  it('removes internal ReAct turn numbers from user-facing thoughts', () => {
    expect(hideReactObservationReferences('之前的 CSS 编辑已成功（Observation #5），但 JS 仍需修改。'))
      .toBe('之前的 CSS 编辑已成功，但 JS 仍需修改。')
    expect(hideReactObservationReferences('根据 Observation #12 继续检查。'))
      .toBe('根据工具结果继续检查。')
  })
})

describe('isInternalAgentPlaceholder', () => {
  it('recognizes host-only ReAct recovery markers', () => {
    expect(isInternalAgentPlaceholder('[上一条工具调用在 Action JSON 闭合前被截断，未执行。]')).toBe(true)
    expect(isInternalAgentPlaceholder('[上一条 read_file Action 参数无效，未执行。]')).toBe(true)
    expect(isInternalAgentPlaceholder('[模型重复调用已成功执行的工具，已停止重复执行。]')).toBe(true)
    expect(isInternalAgentPlaceholder('[REACT_PROTOCOL_DRIFT]')).toBe(true)
  })

  it('does not hide ordinary bracketed user-facing text', () => {
    expect(isInternalAgentPlaceholder('[已完成]')).toBe(false)
    expect(isInternalAgentPlaceholder('上一条工具调用失败，请重试。')).toBe(false)
  })
})
