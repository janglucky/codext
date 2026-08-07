import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReactAgent } from '../src/main/agent/react-agent'
import { WorkspaceTools } from '../src/main/tools/workspace-tools'
import type { AgentPolicy, AppSettings } from '../src/shared/types'

const originalFetch = globalThis.fetch
const policy: AgentPolicy = { systemPrompt: 'test', workspacePath: '.', enabledTools: ['list_files'] }
const settings: AppSettings = {
  model: { baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', model: 'test-model', timeoutMs: 5000, maxRetries: 0 },
  skillsEnabled: true,
  navigation: { fileApplicationPath: '', browserApplicationPath: '' }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function createAgent(): ReactAgent {
  return new ReactAgent(() => settings, () => policy)
}

describe('agent token usage', () => {
  it('records exact usage from a JSON response and requests streaming usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 20 }
      })
    })
    globalThis.fetch = fetchMock

    const task = await createAgent().run('hello')

    expect(task.tokenUsage).toEqual(expect.objectContaining({ inputTokens: 120, outputTokens: 20, estimated: false }))
    expect(task.tokenUsage?.durationMs).toBeGreaterThan(0)
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { stream_options?: { include_usage?: boolean } }
    expect(request.stream_options?.include_usage).toBe(true)
  })

  it('reads exact usage from the final SSE event', async () => {
    const encoder = new TextEncoder()
    const event = (payload: unknown): Uint8Array => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(event({ choices: [{ delta: { content: JSON.stringify({ final: 'streamed' }) } }] }))
          controller.enqueue(event({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 12 } }))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
    })

    const task = await createAgent().run('hello')

    expect(task.tokenUsage).toEqual(expect.objectContaining({ inputTokens: 80, outputTokens: 12, estimated: false }))
  })

  it('aggregates usage across ReAct model calls', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ action: { name: 'list_files', arguments: {} } }) } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }],
          usage: { prompt_tokens: 70, completion_tokens: 15 }
        })
      })
    vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')

    const task = await createAgent().run('list files')

    expect(task.tokenUsage).toEqual(expect.objectContaining({ inputTokens: 120, outputTokens: 25, estimated: false }))
  })

  it('falls back to estimated counts when a compatible API omits usage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }] })
    })

    const task = await createAgent().run('hello', [], undefined, undefined, [{
      id: 'image-1',
      name: 'large.png',
      mimeType: 'image/png',
      size: 50_000,
      dataUrl: 'data:image/png;base64,' + 'A'.repeat(50_000)
    }])

    expect(task.tokenUsage?.estimated).toBe(true)
    expect(task.tokenUsage?.inputTokens).toBeGreaterThan(0)
    expect(task.tokenUsage?.inputTokens).toBeLessThan(5000)
    expect(task.tokenUsage?.outputTokens).toBeGreaterThan(0)
  })

  it('uses a per-run model override without changing the configured default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }] })
    })
    globalThis.fetch = fetchMock
    const override = { ...settings.model, model: 'override-model' }
    const task = await createAgent().run('hello', [], undefined, undefined, [], undefined, undefined, undefined, undefined, undefined, override)

    expect(task.status).toBe('succeeded')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('override-model')
    expect(settings.model.model).toBe('test-model')
  })

  it('compresses context before the request and reports completion through a task step', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }] })
    })
    globalThis.fetch = fetchMock
    const compactSettings: AppSettings = {
      ...settings,
      model: { ...settings.model, contextWindowTokens: 16_000, maxOutputTokens: 2_000 }
    }
    const history = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: '无关历史 ' + index + ' ' + 'x'.repeat(5_000)
    }))
    const steps: string[] = []
    const agent = new ReactAgent(() => compactSettings, () => policy)

    const task = await agent.run('当前问题', history, (taskStep) => steps.push(taskStep.title))
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { max_tokens: number; messages: Array<{ content: unknown }> }

    expect(task.status).toBe('succeeded')
    expect(steps).toContain('已完成上下文压缩')
    expect(request.max_tokens).toBe(2_000)
    expect(request.messages.at(-1)?.content).toBe('当前问题')
    expect(JSON.stringify(request.messages)).toContain('上下文')
  })
})
