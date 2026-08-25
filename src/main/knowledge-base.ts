import type { KnowledgeBaseApiMode, KnowledgeBaseConfig } from '../shared/types'
import { modelFetch } from './model-fetch'

const DEFAULT_NAME = 'FastGPT 知识库'
const DEFAULT_LIMIT = 5000
const DEFAULT_SIMILARITY = 0.5
const DEFAULT_API_MODE: KnowledgeBaseApiMode = 'searchTest'
const DEFAULT_SEARCH_MODE: KnowledgeBaseConfig['searchMode'] = 'mixedRecall'
const SEARCH_TIMEOUT_MS = 30_000
export const MAX_KNOWLEDGE_OBSERVATION_CHARACTERS = 24_000

const searchModes = new Set<KnowledgeBaseConfig['searchMode']>(['mixedRecall', 'embedding', 'fullTextRecall'])

type UnknownRecord = Record<string, unknown>

/**
 * Turns persisted or renderer-provided input into the bounded configuration
 * accepted by FastGPT's knowledge-search endpoints. Invalid/incomplete
 * connection details disable the integration instead of leaving a half-working
 * config. The newer searchTest API requires a dataset id; the legacy
 * datasetSearch API intentionally does not.
 */
export function normalizeKnowledgeBaseConfig(value: unknown): KnowledgeBaseConfig | undefined {
  if (!isRecord(value)) return undefined

  const baseUrl = normalizeHttpUrl(value.baseUrl)
  const apiKey = typeof value.apiKey === 'string'
    ? value.apiKey.trim().replace(/^Bearer\s+/i, '').trim()
    : ''
  if (!baseUrl || !apiKey) return undefined

  const apiMode: KnowledgeBaseApiMode = value.apiMode === 'datasetSearch' ? 'datasetSearch' : DEFAULT_API_MODE
  const datasetId = typeof value.datasetId === 'string' ? value.datasetId.trim().slice(0, 200) : ''
  if (apiMode === 'searchTest' && !datasetId) return undefined
  const requestedName = typeof value.name === 'string' ? value.name.trim() : ''
  return {
    name: (requestedName || DEFAULT_NAME).slice(0, 100),
    baseUrl,
    apiKey,
    datasetId,
    apiMode,
    limit: boundedNumber(value.limit, DEFAULT_LIMIT, 1, 100_000, true),
    similarity: boundedNumber(value.similarity, DEFAULT_SIMILARITY, 0, 1),
    searchMode: typeof value.searchMode === 'string' && searchModes.has(value.searchMode as KnowledgeBaseConfig['searchMode'])
      ? value.searchMode as KnowledgeBaseConfig['searchMode']
      : DEFAULT_SEARCH_MODE,
    usingReRank: typeof value.usingReRank === 'boolean' ? value.usingReRank : false
  }
}

/**
 * Accepts a FastGPT host root, an API base, or a complete search URL. The
 * optional mode keeps the old one-argument helper compatible while selecting
 * the newer searchTest endpoint by default.
 */
export function knowledgeBaseSearchEndpoint(baseUrl: string, apiMode: KnowledgeBaseApiMode = DEFAULT_API_MODE): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('知识库地址无效，请填写 HTTP 或 HTTPS 地址。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('知识库地址无效，仅支持 HTTP 或 HTTPS。')
  }

  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\/+$/, '')
  const expectedPath = apiMode === 'datasetSearch' ? '/api/v1/dataset/search' : '/api/core/dataset/searchTest'
  const knownApiRoot = path.replace(/\/api\/(?:v1(?:\/dataset(?:\/search)?)?|core(?:\/dataset(?:\/searchTest)?)?)$/i, '')
  url.pathname = knownApiRoot + expectedPath
  return url.toString()
}

export async function searchKnowledgeBase(config: KnowledgeBaseConfig, query: string, signal?: AbortSignal): Promise<string> {
  const normalized = normalizeKnowledgeBaseConfig(config)
  if (!normalized) throw new Error('知识库配置不完整，请检查服务地址、API Key 和 datasetId。')

  const normalizedQuery = query.trim()
  if (!normalizedQuery) throw new Error('知识库检索问题不能为空。')
  if (signal?.aborted) throw new DOMException('知识库检索已取消。', 'AbortError')

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, SEARCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await modelFetch(knowledgeBaseSearchEndpoint(normalized.baseUrl, normalized.apiMode), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + normalized.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(normalized.apiMode === 'searchTest'
        ? {
            datasetId: normalized.datasetId,
            text: normalizedQuery,
            limit: normalized.limit,
            similarity: normalized.similarity,
            searchMode: normalized.searchMode,
            usingReRank: normalized.usingReRank
          }
        : {
            query: normalizedQuery,
            limit: normalized.limit,
            similarity: normalized.similarity,
            searchMode: normalized.searchMode,
            usingReRank: normalized.usingReRank
          })
    })

    if (!response.ok) {
      const detail = redactSecret(await readErrorDetail(response), normalized.apiKey)
      const error = new Error('知识库检索失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : '。'))
      ;(error as Error & { status?: number }).status = response.status
      throw error
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error('知识库服务返回了无法解析的 JSON。')
    }
    if (!isRecord(payload)) throw new Error('知识库服务返回的数据格式无效。')

    const code = normalizedResponseCode(payload.code)
    if (code !== undefined && code !== 0 && code !== 200) {
      const detail = redactSecret(responseMessage(payload), normalized.apiKey)
      throw new Error('知识库检索失败（FastGPT code ' + String(payload.code) + '）' + (detail ? '：' + detail : '。'))
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'data')) {
      throw new Error('知识库服务未返回 data 字段。')
    }

    return formatObservation(normalized.name, normalizedQuery, payload.data, normalized.apiKey)
  } catch (error) {
    if (signal?.aborted) throw new DOMException('知识库检索已取消。', 'AbortError')
    if (timedOut || isAbortError(error)) throw new Error('知识库检索超时（30 秒）。')
    if (error instanceof Error) {
      error.message = redactSecret(error.message, normalized.apiKey)
      throw error
    }
    throw new Error('知识库检索失败。')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number, integer = false): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const bounded = Math.min(maximum, Math.max(minimum, requested))
  return integer ? Math.floor(bounded) : bounded
}

function normalizedResponseCode(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

async function readErrorDetail(response: Response): Promise<string> {
  let text = ''
  try {
    text = (await response.text()).trim()
  } catch {
    return ''
  }
  if (!text) return ''
  try {
    const payload = JSON.parse(text) as unknown
    return isRecord(payload) ? responseMessage(payload) || compactJson(payload) : text.slice(0, 500)
  } catch {
    return text.slice(0, 500)
  }
}

function responseMessage(payload: UnknownRecord): string {
  for (const key of ['message', 'statusText', 'error']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500)
    if (isRecord(value) && typeof value.message === 'string' && value.message.trim()) return value.message.trim().slice(0, 500)
  }
  return ''
}

function formatObservation(name: string, query: string, data: unknown, apiKey: string): string {
  const count = resultCount(data)
  const heading = [
    'FastGPT 知识库检索结果',
    '知识库：' + redactSecret(name, apiKey),
    '查询：' + JSON.stringify(redactSecret(query, apiKey)),
    count === undefined ? '命中数：未提供' : '命中数：' + count,
    '结果（JSON）：\n'
  ].join('\n')
  const json = compactJson(data, apiKey)
  const full = heading + json
  if (full.length <= MAX_KNOWLEDGE_OBSERVATION_CHARACTERS) return full

  const suffix = '\n…[知识库结果过长，已截断；原始 JSON 共 ' + full.length + ' 个字符]'
  const available = Math.max(0, MAX_KNOWLEDGE_OBSERVATION_CHARACTERS - suffix.length)
  return full.slice(0, available) + suffix
}

function resultCount(data: unknown): number | undefined {
  if (Array.isArray(data)) return data.length
  if (!isRecord(data)) return undefined
  if (typeof data.total === 'number' && Number.isFinite(data.total)) return data.total
  for (const key of ['list', 'results', 'items']) {
    if (Array.isArray(data[key])) return data[key].length
  }
  return undefined
}

function compactJson(value: unknown, apiKey = ''): string {
  try {
    const serialized = JSON.stringify(value, (key, item: unknown) => {
      if (/^(?:api[_-]?key|authorization|access[_-]?token)$/i.test(key)) return '[REDACTED]'
      return typeof item === 'string' ? redactSecret(item, apiKey) : item
    }, 2)
    return serialized === undefined ? 'null' : serialized
  } catch {
    return '"[无法序列化知识库结果]"'
  }
}

function redactSecret(value: string, apiKey: string): string {
  let redacted = value.replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [REDACTED]')
  if (apiKey) redacted = redacted.split(apiKey).join('[REDACTED]')
  return redacted
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
