import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeBaseConfig } from '../src/shared/types'

vi.mock('../src/main/model-fetch', () => ({ modelFetch: vi.fn() }))

import {
  MAX_KNOWLEDGE_OBSERVATION_CHARACTERS,
  knowledgeBaseSearchEndpoint,
  normalizeKnowledgeBaseConfig,
  searchKnowledgeBase
} from '../src/main/knowledge-base'
import { modelFetch } from '../src/main/model-fetch'

const mockedModelFetch = vi.mocked(modelFetch)
const config: KnowledgeBaseConfig = {
  name: '产品文档',
  baseUrl: 'https://fastgpt.example.com',
  apiKey: 'fastgpt-dataset-secret',
  datasetId: 'dataset-123',
  apiMode: 'datasetSearch',
  limit: 5000,
  similarity: 0.5,
  searchMode: 'mixedRecall',
  usingReRank: false
}

describe('FastGPT knowledge base client', () => {
  beforeEach(() => {
    mockedModelFetch.mockReset()
  })

  it('normalizes defaults and clamps numeric settings', () => {
    expect(normalizeKnowledgeBaseConfig({
      baseUrl: ' https://fastgpt.example.com/ ',
      apiKey: ' Bearer fastgpt-dataset-secret ',
      limit: 200_000,
      similarity: -0.5,
      apiMode: 'searchTest',
      datasetId: 'dataset-123'
    })).toEqual({
      name: 'FastGPT 知识库',
      baseUrl: 'https://fastgpt.example.com',
      apiKey: 'fastgpt-dataset-secret',
      datasetId: 'dataset-123',
      apiMode: 'searchTest',
      limit: 100_000,
      similarity: 0,
      searchMode: 'mixedRecall',
      usingReRank: false
    })

    expect(normalizeKnowledgeBaseConfig({ baseUrl: '', apiKey: 'key', datasetId: 'dataset-123' })).toBeUndefined()
    expect(normalizeKnowledgeBaseConfig({ baseUrl: 'https://fastgpt.example.com', apiKey: '' })).toBeUndefined()
    expect(normalizeKnowledgeBaseConfig({ baseUrl: 'https://fastgpt.example.com', apiKey: 'key' })).toBeUndefined()
    expect(normalizeKnowledgeBaseConfig({ baseUrl: 'https://fastgpt.example.com', apiKey: 'key', apiMode: 'datasetSearch' })).toMatchObject({ apiMode: 'datasetSearch', datasetId: '' })
    expect(normalizeKnowledgeBaseConfig({ baseUrl: 'file:///tmp/data', apiKey: 'key', datasetId: 'dataset-123' })).toBeUndefined()
  })

  it.each([
    ['searchTest', 'https://fastgpt.example.com', 'https://fastgpt.example.com/api/core/dataset/searchTest'],
    ['searchTest', 'https://fastgpt.example.com/api/core', 'https://fastgpt.example.com/api/core/dataset/searchTest'],
    ['searchTest', 'https://fastgpt.example.com/api/core/dataset/searchTest?old=true#part', 'https://fastgpt.example.com/api/core/dataset/searchTest'],
    ['datasetSearch', 'https://fastgpt.example.com', 'https://fastgpt.example.com/api/v1/dataset/search'],
    ['datasetSearch', 'https://fastgpt.example.com/api/v1', 'https://fastgpt.example.com/api/v1/dataset/search'],
    ['datasetSearch', 'https://fastgpt.example.com/api/v1/dataset/search?old=true#part', 'https://fastgpt.example.com/api/v1/dataset/search']
  ])('resolves %s %s to the correct endpoint', (mode, input, expected) => {
    expect(knowledgeBaseSearchEndpoint(input, mode as 'searchTest' | 'datasetSearch')).toBe(expected)
  })

  it('uses searchTest by default with datasetId and text', async () => {
    const searchTestConfig = { ...config, apiMode: 'searchTest' as const }
    mockedModelFetch.mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: { total: 1, list: [{ q: '如何退款？', a: '联系支持团队。', score: 0.88 }] }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const observation = await searchKnowledgeBase(searchTestConfig, ' 如何退款？ ')

    expect(mockedModelFetch).toHaveBeenCalledOnce()
    const [url, init] = mockedModelFetch.mock.calls[0]
    expect(url).toBe('https://fastgpt.example.com/api/core/dataset/searchTest')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer fastgpt-dataset-secret',
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    })
    expect(JSON.parse(init.body ?? '')).toEqual({
      datasetId: 'dataset-123',
      text: '如何退款？',
      limit: 5000,
      similarity: 0.5,
      searchMode: 'mixedRecall',
      usingReRank: false
    })
    expect(observation).toContain('知识库：产品文档')
    expect(observation).toContain('命中数：1')
    expect(observation).toContain('联系支持团队。')
    expect(observation).not.toContain(config.apiKey)
  })

  it('keeps datasetSearch compatibility with query and the legacy endpoint', async () => {
    mockedModelFetch.mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: { total: 1, list: [{ q: '如何退款？', a: '联系支持团队。' }] }
    }), { status: 200 }))

    await searchKnowledgeBase(config, '如何退款？')

    const [url, init] = mockedModelFetch.mock.calls[0]
    expect(url).toBe('https://fastgpt.example.com/api/v1/dataset/search')
    expect(JSON.parse(init.body ?? '')).toEqual({
      query: '如何退款？',
      limit: 5000,
      similarity: 0.5,
      searchMode: 'mixedRecall',
      usingReRank: false
    })
    expect(JSON.parse(init.body ?? '')).not.toHaveProperty('datasetId')
  })

  it('accepts FastGPT success code 0 and an empty result list', async () => {
    mockedModelFetch.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { list: [] } }), { status: 200 }))
    await expect(searchKnowledgeBase(config, '没有结果的问题')).resolves.toContain('命中数：0')
  })

  it('reports HTTP errors without leaking the dataset key', async () => {
    mockedModelFetch.mockResolvedValue(new Response(JSON.stringify({
      message: 'invalid Authorization: Bearer ' + config.apiKey
    }), { status: 401 }))

    await expect(searchKnowledgeBase(config, '问题')).rejects.toThrow('知识库检索失败（HTTP 401）：invalid Authorization: Bearer [REDACTED]')
  })

  it('reports FastGPT application errors and missing data', async () => {
    mockedModelFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 500, message: 'dataset unavailable' }), { status: 200 }))
    await expect(searchKnowledgeBase(config, '问题')).rejects.toThrow('FastGPT code 500')

    mockedModelFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
    await expect(searchKnowledgeBase(config, '问题')).rejects.toThrow('未返回 data 字段')
  })

  it('honors caller cancellation and preserves AbortError semantics', async () => {
    const controller = new AbortController()
    mockedModelFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))

    const request = searchKnowledgeBase(config, '问题', controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError', message: '知识库检索已取消。' })
  })

  it('turns the internal request deadline into a clear timeout error', async () => {
    vi.useFakeTimers()
    try {
      mockedModelFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      const request = searchKnowledgeBase(config, '问题')
      const rejection = expect(request).rejects.toThrow('知识库检索超时（30 秒）')
      await vi.advanceTimersByTimeAsync(30_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds large observations and redacts secrets returned by the server', async () => {
    mockedModelFetch.mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: {
        authorization: 'Bearer ' + config.apiKey,
        list: [{ a: config.apiKey + ' ' + '长内容'.repeat(20_000) }]
      }
    }), { status: 200 }))

    const observation = await searchKnowledgeBase(config, '问题')
    expect(observation.length).toBeLessThanOrEqual(MAX_KNOWLEDGE_OBSERVATION_CHARACTERS)
    expect(observation).toContain('已截断')
    expect(observation).not.toContain(config.apiKey)
    expect(observation).toContain('[REDACTED]')
  })
})
