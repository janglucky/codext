import { describe, expect, it } from 'vitest'
import { estimateContextTokens, prepareContext, type ContextMessage } from '../src/main/agent/context-manager'

const system: ContextMessage = { role: 'system', content: 'system rules' }

describe('context manager', () => {
  it('does not compress a request below the 80 percent threshold', () => {
    const messages: ContextMessage[] = [system, { role: 'user', content: 'short request' }]

    const prepared = prepareContext(messages, { contextWindowTokens: 16_000, maxOutputTokens: 2_000 })

    expect(prepared.compressed).toBe(false)
    expect(prepared.level).toBe(0)
    expect(prepared.beforeTokens).toBeLessThan(prepared.triggerTokens)
    expect(prepared.messages).toBe(messages)
  })

  it('compresses an oversized history toward the target while preserving recent messages', () => {
    const historical = Array.from({ length: 16 }, (_, index): ContextMessage => ({
      role: index % 2 ? 'assistant' : 'user',
      content: (index % 2 ? '已处理旧任务 ' : '旧的用户需求 ') + index + ' ' + 'x'.repeat(5_000)
    }))
    const latestRequest: ContextMessage = { role: 'user', content: '当前请求必须保留原文。' }
    const messages = [system, ...historical, latestRequest]

    const prepared = prepareContext(messages, { contextWindowTokens: 16_000, maxOutputTokens: 2_000 })

    expect(prepared.compressed).toBe(true)
    expect(prepared.level).toBeGreaterThanOrEqual(2)
    expect(prepared.afterTokens).toBeLessThan(prepared.beforeTokens)
    expect(prepared.afterTokens).toBeLessThanOrEqual(prepared.targetTokens)
    expect(prepared.messages.at(-1)).toEqual(latestRequest)
    expect(prepared.messages.some((message) => String(message.content).includes('上下文'))).toBe(true)
  })

  it('keeps the latest observation verbatim during higher-level compression', () => {
    const oldMessages = Array.from({ length: 14 }, (_, index): ContextMessage => ({
      role: index % 2 ? 'assistant' : 'user',
      content: '历史信息 ' + index + ' ' + 'y'.repeat(5_000)
    }))
    const latestObservation = 'Observation #8:\nread_file: 关键错误位于 src/main/index.ts:42\n' + 'z'.repeat(2_000)
    const messages: ContextMessage[] = [
      system,
      ...oldMessages,
      { role: 'user', content: '检查项目' },
      { role: 'assistant', content: '{"action":{"name":"read_file","arguments":{"path":"src/main/index.ts"}}}' },
      { role: 'user', content: latestObservation }
    ]

    const prepared = prepareContext(messages, { contextWindowTokens: 18_000, maxOutputTokens: 2_000 })

    expect(prepared.compressed).toBe(true)
    expect(prepared.messages.at(-1)?.content).toBe(latestObservation)
    expect(estimateContextTokens(prepared.messages)).toBe(prepared.afterTokens)
  })

  it('removes duplicate protocol noise before semantic compression', () => {
    const duplicate = { role: 'assistant' as const, content: '重复的旧结果 ' + 'q'.repeat(8_000) }
    const noise = { role: 'user' as const, content: 'REPEATED_ACTION：不要重复工具' }
    const messages: ContextMessage[] = [
      system,
      duplicate,
      duplicate,
      noise,
      ...Array.from({ length: 10 }, (_, index): ContextMessage => ({ role: index % 2 ? 'assistant' : 'user', content: '内容 ' + index + ' ' + 'w'.repeat(2_000) }))
    ]

    const prepared = prepareContext(messages, { contextWindowTokens: 12_000, maxOutputTokens: 1_000 })
    const serialized = JSON.stringify(prepared.messages)

    expect(prepared.compressed).toBe(true)
    expect(serialized).not.toContain('REPEATED_ACTION')
    expect(serialized.match(/重复的旧结果/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('does not pin a recent but oversized unrelated message in an emergency checkpoint', () => {
    const unrelated = '旧任务的完整日志 ' + 'u'.repeat(40_000)
    const currentRequest = '只处理当前这个问题。'
    const messages: ContextMessage[] = [
      system,
      { role: 'user', content: unrelated },
      { role: 'assistant', content: '旧任务尚未完成。' },
      { role: 'user', content: currentRequest }
    ]

    const prepared = prepareContext(messages, { contextWindowTokens: 8_000, maxOutputTokens: 1_000 })
    const serialized = JSON.stringify(prepared.messages)

    expect(prepared.compressed).toBe(true)
    expect(prepared.level).toBe(4)
    expect(prepared.messages.at(-1)?.content).toBe(currentRequest)
    expect(serialized).not.toContain('u'.repeat(2_000))
  })
})
