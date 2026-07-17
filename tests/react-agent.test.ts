import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ReactAgent } from '../src/main/agent/react-agent'
import { PptMcpClient } from '../src/main/ppt/ppt-mcp-client'
import { WorkspaceTools } from '../src/main/tools/workspace-tools'
import type { AgentPolicy, AppSettings, AgentTask, ChatAttachment } from '../src/shared/types'

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- helpers ----
const basePolicy: AgentPolicy = {
  systemPrompt: 'test',
  workspacePath: 'D:/work/codext',
  enabledTools: ['read_file', 'write_file', 'create_directory', 'list_files', 'decrypt_file', 'parse_word', 'parse_excel', 'parse_powerpoint', 'run_command']
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
  describe('user choice continuation', () => {
    it('converts numbered alternatives into a radio choice and continues the same task', async () => {
      let modelCall = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ final: '# 路径需要确认\n\n请选择一种方式：\n\n1. 将项目放到当前工作区内。\n2. 将会话工作区切换到目标目录。' })
          : JSON.stringify({ final: '已按选择的目标目录继续执行。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const choices: Array<{ title: string; labels: string[] }> = []
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('创建项目', [], undefined, undefined, [], undefined, undefined, undefined, async (request) => {
        choices.push({ title: request.title, labels: request.options.map((option) => option.label) })
        return 'option_2'
      })

      expect(task.result).toBe('已按选择的目标目录继续执行。')
      expect(modelCall).toBe(2)
      expect(choices).toEqual([{ title: '路径需要确认', labels: ['将项目放到当前工作区内。', '将会话工作区切换到目标目录。'] }])
      expect(task.steps.some((step) => step.title === '用户已选择方案' && step.detail.includes('切换'))).toBe(true)
    })
  })

  describe('task pause', () => {
    it('marks the task paused when the active model request is aborted', async () => {
      const controller = new AbortController()
      globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      const { agent } = makeAgent(makeSettings())

      const runningTask = agent.run('生成一个较长回答', [], undefined, undefined, [], undefined, controller.signal)
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))
      controller.abort()
      const task = await runningTask

      expect(task.status).toBe('paused')
      expect(task.error).toBe('任务已暂停')
    })
  })

  describe('conversation workspace', () => {
    it('uses a per-conversation workspace without mutating the global policy', async () => {
      let modelCall = 0
      const conversationWorkspace = 'D:/work/conversation-workspace'
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ action: { name: 'list_files', arguments: {} } })
          : JSON.stringify({ final: 'done' })
        if (modelCall === 1) {
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> }
          expect(JSON.stringify(body.messages)).toContain(conversationWorkspace)
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('列出文件', [], undefined, undefined, [], undefined, undefined, conversationWorkspace)

      expect(task.status).toBe('succeeded')
      expect(basePolicy.workspacePath).toBe('D:/work/codext')
    })
  })

  describe('PPT MCP approval and decrypt recovery', () => {
    it('forces an enabled parse_powerpoint attempt before accepting a tool-unavailable final', async () => {
      let modelCall = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ final: '当前会话没有可用的 parse_powerpoint 工具。' })
          : JSON.stringify({ final: 'PPT 已解析。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const parse = vi.spyOn(PptMcpClient.prototype, 'parsePowerPoint').mockResolvedValue('slide content')
      const attachment: ChatAttachment = {
        id: 'ppt-sticky',
        name: 'slides.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 1024,
        dataUrl: '',
        workspacePath: 'slides.pptx'
      }
      const agent = new ReactAgent(() => makeSettings(), () => basePolicy, () => 'http://127.0.0.1:3777/mcp')

      const task = await agent.run('介绍 PPT', [], undefined, undefined, [attachment], async () => true)

      expect(task.result).toBe('PPT 已解析。')
      expect(modelCall).toBe(2)
      expect(parse).toHaveBeenCalledWith(expect.objectContaining({ path: attachment.workspacePath }))
    })

    it('does not request the same PPT MCP approval again after denial', async () => {
      let modelCall = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ final: '需要使用 parse_powerpoint 才能读取 PPT。' })
          : modelCall === 2
            ? JSON.stringify({ action: { name: 'parse_powerpoint', arguments: { path: 'slides.pptx' } } })
            : JSON.stringify({ final: '用户未授权 MCP，因此只能根据文件名说明，无法可靠总结正文。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const approval = vi.fn(async () => false)
      const attachment: ChatAttachment = {
        id: 'ppt-denied',
        name: 'slides.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 1024,
        dataUrl: '',
        workspacePath: 'slides.pptx'
      }
      const agent = new ReactAgent(() => makeSettings(), () => basePolicy, () => 'http://127.0.0.1:3777/mcp')

      const task = await agent.run('总结 PPT', [], undefined, undefined, [attachment], approval)

      expect(task.result).toContain('用户未授权 MCP')
      expect(approval).toHaveBeenCalledTimes(1)
      expect(modelCall).toBe(3)
    })

    it('does not connect to PPT MCP when the user denies approval', async () => {
      const agent = new ReactAgent(() => makeSettings(), () => basePolicy, () => 'http://127.0.0.1:3777/mcp')
      const parse = vi.spyOn(PptMcpClient.prototype, 'parsePowerPoint')
      const executeTool = (agent as unknown as {
        executeTool(call: { name: 'parse_powerpoint'; arguments: { path: string } }, tools: WorkspaceTools, policy: AgentPolicy, approval: () => Promise<boolean>): Promise<string>
      }).executeTool.bind(agent)

      const output = await executeTool(
        { name: 'parse_powerpoint', arguments: { path: 'slides.pptx' } },
        new WorkspaceTools(basePolicy.workspacePath),
        basePolicy,
        async () => false
      )

      expect(output).toContain('未授权')
      expect(parse).not.toHaveBeenCalled()
    })

    it('requests approval before connecting to PPT MCP', async () => {
      const events: string[] = []
      const agent = new ReactAgent(() => makeSettings(), () => basePolicy, () => 'http://127.0.0.1:3777/mcp')
      vi.spyOn(PptMcpClient.prototype, 'parsePowerPoint').mockImplementation(async () => {
        events.push('connect')
        return 'parsed'
      })
      const executeTool = (agent as unknown as {
        executeTool(call: { name: 'parse_powerpoint'; arguments: { path: string } }, tools: WorkspaceTools, policy: AgentPolicy, approval: () => Promise<boolean>): Promise<string>
      }).executeTool.bind(agent)

      await executeTool(
        { name: 'parse_powerpoint', arguments: { path: 'slides.pptx' } },
        new WorkspaceTools(basePolicy.workspacePath),
        basePolicy,
        async () => { events.push('approval'); return true }
      )

      expect(events).toEqual(['approval', 'connect'])
    })

    it('continues with decrypt_file after PPT parsing fails', async () => {
      let modelCall = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ action: { name: 'parse_powerpoint', arguments: { path: 'encrypted.pptx' } } })
          : modelCall === 2
            ? JSON.stringify({ action: { name: 'decrypt_file', arguments: { path: 'encrypted.pptx' } } })
            : JSON.stringify({ final: '已生成解密副本' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(PptMcpClient.prototype, 'parsePowerPoint').mockRejectedValue(new Error('文件已加密，无法解析'))
      const decrypt = vi.spyOn(WorkspaceTools.prototype, 'decryptFile').mockResolvedValue('{"ok":true,"output_path":"encrypted.decrypted.pptx","size_bytes":1024}')
      const agent = new ReactAgent(() => makeSettings(), () => basePolicy, () => 'http://127.0.0.1:3777/mcp')
      const task = makeTask()

      const result = await (agent as unknown as {
        execute(prompt: string, policy: AgentPolicy, task: AgentTask, history: [], onStep: undefined, onDelta: undefined, attachments: [], approval: () => Promise<boolean>): Promise<string>
      }).execute('读取加密演示文稿', basePolicy, task, [], undefined, undefined, [], async () => true)

      expect(result).toBe('已生成解密副本')
      expect(decrypt).toHaveBeenCalledWith('encrypted.pptx', undefined)
      expect(task.steps.some((item) => item.detail.includes('文件已加密'))).toBe(true)
    })
  })

  describe('encrypted text attachment recovery', () => {
    it('requires a decrypt attempt before accepting a final answer for suspicious CSV', async () => {
      let modelCall = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ final: '这不是正常 CSV，请重新上传原文件。' })
          : modelCall === 2
            ? JSON.stringify({ action: { name: 'decrypt_file', arguments: { path: '.codext-attachments/upload/readme.csv' } } })
            : JSON.stringify({ final: '已调用解密工具。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const decrypt = vi.spyOn(WorkspaceTools.prototype, 'decryptFile').mockResolvedValue('{"ok":true,"output_path":".codext-attachments/upload/readme.decrypted.csv","size_bytes":30}')
      const attachment: ChatAttachment = {
        id: 'encrypted-csv',
        name: 'readme.csv',
        mimeType: 'text/csv',
        size: 8,
        dataUrl: 'data:text/csv;base64,' + Buffer.from([0, 1, 2, 0, 3, 4, 0, 5]).toString('base64'),
        workspacePath: '.codext-attachments/upload/readme.csv'
      }
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('继续读取刚才的 CSV', [{ role: 'user', content: '读取这个 CSV', attachments: [attachment] }])

      expect(task.result).toBe('已调用解密工具。')
      expect(modelCall).toBe(3)
      expect(decrypt).toHaveBeenCalledWith(attachment.workspacePath, undefined)
      const firstRequest = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body)) as { messages: Array<{ content: unknown }> }
      expect(JSON.stringify(firstRequest.messages)).toContain('必须先调用 decrypt_file')
      expect(JSON.stringify(firstRequest.messages)).toContain(attachment.workspacePath)
    })
  })

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

    it('sends image and text attachments as multimodal user content', async () => {
      const { agent } = makeAgent(makeSettings())
      const attachments: ChatAttachment[] = [
        { id: 'image-1', name: 'screenshot.png', mimeType: 'image/png', size: 8, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
        { id: 'text-1', name: 'notes.txt', mimeType: 'text/plain', size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=' }
      ]

      await agent.run('describe these attachments', [], undefined, undefined, attachments)

      const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
      const body = JSON.parse(String(request?.body)) as {
        messages: Array<{
          role: string
          content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
        }>
      }
      const userContent = body.messages.find((message) => message.role === 'user')?.content
      expect(Array.isArray(userContent)).toBe(true)
      if (!Array.isArray(userContent)) throw new Error('expected multimodal content')
      expect(userContent.some((part) => part.type === 'image_url' && part.image_url?.url === attachments[0].dataUrl)).toBe(true)
      expect(userContent.some((part) => part.type === 'text' && part.text?.includes('notes.txt') && part.text.includes('hello'))).toBe(true)
    })

    it('sends an image attachment even when the visible message has no text', async () => {
      const { agent } = makeAgent(makeSettings())
      const image: ChatAttachment = { id: 'image-only', name: 'clipboard.png', mimeType: 'image/png', size: 8, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }

      await agent.run('', [], undefined, undefined, [image])

      const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
      const body = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: unknown }> }
      const userContent = body.messages.find((message) => message.role === 'user')?.content
      expect(userContent).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } })
      ]))
    })

    it('tells the model how to parse an uploaded Office attachment', async () => {
      let modelCall = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ final: '当前没有可用的 parse_excel 工具。' })
          : JSON.stringify({ final: '已尝试解析工作簿。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const { agent } = makeAgent(makeSettings())
      const officeAttachment: ChatAttachment = {
        id: 'office-1',
        name: 'quarterly-report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 1024,
        dataUrl: '',
        workspacePath: '.codext-attachments/upload/quarterly-report.xlsx'
      }

      const task = await agent.run('summarize this workbook', [], undefined, undefined, [officeAttachment])

      const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
      const body = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: unknown }> }
      const userContent = body.messages.find((message) => message.role === 'user')?.content
      expect(userContent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('parse_excel')
        })
      ]))
      expect(JSON.stringify(userContent)).toContain(officeAttachment.workspacePath)
      expect(modelCall).toBe(2)
      expect(task.steps.some((step) => step.title.includes('parse_excel'))).toBe(true)
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

    it('extracts final text from malformed JSON with raw newlines', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"final":"line one\nline two"} trailing' } }] })
      })

      const { execute } = makeAgent(makeSettings())
      const result = await execute('finish', makeTask())

      expect(result).toBe('line one\nline two')
      expect(result).not.toContain('{"final"')
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
          ? JSON.stringify({ thought: '已成功写入 HTML 文件。准备创建 CSS 文件。', action: { name: 'write_file', arguments: { path: 'tests/fixtures/generated-style.css', content: 'body {}' } } })
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
      await rm(join(process.cwd(), 'tests/fixtures/generated-style.css'), { force: true })
    })

    it('recovers write_file action when content contains raw newlines', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? '{"action":{"name":"write_file","arguments":{"path":"tests/fixtures/generated-raw-newlines.txt","content":"line one\nline two"}} trailing'
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
      await rm(join(process.cwd(), 'tests/fixtures/generated-raw-newlines.txt'), { force: true })
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

    it('continues when model returns an incomplete final asking for observations', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ final: '任务尚未完成，请提供工具返回结果后继续。' })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'read_file', arguments: { path: 'package.json' } } })
            : JSON.stringify({ final: 'completed' })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] })
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('continue task', task)

      expect(result).toBe('completed')
      expect(callCount).toBe(3)
      expect(task.steps.some((item) => item.title.includes('read_file'))).toBe(true)
    })

    it('continues after read_file reports a missing file', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'read_file', arguments: { path: 'missing-file.txt' } } })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'write_file', arguments: { path: 'tests/fixtures/recovered-missing-file.txt', content: 'created' } } })
            : JSON.stringify({ final: 'recovered from missing file' })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content } }] })
        })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('recover files', task)

      expect(result).toBe('recovered from missing file')
      expect(callCount).toBe(3)
      expect(task.steps.some((item) => item.detail.includes('工具执行失败'))).toBe(true)
      expect(task.steps.some((item) => item.title.includes('write_file'))).toBe(true)
      await rm(join(process.cwd(), 'tests/fixtures/recovered-missing-file.txt'), { force: true })
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

    it('retries transient 524 responses', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 524,
            json: () => Promise.resolve({ error: { message: 'Server error, please try again later.' } })
          })
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'recovered' }) } }] })
        })
      })

      const { execute } = makeAgent(makeSettings({ maxRetries: 1 }))
      const result = await execute('retry task', makeTask())
      expect(result).toBe('recovered')
      expect(callCount).toBe(2)
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

    it('truncates long tool output in step detail to 800 chars', async () => {
      globalThis.fetch = vi.fn()
        .mockImplementationOnce(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{
              message: {
                content: JSON.stringify({
                  tool_calls: [{ name: 'read_file', arguments: { path: 'tests/fixtures/long-tool-output.txt' } }]
                })
              }
            }]
          })
        }))
        .mockImplementationOnce(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] })
        }))

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const fixturePath = join(process.cwd(), 'tests/fixtures/long-tool-output.txt')
      await mkdir(dirname(fixturePath), { recursive: true })
      await writeFile(fixturePath, 'x'.repeat(1_000), 'utf8')

      try {
        await execute('test', task)
      } finally {
        await rm(fixturePath, { force: true })
      }

      const observationStep = task.steps.find(s => s.title.startsWith('Observation #') && s.title.includes('read_file'))
      expect(observationStep).toBeDefined()
      expect(observationStep!.detail).toHaveLength(800)
    })
  })
})
