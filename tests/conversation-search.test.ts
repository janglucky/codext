import { describe, expect, it } from 'vitest'
import { searchConversationHistory } from '../src/shared/conversation-search'
import type { Conversation } from '../src/shared/types'

const conversations: Conversation[] = [
  {
    id: 'weather',
    title: '天气演示',
    createdAt: '2026-08-14T01:00:00.000Z',
    updatedAt: '2026-08-14T01:02:00.000Z',
    messages: [
      { id: 'weather-user', role: 'user', content: '帮我创建一个天气查询页面', createdAt: '2026-08-14T01:00:00.000Z' },
      { id: 'weather-agent', role: 'assistant', content: '天气服务已启动：http://localhost:3100/', createdAt: '2026-08-14T01:02:00.000Z', steps: [{ id: 'internal', phase: 'act', title: 'Observation #1', detail: 'INTERNAL_ONLY_TRACE', timestamp: '2026-08-14T01:01:00.000Z' }] }
    ]
  },
  {
    id: 'config',
    title: '配置修复',
    createdAt: '2026-08-13T01:00:00.000Z',
    updatedAt: '2026-08-13T01:01:00.000Z',
    messages: [
      { id: 'config-user', role: 'user', content: '修复模型连接配置', createdAt: '2026-08-13T01:00:00.000Z' },
      { id: 'config-agent', role: 'assistant', content: '', attachments: [{ id: 'a', name: 'connection-error.png', mimeType: 'image/png', size: 1, dataUrl: 'data:image/png;base64,' }], createdAt: '2026-08-13T01:01:00.000Z' }
    ]
  }
]

describe('conversation history search', () => {
  it('searches globally across user and assistant messages', () => {
    const results = searchConversationHistory(conversations, '天气')
    expect(results.map((result) => result.messageId)).toEqual(['weather-user', 'weather-agent'])
    expect(results[0]).toMatchObject({ conversationId: 'weather', conversationTitle: '天气演示' })
  })

  it('requires every search term and prefers an exact phrase', () => {
    const results = searchConversationHistory(conversations, '模型 连接')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe('config-user')
  })

  it('searches attachment names without exposing internal tool traces', () => {
    expect(searchConversationHistory(conversations, 'connection-error')[0]?.messageId).toBe('config-agent')
    expect(searchConversationHistory(conversations, 'INTERNAL_ONLY_TRACE')).toEqual([])
  })

  it('returns no results for a blank query', () => {
    expect(searchConversationHistory(conversations, '   ')).toEqual([])
  })
})
