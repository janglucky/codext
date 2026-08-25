import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mockState.userData } }))

import { LocalStore } from '../src/main/persistence/store'

let userData = ''

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'codext-store-'))
  mockState.userData = userData
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

describe('knowledge-base persistence migration', () => {
  it('moves a legacy conversation config to settings and keeps that conversation enabled', async () => {
    const legacyConfig = {
      name: '旧知识库',
      baseUrl: 'https://fastgpt.example.com',
      apiKey: 'migration-test-key',
      datasetId: 'dataset-legacy',
      apiMode: 'searchTest',
      limit: 5000,
      similarity: 0.5,
      searchMode: 'mixedRecall',
      usingReRank: false
    }
    await writeFile(join(userData, 'agent-state.json'), JSON.stringify({
      settings: {
        model: { baseUrl: 'https://api.example.com', apiKey: '', model: 'test-model', timeoutMs: 300000, maxRetries: 3 },
        skillsEnabled: true,
        navigation: { fileApplicationPath: '', browserApplicationPath: '' }
      },
      policy: { systemPrompt: 'test', workspacePath: userData, enabledTools: [] },
      conversations: [{ id: 'legacy-conversation', title: '旧会话', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages: [], knowledgeBase: legacyConfig }]
    }), 'utf8')

    const store = new LocalStore()
    await store.load()

    expect(store.getSettings().knowledgeBase).toEqual(legacyConfig)
    expect(store.getConversations()[0]).toMatchObject({ id: 'legacy-conversation', knowledgeBaseEnabled: true })
    expect(store.getConversations()[0]).not.toHaveProperty('knowledgeBase')
    const persisted = JSON.parse(await readFile(join(userData, 'agent-state.json'), 'utf8')) as { conversations: Array<Record<string, unknown>> }
    expect(persisted.conversations[0]).not.toHaveProperty('knowledgeBase')
  })

  it('stores only the per-conversation enabled flag after global configuration exists', async () => {
    const store = new LocalStore()
    await store.load()
    const conversation = store.getConversations()[0]
    await expect(store.setConversationKnowledgeBaseEnabled(conversation.id, true)).rejects.toThrow('请先在设置中完成知识库配置')

    await store.saveSettings({
      ...store.getSettings(),
      knowledgeBase: {
        name: '产品库',
        baseUrl: 'https://fastgpt.example.com',
        apiKey: 'enable-test-key',
        datasetId: 'dataset-1',
        apiMode: 'searchTest',
        limit: 5000,
        similarity: 0.5,
        searchMode: 'mixedRecall',
        usingReRank: false
      }
    })
    await expect(store.setConversationKnowledgeBaseEnabled(conversation.id, true)).resolves.toMatchObject({ knowledgeBaseEnabled: true })
    await expect(store.setConversationKnowledgeBaseEnabled(conversation.id, false)).resolves.not.toHaveProperty('knowledgeBaseEnabled')
  })
})
