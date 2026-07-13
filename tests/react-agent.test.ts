import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ReactAgent } from '../src/main/agent/react-agent'
import type { AgentPolicy, AppSettings, AgentTask } from '../src/shared/types'

// ---- helpers ----
const basePolicy: AgentPolicy = {
  systemPrompt: 'test',
  workspacePath: 'D:/work/codext',
  enabledTools: ['read_file', 'write_file', 'run_command']
}

const modelConfigured: AppSettings['model'] = {
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4',
  timeoutMs: 5000,
  maxRetries: 3
}

function makeSettings(overrides: Partial<AppSettings['model']> = {}): AppSettings {
  return {
    model: { ...modelConfigured, ...overrides },
    mcpUrl: '',
    skillsEnabled: true
  }
}

/** 创建一个用于反射调用 private execute 的 agent 包装 */
function makeAgent(settings: AppSettings, policy: AgentPolicy = basePolicy) {
  const agent = new ReactAgent(() => settings, () => policy)
  return {
    agent,
    execute(prompt: string, task: AgentTask) {
      return (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask) => Promise<string> })
        .execute(prompt, policy, task)
    }
  }
}

function makeTask(prompt = 'test prompt'): AgentTask {
  return {
    id: crypto.randomUUID(),
    prompt,
    status: 'acting',
    createdAt: new Date().toISOString(),
    steps: []
  }
}

// ---- tests ----
describe('ReactAgent.execute', () => {
  // 1. demo mode
  describe('demo mode', () => {
    it('returns demo response when baseUrl is empty', async () => {
      const s = makeSettings({ baseUrl: '' })
      const { execute } = makeAgent(s)
      const task = makeTask()
      const result = await execute('hello', task)
      expect(result).toContain('演示模式')
      expect(result).toContain('hello')
    })

    it('returns demo response when model name is empty', async () => {
      const s = makeSettings({ model: '' })
      const { execute } = makeAgent(s)
      const task = makeTask()
      const result = await execute('hello', task)
      expect(result).toContain('演示模式')
    })

    it('returns demo response when both baseUrl and model are empty', async () => {
      const s = makeSettings({ baseUrl: '', model: '' })
      const { execute } = makeAgent(s)
      const task = makeTask()
      const result = await execute('hello', task)
      expect(result).toContain('演示模式')
    })
  })

  // 2. model returns content without tool_calls
  describe('no tool calls', () => {
    it('requires unfinished wording before an action observation', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }] })
      })

      const { execute } = makeAgent(makeSettings())
      await execute('inspect files', makeTask())

      const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
      const body = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: string }> }
      const systemPrompt = body.messages.find((message) => message.role === 'system')?.content ?? ''
      expect(systemPrompt).toContain('未完成措辞')
      expect(systemPrompt).toContain('严禁声称文件已经创建')
    })
    beforeEach(() => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'plain answer' } }] })
      })
    })

    it('returns model response directly when no tool_calls present', async () => {
      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('what is 2+2', task)
      expect(result).toBe('plain answer')
      // no act steps should be added for tools
      expect(task.steps.filter(s => s.phase === 'act')).toHaveLength(0)
    })

    it('returns model response when content is not valid JSON', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'just some text, no json' } }] })
      })
      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('hello', task)
      expect(result).toBe('just some text, no json')
    })

    it('returns model response when content contains tool_calls but JSON is malformed', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{tool_calls: [broken json' } }] })
      })
      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('hello', task)
      expect(result).toBe('{tool_calls: [broken json')
    })

    it('streams final field deltas when server returns SSE', async () => {
      const encoder = new TextEncoder()
      const sse = (content: string): Uint8Array => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/event-stream' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sse('{"thought":"ok","final":"Hel'))
            controller.enqueue(sse('lo"}'))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        })
      })

      let streamed = ''
      const { agent } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: undefined, onDelta?: (delta: string) => void) => Promise<string> })
        .execute('hello', basePolicy, task, [], undefined, (delta) => { streamed += delta })

      expect(result).toBe('Hello')
      expect(streamed).toBe('Hello')
    })

    it('streams think tags into the same reasoning step', async () => {
      const encoder = new TextEncoder()
      const sse = (content: string): Uint8Array => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/event-stream' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(sse('<think>先分析'))
            controller.enqueue(sse('需求</thi'))
            controller.enqueue(sse('nk>{"final":"完成"}'))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        })
      })

      const stepSnapshots: string[] = []
      let streamed = ''
      const { agent } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: (step: { title: string; detail: string }) => void, onDelta?: (delta: string) => void) => Promise<string> })
        .execute('hello', basePolicy, task, [], (taskStep) => {
          if (taskStep.title === '思考过程') stepSnapshots.push(taskStep.detail)
        }, (delta) => { streamed += delta })

      expect(result).toBe('完成')
      expect(streamed).toBe('完成')
      expect(stepSnapshots).toContain('先分析')
      expect(stepSnapshots).toContain('先分析需求')
      expect(stepSnapshots.some((item) => item.includes('</thi'))).toBe(false)
      expect(task.steps.filter((item) => item.title === '思考过程')).toHaveLength(1)
    })
  })

  // 3. model returns tool_calls
  describe('with tool calls', () => {
    it('executes tools and calls model again with observations', async () => {
      // first call: returns tool_calls
      // second call: returns final answer
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: { path: 'package.json' } }] })
          : 'final answer after tool execution'
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] })
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('read package.json', task)

      expect(result).toBe('final answer after tool execution')
      expect(callCount).toBe(2)
      // act steps: one before tool execution, one after tool result
      const actSteps = task.steps.filter(s => s.phase === 'act')
      expect(actSteps.length).toBeGreaterThanOrEqual(2)
      expect(actSteps.some(s => s.title.includes('read_file'))).toBe(true)
      expect(actSteps.some(s => s.title.startsWith('正在执行工具'))).toBe(true)
      expect(actSteps.some(s => s.title.startsWith('Observation #'))).toBe(true)
    })

    it('executes action when model returns adjacent JSON objects', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? '{"thought":"需要先查看目录","action":{"name":"run_command","arguments":{"command":"cmd","args":["/c","dir"]}}}{"thought":"等待 Observation","final":"请执行上一步 Action 并返回 Observation。"}'
          : JSON.stringify({ final: 'done after observation' })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] })
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('list files', task)

      expect(result).toBe('done after observation')
      expect(callCount).toBe(2)
      expect(task.steps.some(s => s.title.includes('run_command'))).toBe(true)
      expect(task.result).toBeUndefined()
    })

    it('removes completion claims from thought before action', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ thought: '已成功写入 HTML 文件。准备创建 CSS 文件。', action: { name: 'write_file', arguments: { path: 'style.css', content: 'body {}' } } })
          : JSON.stringify({ final: 'done' })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] })
        })
      })

      const snapshots: string[] = []
      const { agent } = makeAgent(makeSettings())
      const task = makeTask()
      await (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: (step: { title: string; detail: string }) => void) => Promise<string> })
        .execute('create files', basePolicy, task, [], (taskStep) => {
          if (taskStep.title === '思考过程') snapshots.push(taskStep.detail)
        })

      expect(snapshots.at(-1)).toBe('准备创建 CSS 文件。')
    })

    it('recovers write_file action when content contains raw newlines', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? '{"action":{"name":"write_file","arguments":{"path":"generated.txt","content":"line one\nline two"}} trailing'
          : JSON.stringify({ final: 'file written' })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] })
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('write file', task)

      expect(result).toBe('file written')
      expect(callCount).toBe(2)
      expect(task.steps.some((item) => item.title.includes('write_file'))).toBe(true)
    })

    it('streams thought tags before executing tool calls', async () => {
      const encoder = new TextEncoder()
      const sse = (content: string): Uint8Array => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }] })
          })
        }

        return Promise.resolve({
          ok: true,
          headers: { get: () => 'text/event-stream' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(sse('<thought>需要查看'))
              controller.enqueue(sse('项目配置</thought>{"action":{"name":"read_file","arguments":{"path":"package.json"}}}'))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            }
          })
        })
      })

      const stepSnapshots: string[] = []
      let streamed = ''
      const { agent } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: (step: { title: string; detail: string }) => void, onDelta?: (delta: string) => void) => Promise<string> })
        .execute('read package', basePolicy, task, [], (taskStep) => {
          if (taskStep.title === '思考过程') stepSnapshots.push(taskStep.detail)
        }, (delta) => { streamed += delta })

      expect(result).toBe('done')
      expect(streamed).toBe('done')
      expect(callCount).toBe(2)
      expect(stepSnapshots).toContain('需要查看')
      expect(stepSnapshots).toContain('需要查看项目配置')
      expect(task.steps.some(s => s.title.includes('read_file'))).toBe(true)
    })

    it('does not stream fake final when action appears before final', async () => {
      const encoder = new TextEncoder()
      const sse = (content: string): Uint8Array => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'real final' }) } }] })
          })
        }
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'text/event-stream' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(sse('{"thought":"需要工具","action":{"name":"run_command","arguments":{"command":"cmd","args":["/c","dir"]}}}'))
              controller.enqueue(sse('{"thought":"等待","final":"fake final"}'))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            }
          })
        })
      })

      let streamed = ''
      const { agent } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: undefined, onDelta?: (delta: string) => void) => Promise<string> })
        .execute('list files', basePolicy, task, [], undefined, (delta) => { streamed += delta })

      expect(result).toBe('real final')
      expect(streamed).toBe('real final')
      expect(callCount).toBe(2)
    })

    it('filters out unknown tool names from tool_calls', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                tool_calls: [
                  { name: 'unknown_tool', arguments: {} },
                  { name: 'read_file', arguments: { path: 'package.json' } }
                ]
              })
            }
          }]
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      // unknown_tool is filtered, only read_file is executed
      await execute('test', task)
      const toolSteps = task.steps.filter(s => s.phase === 'act' && s.title !== '调用模型')
      // only read_file should be executed, unknown_tool skipped
      expect(toolSteps.every(s => s.title.includes('read_file'))).toBe(true)
    })

    it('adds observations from tool execution to model context', async () => {
      let observationsReceived: string[] = []
      // intercept second call to capture observations
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{
              message: {
                content: JSON.stringify({
                  tool_calls: [{ name: 'read_file', arguments: { path: 'package.json' } }]
                })
              }
            }]
          })
        }))
        .mockImplementationOnce((_url: string, init?: { body?: string }) => {
          const body = JSON.parse(init?.body ?? '{}')
          observationsReceived = body.messages
            .filter((m: { role: string }) => m.role === 'user')
            .map((m: { content: string }) => m.content)
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: 'done' } }] })
          })
        })

      const { execute } = makeAgent(makeSettings())
      await execute('test', makeTask())

      expect(observationsReceived.length).toBeGreaterThan(0)
      expect(observationsReceived.some(o => o.includes('read_file:'))).toBe(true)
    })
  })

  // 4. error paths
  describe('error handling', () => {
    it('throws when fetch returns non-ok status', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: { message: 'internal error' } })
      })

      const { execute } = makeAgent(makeSettings())
      await expect(execute('test', makeTask())).rejects.toThrow('模型请求失败')
    })

    it('throws when model returns empty content', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '' } }] })
      })

      const { execute } = makeAgent(makeSettings())
      await expect(execute('test', makeTask())).rejects.toThrow('模型返回为空')
    })

    it('throws when model returns missing content field', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: {} }] })
      })

      const { execute } = makeAgent(makeSettings())
      await expect(execute('test', makeTask())).rejects.toThrow('模型返回为空')
    })

    it('throws on AbortError with timeout message', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      globalThis.fetch = vi.fn().mockRejectedValue(abortError)

      const s = makeSettings({ timeoutMs: 3000 })
      const { execute } = makeAgent(s)
      await expect(execute('test', makeTask())).rejects.toThrow('模型请求超时（3秒）')
    })

    it('propagates tool execution errors upward', async () => {
      // model returns tool_call with write_file but no content → executeTool throws
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                tool_calls: [{ name: 'write_file', arguments: { path: 'test.txt' } }]
              })
            }
          }]
        })
      })

      const { execute } = makeAgent(makeSettings())
      await expect(execute('test', makeTask())).rejects.toThrow('工具参数不完整')
    })

    it('throws when tool is not enabled', async () => {
      const restrictedPolicy: AgentPolicy = {
        ...basePolicy,
        enabledTools: ['read_file'] // only read_file enabled
      }

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                tool_calls: [{ name: 'run_command', arguments: { command: 'dir' } }]
              })
            }
          }]
        })
      })

      const { execute } = makeAgent(makeSettings(), restrictedPolicy)
      await expect(execute('test', makeTask())).rejects.toThrow('工具未启用')
    })
  })

  // 5. boundary cases
  describe('boundary cases', () => {
    it('limits multiple tool calls in a single response to one step', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({
              tool_calls: [
                { name: 'read_file', arguments: { path: 'package.json' } },
                { name: 'read_file', arguments: { path: 'tsconfig.json' } }
              ]
            })
          : 'final'
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] })
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('test', task)
      expect(result).toBe('final')
      const observationSteps = task.steps.filter(s => s.phase === 'act' && s.title.startsWith('Observation #'))
      expect(observationSteps).toHaveLength(1)
      expect(callCount).toBe(2)
    })

    it('handles empty tool_calls array', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ tool_calls: [] }) } }]
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('test', task)
      // empty tool_calls means no tools executed, parseToolCalls returns []
      // but the content IS valid JSON with tool_calls, so it's returned directly
      expect(result).toContain('tool_calls')
    })

    it('truncates long tool output in step detail to 180 chars', async () => {
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{
              message: {
                content: JSON.stringify({
                  tool_calls: [{ name: 'read_file', arguments: { path: 'package.json' } }]
                })
              }
            }]
          })
        }))
        .mockImplementationOnce(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] })
        }))

      // mock WorkspaceTools.readFile to return long content
      vi.mock('../src/main/tools/workspace-tools', () => ({
        WorkspaceTools: vi.fn().mockImplementation(() => ({
          readFile: () => Promise.resolve('x'.repeat(300)),
          writeFile: () => Promise.resolve('ok'),
          runCommand: () => Promise.resolve('ok')
        }))
      }))

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      await execute('test', task)

      const toolStep = task.steps.find(s => s.title.includes('read_file'))
      expect(toolStep).toBeDefined()
      expect(toolStep!.detail.length).toBeLessThanOrEqual(180)
    })
  })
})
