import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ReactAgent } from '../src/main/agent/react-agent'
import { PptMcpClient } from '../src/main/ppt/ppt-mcp-client'
import { WorkspaceTools } from '../src/main/tools/workspace-tools'
import type { AgentPolicy, AppSettings, AgentTask, ChatAttachment, CommandApprovalDetails } from '../src/shared/types'

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- helpers ----
const basePolicy: AgentPolicy = {
  systemPrompt: 'test',
  workspacePath: 'D:/work/codext',
  enabledTools: ['read_file', 'write_file', 'edit_file', 'create_directory', 'list_files', 'decrypt_file', 'parse_word', 'parse_excel', 'parse_powerpoint', 'run_command', 'start_service']
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
    skillsEnabled: true,
    navigation: { fileApplicationPath: '', browserApplicationPath: '' }
  }
}

/** 创建一个用于反射调用 private execute 的 agent 包装 */
function makeAgent(settings: AppSettings, policy: AgentPolicy = basePolicy) {
  const agent = new ReactAgent(() => settings, () => policy)
  return {
    agent,
    execute(prompt: string, task: AgentTask, requestCommandApproval?: (details: CommandApprovalDetails) => Promise<boolean>) {
      return (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: undefined, onDelta?: undefined, attachments?: [], requestMcpApproval?: undefined, signal?: undefined, requestUserChoice?: undefined, requestCommandApproval?: (details: CommandApprovalDetails) => Promise<boolean>) => Promise<string> })
        .execute(prompt, policy, task, [], undefined, undefined, [], undefined, undefined, undefined, requestCommandApproval)
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

function runWithCommandApproval(agent: ReactAgent, prompt: string, approval: (details: CommandApprovalDetails) => Promise<boolean>): Promise<AgentTask> {
  return agent.run(prompt, [], undefined, undefined, [], undefined, undefined, undefined, undefined, approval)
}

// ---- tests ----
describe('ReactAgent.execute', () => {
  it('adds the selected tone and custom instructions to the system prompt', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }] })
    })
    const personalizedSettings: AppSettings = {
      ...makeSettings(),
      personalization: { tone: 'professional', customInstructions: '默认使用中文，并在修改代码后说明验证结果。' }
    }

    await makeAgent(personalizedSettings).agent.run('检查设置')

    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: string }> }
    const systemPrompt = body.messages.find((message) => message.role === 'system')?.content ?? ''
    expect(systemPrompt).toContain('语气偏好：专业严谨')
    expect(systemPrompt).toContain('默认使用中文，并在修改代码后说明验证结果。')
    expect(systemPrompt).toContain('不得覆盖安全策略、权限规则、工具协议')
  })

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

    it('switches the active tool context after a workspace choice', async () => {
      let modelCall = 0
      const targetWorkspace = 'D:/work/aigent'
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        modelCall++
        const content = modelCall === 1
          ? JSON.stringify({ choice: { title: '选择工作区', options: [
            { id: 'current', label: '保留当前工作区' },
            { id: 'switch', label: '切换到 aigent 工作区', workspacePath: targetWorkspace }
          ] } })
          : modelCall === 2
            ? JSON.stringify({ action: { name: 'list_files', arguments: {} } })
            : JSON.stringify({ final: 'done' })
        if (modelCall === 2) {
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> }
          expect(JSON.stringify(body.messages)).toContain(targetWorkspace)
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const listFiles = vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockImplementation(function () {
        expect((this as unknown as { workspacePath: string }).workspacePath).toBe(targetWorkspace)
        return Promise.resolve('目录为空')
      })
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('在目标目录创建项目', [], undefined, undefined, [], undefined, undefined, undefined, async (request) => {
        expect(request.options.find((option) => option.id === 'switch')?.workspacePath).toBe(targetWorkspace)
        return { optionId: 'switch', workspacePath: targetWorkspace }
      })

      expect(task.status).toBe('succeeded')
      expect(listFiles).toHaveBeenCalledOnce()
      expect(task.steps.some((item) => item.title === '会话工作区已切换' && item.detail === targetWorkspace)).toBe(true)
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
      await execute('explain ReAct briefly', makeTask())

      const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
      const body = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: string }> }
      const systemPrompt = body.messages.find((message) => message.role === 'system')?.content ?? ''
      expect(systemPrompt).toContain('未完成措辞')
      expect(systemPrompt).toContain('严禁声称文件已经创建')
      expect(systemPrompt).toContain('宿主运行环境（应用启动时自动检测')
      expect(systemPrompt).toContain('操作系统：')
      expect(systemPrompt).toContain('（' + process.platform + '）')
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

    it('strips thought tags from a final response before displaying it', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: '<think>internal reasoning</think>visible answer' }) } }] })
      })

      const { execute } = makeAgent(makeSettings())
      const result = await execute('what is 2+2', makeTask())

      expect(result).toBe('visible answer')
      expect(result).not.toContain('<think>')
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

    it('does not send unrelated historical screenshots or task text to the model', async () => {
      const { agent } = makeAgent(makeSettings())
      const oldImage: ChatAttachment = {
        id: 'old-image',
        name: 'old-ui.png',
        mimeType: 'image/png',
        size: 8,
        dataUrl: 'data:image/png;base64,b2xkLWltYWdl'
      }
      const history = [
        { role: 'user' as const, content: '重新设计旧页面', attachments: [oldImage] },
        { role: 'assistant' as const, content: '旧页面已经处理完成', status: 'succeeded' },
        { role: 'user' as const, content: "测试连接时报错 NoneType strip" },
        { role: 'assistant' as const, content: '连接问题尚未修复', status: 'paused' }
      ]

      await agent.run('修复测试连接的 NoneType strip 问题', history)

      const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
      const body = String(request?.body)
      expect(body).toContain('测试连接时报错')
      expect(body).not.toContain('old-ui.png')
      expect(body).not.toContain(oldImage.dataUrl)
      expect(body).not.toContain('重新设计旧页面')
      expect(body).not.toContain('旧页面已经处理完成')
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

    it('hides tagged reasoning when the JSON final has no thought', async () => {
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
      expect(stepSnapshots).toEqual([])
      expect(stepSnapshots.some((item) => item.includes('先分析') || item.includes('<think>'))).toBe(false)
      expect(task.steps.filter((item) => item.title === '思考过程')).toHaveLength(0)
    })

    it('discards provider reasoning and keeps only JSON thought in UI and follow-up context', async () => {
      const encoder = new TextEncoder()
      const ssePayload = (payload: unknown): Uint8Array => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n')
      const requestBodies: Array<{ messages?: Array<{ content?: string }> }> = []
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)))
        callCount++
        if (callCount === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: {
              reasoning_content: '第二轮不应进入展示的原始长思考。',
              content: JSON.stringify({ thought: '已完成文件检查。', final: 'done' })
            } }] })
          })
        }
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'text/event-stream' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(ssePayload({ choices: [{ delta: { reasoning: '这是厂商独立返回的原始长思考，不应进入 UI 或上下文。' } }] }))
              controller.enqueue(ssePayload({ choices: [{ delta: { content: '<think>正文里兼容的长思考也不应保留。</think>' } }] }))
              controller.enqueue(ssePayload({ choices: [{ delta: { content: '{"thought":"准备读取 package。json。","action":{"name":"read_file","arguments":{"path":"package.json"}}}' } }] }))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            }
          })
        })
      })
      vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('{"name":"codext-agent"}')

      const stepSnapshots: string[] = []
      const { agent } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: (step: { title: string; detail: string }) => void) => Promise<string> })
        .execute('read package', basePolicy, task, [], (taskStep) => {
          if (taskStep.title === '思考过程') stepSnapshots.push(taskStep.detail)
        })

      const followUpContext = JSON.stringify(requestBodies[1]?.messages ?? [])
      expect(result).toBe('done')
      expect(stepSnapshots).toContain('准备读取 package.json。')
      expect(stepSnapshots).toContain('已完成文件检查。')
      expect(stepSnapshots.some((item) => item.includes('原始长思考') || item.includes('正文里兼容'))).toBe(false)
      expect(followUpContext).not.toContain('原始长思考')
      expect(followUpContext).not.toContain('正文里兼容')
      expect(followUpContext).not.toContain('<think>')
      expect(followUpContext).toContain('准备读取 package.json。')
    })
  })

  // 3. model returns tool_calls
  describe('with tool calls', () => {
    it('does not turn a final-only URL into a web preview artifact', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'write_file', arguments: { path: 'src/app.ts', content: 'export {}' } } })
          : JSON.stringify({ final: '应用已完成，可访问 http://0.0.0.0:5173/app。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockResolvedValue('已写入 src/app.ts')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('创建应用')

      expect(task.status).toBe('succeeded')
      expect(task.artifacts).toEqual([{ type: 'file', path: 'src/app.ts' }])
    })

    it('executes edit_file and records the edited file as an artifact', async () => {
      let callCount = 0
      const requestBodies: Array<{ messages?: Array<{ content: unknown }> }> = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++
        requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ content: unknown }> })
        const content = callCount === 1
          ? JSON.stringify({ thought: '准备修改已有配置。', action: { name: 'edit_file', arguments: { path: 'src/config.ts', old_text: 'port: 3000', new_text: 'port: 5173' } } })
          : JSON.stringify({ thought: '修改已经完成。', final: '配置已更新。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const editFile = vi.spyOn(WorkspaceTools.prototype, 'editFile').mockResolvedValue(JSON.stringify({ ok: true, path: 'src/config.ts', replacements: 1 }))
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('将端口改为 5173')

      expect(task.status).toBe('succeeded')
      expect(editFile).toHaveBeenCalledWith('src/config.ts', 'port: 3000', 'port: 5173', false)
      expect(task.artifacts).toEqual([{ type: 'file', path: 'src/config.ts' }])
      expect(requestBodies[1]?.messages?.some((message) =>
        typeof message.content === 'string' && message.content.includes('"replacements":1')
      )).toBe(true)
    })

    it('starts a persistent service with start_service and records its URL', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'start_service', arguments: { command: 'node', args: ['server.js'] } } })
          : JSON.stringify({ final: '服务已启动：[http://127.0.0.1:3000/](http://127.0.0.1:3000/)' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const startService = vi.spyOn(WorkspaceTools.prototype, 'startService').mockResolvedValue(JSON.stringify({ ok: true, url: 'http://127.0.0.1:3000/', pid: 123 }))
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动服务', approval)

      expect(task.status).toBe('succeeded')
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ command: 'node', args: ['server.js'], displayCommand: 'node server.js' }))
      expect(startService).toHaveBeenCalledWith('node', ['server.js'], undefined, false)
      expect(task.artifacts).toEqual([{ type: 'service', url: 'http://127.0.0.1:3000/', createdByAgent: true }])
    })

    it('previews only a started service URL that is also present in the final summary', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'start_service', arguments: { command: 'node', args: ['server.js'] } } })
          : JSON.stringify({ final: '已启动 [本地预览](http://127.0.0.1:3000/)\n\n参考文档：https://example.com/docs' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'startService').mockResolvedValue('service running at http://127.0.0.1:3000/; docs https://example.com/docs')
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动本地服务', vi.fn(async () => true))

      expect(task.artifacts).toEqual([{ type: 'service', url: 'http://127.0.0.1:3000/', createdByAgent: true }])
      expect(task.result).toContain('https://example.com/docs')
    })

    it('keeps a started service preview when the final URL is wrapped in Markdown emphasis', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'start_service', arguments: { command: 'node', args: ['server.js'] } } })
          : JSON.stringify({ final: '访问地址：**http://localhost:3100/**' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'startService').mockResolvedValue(JSON.stringify({ ok: true, url: 'http://localhost:3100/', pid: 123 }))
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动本地服务', vi.fn(async () => true))

      expect(task.artifacts).toEqual([{ type: 'service', url: 'http://localhost:3100/', createdByAgent: true }])
    })

    it('removes a started service preview when the final summary omits its URL', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'start_service', arguments: { command: 'node', args: ['server.js'] } } })
          : JSON.stringify({ final: '服务已启动。参考：https://example.com/docs' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'startService').mockResolvedValue(JSON.stringify({ ok: true, url: 'http://127.0.0.1:3000/', pid: 123 }))
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动本地服务', vi.fn(async () => true))

      expect(task.artifacts).toBeUndefined()
    })

    it('requests approval before running an SSH read-only command', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'ssh', args: ['user@166-server', 'find /home/guider/work -maxdepth 2 -type f'] } } })
          : JSON.stringify({ final: 'remote directory inspected' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('/home/guider/work/file.txt')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '查看远程目录', approval)

      expect(task.status).toBe('succeeded')
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ command: 'ssh', args: ['user@166-server', 'find /home/guider/work -maxdepth 2 -type f'] }))
      expect(runCommand).toHaveBeenCalledWith('ssh', ['user@166-server', 'find /home/guider/work -maxdepth 2 -type f'], undefined, true, false)
    })

    it('publishes live command output and clears it after the final observation', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'node', args: ['build.js'] } } })
          : JSON.stringify({ final: '构建已完成。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockImplementation(async (_command, _args, _signal, _writeApproved, _dangerousApproved, _background, onOutput) => {
        onOutput?.('\u001b[32mcompiling\u001b[0m\r', 'stdout')
        await new Promise((resolve) => setTimeout(resolve, 90))
        onOutput?.('done\n', 'stderr')
        await new Promise((resolve) => setTimeout(resolve, 90))
        return 'compiling\ndone'
      })
      const stepSnapshots: Array<{ title: string; detail: string }> = []
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run(
        '执行构建',
        [],
        (taskStep) => stepSnapshots.push({ title: taskStep.title, detail: taskStep.detail }),
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        approval
      )

      const liveSnapshots = stepSnapshots.filter((item) => item.title.startsWith('命令实时输出：'))
      expect(liveSnapshots.some((item) => item.detail.includes('compiling'))).toBe(true)
      expect(liveSnapshots.some((item) => item.detail.includes('done'))).toBe(true)
      expect(liveSnapshots.at(-1)?.detail).toBe('')
      expect(task.steps.find((item) => item.title.startsWith('命令实时输出：'))?.detail).toBe('')
      expect(task.steps.some((item) => item.title.includes('Observation') && item.detail.includes('compiling\ndone'))).toBe(true)
      expect(task.status).toBe('succeeded')
    })

    it('starts a desktop app with a confirmed background run_command', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'npm', args: ['run', 'electron:dev'], background: true } } })
          : JSON.stringify({ final: '桌面客户端已启动。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue(JSON.stringify({ ok: true, background: true, pid: 4321 }))
      const startService = vi.spyOn(WorkspaceTools.prototype, 'startService')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动 Electron 客户端', approval)

      expect(task.status).toBe('succeeded')
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({
        command: 'npm',
        args: ['run', 'electron:dev'],
        background: true,
        reason: expect.stringContaining('后台启动程序')
      }))
      expect(runCommand).toHaveBeenCalledWith('npm', ['run', 'electron:dev'], undefined, true, false, true)
      expect(startService).not.toHaveBeenCalled()
      expect(task.result).toBe('桌面客户端已启动。')
    })

    it('forces a shell-wrapped Electron launch into background mode when the model omits it', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'bash', args: ['-c', 'ELECTRON_DISABLE_SANDBOX=1 node_modules/electron/dist/electron .'] } } })
          : JSON.stringify({ final: 'Electron 客户端已启动。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue(JSON.stringify({ ok: true, background: true, pid: 9876 }))
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动 Electron APP', approval)

      expect(task.status).toBe('succeeded')
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ background: true, reason: expect.stringContaining('后台启动程序') }))
      expect(runCommand).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ELECTRON_DISABLE_SANDBOX=1 node_modules/electron/dist/electron .'],
        undefined,
        true,
        false,
        true
      )
    })

    it('repairs a malformed Electron start_service call into a background run_command', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'start_service', arguments: { command: 'ELECTRON_DISABLE_SANDBOX=1 npx electron .', args: [] } } })
          : JSON.stringify({ final: 'Electron 客户端已启动。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue(JSON.stringify({ ok: true, background: true, pid: 8765 }))
      const startService = vi.spyOn(WorkspaceTools.prototype, 'startService')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动 Electron APP', approval)

      expect(task.status).toBe('succeeded')
      expect(runCommand).toHaveBeenCalledWith('npx', ['electron', '--no-sandbox', '.'], undefined, true, false, true)
      expect(startService).not.toHaveBeenCalled()
    })

    it('recovers a complete startup command from a premature model final and asks for approval', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ final: '由于安全策略限制，请手动执行：\n\npython -m src.server --web --port 8000' })
          : JSON.stringify({ final: '已收到启动结果。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('进程已启动，PID 1234')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '帮我启动这个 APP', approval)

      expect(task.status).toBe('succeeded')
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({
        command: 'python',
        args: ['-m', 'src.server', '--web', '--port', '8000']
      }))
      expect(runCommand).toHaveBeenCalledWith('python', ['-m', 'src.server', '--web', '--port', '8000'], undefined, true, false, true)
    })

    it('recovers an executable-style npx action and requests command approval', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'npx', arguments: { args: ['vite', '--version'] } } })
          : JSON.stringify({ final: 'vite version checked' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('vite/6.3.5')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '检查 Vite 版本', approval)

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('vite version checked')
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ command: 'npx', args: ['vite', '--version'], displayCommand: 'npx vite --version' }))
      expect(runCommand).toHaveBeenCalledWith('npx', ['vite', '--version'], undefined, true, false)
      expect(task.steps.some((item) => item.title === '修复工具调用参数')).toBe(false)
    })

    it('does not start a service when the user rejects its command', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount <= 2
          ? JSON.stringify({ action: { name: 'start_service', arguments: { command: 'npm', args: ['run', 'dev'] } } })
          : JSON.stringify({ final: 'service start cancelled' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const startService = vi.spyOn(WorkspaceTools.prototype, 'startService')
      const approval = vi.fn(async () => false)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '启动开发服务', approval)

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('service start cancelled')
      expect(callCount).toBe(3)
      expect(approval).toHaveBeenCalledOnce()
      expect(startService).not.toHaveBeenCalled()
    })

    it('requests single-use approval before executing a write command', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'npm', args: ['install'] } } })
          : JSON.stringify({ final: 'dependencies installed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('installed')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '安装依赖', approval)

      expect(task.status).toBe('succeeded')
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm', args: ['install'], displayCommand: 'npm install' }))
      expect(runCommand).toHaveBeenCalledWith('npm', ['install'], undefined, true, false)
    })

    it('does not request the same write command again after the user denies it', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount <= 2
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'npm', args: ['install'] } } })
          : JSON.stringify({ final: 'continued without installing dependencies' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand')
      const approval = vi.fn(async () => false)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '尝试安装依赖', approval)

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('continued without installing dependencies')
      expect(approval).toHaveBeenCalledOnce()
      expect(runCommand).not.toHaveBeenCalled()
    })

    it('corrects a restart refusal and requests explicit approval for the high-risk command', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ final: '不能直接重启，因为需要终止进程。' })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'kill', args: ['-TERM', '1234'] } } })
            : JSON.stringify({ final: 'client restarted' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('terminated')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '帮我直接重启', approval)

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('client restarted')
      expect(task.steps.some((item) => item.title === '模型尚未执行所需工具')).toBe(true)
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ command: 'kill', args: ['-TERM', '1234'], riskLevel: 'blocked' }))
      expect(runCommand).toHaveBeenCalledWith('kill', ['-TERM', '1234'], undefined, true, true)
    })

    it('adds a finalization turn after the last allowed tool observation', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount <= 2
          ? JSON.stringify({ action: { name: 'list_files', arguments: { path: 'turn-' + callCount } } })
          : JSON.stringify({ final: '最后一次验证完成。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const agent = new ReactAgent(() => makeSettings(), () => basePolicy, () => '', 2)

      const task = await agent.run('执行两轮工具后完成')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('最后一次验证完成。')
      expect(callCount).toBe(3)
      expect(task.steps.filter((item) => item.title.includes('list_files'))).toHaveLength(4)
    })

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

    it('executes a standard Thought Action Action Input response', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? 'Thought: I need to inspect the workspace.\nAction: list_files\nAction Input: {"path":".","recursive":false}'
          : JSON.stringify({ thought: 'The directory was inspected.', final: 'workspace inspected' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const listFiles = vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('inspect project files')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('workspace inspected')
      expect(listFiles).toHaveBeenCalledWith('.', false)
      expect(task.steps.some((item) => item.title.includes('list_files'))).toBe(true)
    })

    it('executes a Chinese ReAct text response', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? '思考：需要先读取配置。\n行动：read_file\n行动输入：{"path":"package.json"}'
          : JSON.stringify({ thought: '已读取配置。', final: '配置读取完成' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('{}')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('读取 package.json')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('配置读取完成')
      expect(readFile).toHaveBeenCalledWith('package.json')
    })

    it('recovers a read_file action from a concise narrative response', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? 'Looking at the backend code in src/api/server.py, the error is probably from FastAPI. I need to read ui/src/components/ConfigPanel.tsx to see how the frontend calls the endpoint. Let me also check src/core/llm.py later.'
          : JSON.stringify({ final: '继续处理' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('from fastapi import FastAPI')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('检查 API 报错')

      expect(task.status).toBe('succeeded')
      expect(readFile).toHaveBeenCalledWith('ui/src/components/ConfigPanel.tsx')
      expect(task.result).toBe('继续处理')
    })

    it('rejects a premature final and asks for an executable ReAct action', async () => {
      let callCount = 0
      const requestBodies: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requestBodies.push(String(init?.body ?? ''))
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ thought: 'I can answer directly.', final: 'The files look fine.' })
          : callCount === 2
            ? JSON.stringify({ thought: 'I need an Observation.', action: { name: 'list_files', arguments: { path: '.' } } })
            : JSON.stringify({ thought: 'The directory was inspected.', final: 'The files were inspected.' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('inspect project files')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('The files were inspected.')
      expect(callCount).toBe(3)
      expect(task.steps.some((item) => item.title === '模型尚未执行所需工具')).toBe(true)
      expect(requestBodies[1]).toContain('FORMAT_ERROR')
      expect(requestBodies[1]).toContain('需要实际读取、写入、检查或执行')
    })

    it('inherits tool intent from the previous user request when asked to continue', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ final: 'I will continue later.' })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'list_files', arguments: { path: '.' } } })
            : JSON.stringify({ final: 'continued and inspected' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const listFiles = vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('继续', [
        { role: 'user', content: '查看这个项目的文件' },
        { role: 'assistant', content: '我准备检查。' }
      ])

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('continued and inspected')
      expect(listFiles).toHaveBeenCalledWith('.', false)
      expect(task.steps.some((item) => item.title === '模型尚未执行所需工具')).toBe(true)
    })

    it('normalizes native OpenAI tool_calls into the ReAct loop', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: {
              content: null,
              reasoning_content: '需要查看目录。',
              tool_calls: [{ function: { name: 'list_files', arguments: '{"path":"."}' } }]
            } }] })
          })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'done' }) } }] }) })
      })
      const listFiles = vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('inspect project files')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('done')
      expect(listFiles).toHaveBeenCalledWith('.', false)
    })

    it('executes multiple Qwen XML tool calls and hides the raw think block', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? '<think>This is private and verbose reasoning that must not reach the UI.</think>\n' +
            '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>\n' +
            '<tool-call>{"name":"read_file","parameters":"{\\"path\\":\\"b.ts\\"}"}</tool-call>'
          : JSON.stringify({ final: 'Qwen tools completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('file content')
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('读取 a.ts 和 b.ts')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('Qwen tools completed')
      expect(readFile).toHaveBeenCalledTimes(2)
      expect(readFile).toHaveBeenNthCalledWith(1, 'a.ts')
      expect(readFile).toHaveBeenNthCalledWith(2, 'b.ts')
      expect(task.steps.some((item) => item.detail.includes('private and verbose'))).toBe(false)
    })

    it('runs consecutive independent read-only tool calls in parallel while preserving observation order', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++
        if (callCount === 1) {
          const body = JSON.parse(String(init?.body)) as { tools?: unknown[]; tool_choice?: string; parallel_tool_calls?: boolean }
          expect(body.tools?.length).toBeGreaterThan(0)
          expect(body.tool_choice).toBeUndefined()
          expect(body.parallel_tool_calls).toBeUndefined()
        }
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { name: 'read_file', arguments: { path: 'slow.ts' } },
              { name: 'read_file', arguments: { path: 'fast.ts' } }
            ] })
          : JSON.stringify({ final: 'parallel reads completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      let active = 0
      let maximumActive = 0
      vi.spyOn(WorkspaceTools.prototype, 'readFile').mockImplementation(async (path) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        return path + ' content'
      })
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('并行读取 slow.ts 和 fast.ts')

      expect(task.status).toBe('succeeded')
      expect(maximumActive).toBe(2)
      const observations = task.steps.filter((item) => item.title.startsWith('Observation #'))
      expect(observations.map((item) => item.title)).toEqual([
        expect.stringContaining('read_file'),
        expect.stringContaining('read_file')
      ])
      expect(observations.map((item) => item.detail)).toEqual(['slow.ts content', 'fast.ts content'])
    })

    it('parallelizes independent mutating calls when their resources do not conflict', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tools: [
              { name: 'write_file', input: { path: 'a.txt', content: 'a' } },
              { name: 'write_file', action_input: { path: 'b.txt', content: 'b' } }
            ] })
          : JSON.stringify({ final: 'serial writes completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      let active = 0
      let maximumActive = 0
      const writeFile = vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockImplementation(async (path) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        return 'wrote ' + path
      })
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('依次写入 a.txt 和 b.txt')

      expect(task.status).toBe('succeeded')
      expect(maximumActive).toBe(2)
      expect(writeFile).toHaveBeenNthCalledWith(1, 'a.txt', 'a')
      expect(writeFile).toHaveBeenNthCalledWith(2, 'b.txt', 'b')
    })

    it('parallelizes independent writes to different files when no dependency exists', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { id: 'write_a', name: 'write_file', arguments: { path: 'a.txt', content: 'a' } },
              { id: 'write_b', name: 'write_file', arguments: { path: 'b.txt', content: 'b' } }
            ] })
          : JSON.stringify({ final: 'independent writes completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      let active = 0
      let maximumActive = 0
      vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockImplementation(async (path) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        return 'wrote ' + path
      })
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('分别创建两个互不相关的文件')

      expect(task.status).toBe('succeeded')
      expect(maximumActive).toBe(2)
      expect(task.steps.some((item) => item.title === '已规划工具执行顺序' && item.detail.includes('并行'))).toBe(true)
    })

    it('serializes writes sharing a newly-created parent directory', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { name: 'write_file', arguments: { path: 'snake-game/index.html', content: '<html />' } },
              { name: 'write_file', arguments: { path: 'snake-game/style.css', content: 'body {}' } },
              { name: 'write_file', arguments: { path: 'snake-game/script.js', content: 'console.log(1)' } }
            ] })
          : JSON.stringify({ final: 'game files created' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      let active = 0
      let maximumActive = 0
      vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockImplementation(async (path) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        return 'wrote ' + path
      })
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('创建 snake-game 游戏文件')

      expect(task.status).toBe('succeeded')
      expect(maximumActive).toBe(1)
      expect(task.steps.some((item) => item.title === '已规划工具执行顺序' && item.detail.includes('资源存在读写冲突'))).toBe(true)
    })

    it('serializes same-file write and read calls because their resources conflict', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { id: 'write_config', name: 'write_file', arguments: { path: 'config.json', content: '{}' } },
              { id: 'read_config', name: 'read_file', arguments: { path: 'config.json' } }
            ] })
          : JSON.stringify({ final: 'conflicting calls completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const order: string[] = []
      vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockImplementation(async () => {
        order.push('write:start')
        await Promise.resolve()
        order.push('write:end')
        return 'written'
      })
      vi.spyOn(WorkspaceTools.prototype, 'readFile').mockImplementation(async () => {
        order.push('read:start')
        order.push('read:end')
        return '{}'
      })
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('写入并读取 config.json')

      expect(task.status).toBe('succeeded')
      expect(order).toEqual(['write:start', 'write:end', 'read:start', 'read:end'])
      expect(task.steps.some((item) => item.title === '已规划工具执行顺序' && item.detail.includes('资源存在读写冲突'))).toBe(true)
    })

    it('honors explicit depends_on even when the resources are otherwise independent', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { id: 'first_read', name: 'read_file', arguments: { path: 'a.ts' } },
              { id: 'second_read', depends_on: ['first_read'], name: 'read_file', arguments: { path: 'b.ts' } }
            ] })
          : JSON.stringify({ final: 'dependent reads completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      let active = 0
      let maximumActive = 0
      vi.spyOn(WorkspaceTools.prototype, 'readFile').mockImplementation(async () => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        return 'content'
      })
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('按依赖顺序读取文件')

      expect(task.status).toBe('succeeded')
      expect(maximumActive).toBe(1)
      expect(task.steps.some((item) => item.title === '已规划工具执行顺序' && item.detail.includes('显式前置依赖'))).toBe(true)
    })

    it('defers a tool call whose arguments still reference a previous result placeholder', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { id: 'decrypt_source', name: 'decrypt_file', arguments: { path: 'report.docx' } },
              { id: 'parse_result', depends_on: ['decrypt_source'], name: 'parse_word', arguments: { path: '${decrypt_source.output_path}' } }
            ] })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'read_file', arguments: { path: 'report.decrypted.docx' } } })
            : JSON.stringify({ final: 'deferred parse completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'decryptFile').mockResolvedValue('{"ok":true,"output_path":"report.decrypted.docx"}')
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('decrypted content')
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('解密并解析 report.docx')

      expect(task.status).toBe('succeeded')
      expect(task.steps.some((item) => item.title === '已规划工具执行顺序' && item.detail.includes('延后'))).toBe(true)
      expect(task.steps.some((item) => item.detail.includes('依赖前置工具的真实输出'))).toBe(true)
      expect(readFile).toHaveBeenCalledOnce()
      expect(readFile).toHaveBeenCalledWith('report.decrypted.docx')
    })

    it('does not execute a partial multi-tool batch when one call has invalid arguments', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { name: 'read_file', arguments: { path: 'safe.ts' } },
              { name: 'write_file', arguments: { path: 'missing-content.txt' } }
            ] })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'read_file', arguments: { path: 'safe.ts' } } })
            : JSON.stringify({ final: 'repaired batch completed' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('safe content')
      const writeFile = vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockResolvedValue('should not run')
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('检查 safe.ts，然后按结果处理')

      expect(task.status).toBe('succeeded')
      expect(readFile).toHaveBeenCalledOnce()
      expect(writeFile).not.toHaveBeenCalled()
      expect(task.steps.some((item) => item.title === '修复工具调用参数')).toBe(true)
    })

    it('stops a serialized batch after a failed call and reports later calls as skipped', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [
              { id: 'write_first', name: 'write_file', arguments: { path: 'first.txt', content: 'first' } },
              { id: 'write_second', depends_on: ['write_first'], name: 'write_file', arguments: { path: 'second.txt', content: 'second' } }
            ] })
          : JSON.stringify({ final: 'handled failed batch' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const writeFile = vi.spyOn(WorkspaceTools.prototype, 'writeFile')
        .mockRejectedValueOnce(Object.assign(new Error('no such file: parent directory missing'), { code: 'ENOENT' }))
        .mockResolvedValueOnce('must not run')
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('依次写入两个文件')

      expect(task.status).toBe('succeeded')
      expect(writeFile).toHaveBeenCalledOnce()
      expect(task.steps.some((item) => item.detail.includes('前置执行批次存在失败'))).toBe(true)
    })

    it('assembles multiple native streaming Qwen tool calls by index', async () => {
      const encoder = new TextEncoder()
      const ssePayload = (payload: unknown): Uint8Array => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n')
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++
        if (callCount > 1) {
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id?: string }> }> }
          const assistant = body.messages.find((message) => message.role === 'assistant' && message.tool_calls?.length)
          const toolMessages = body.messages.filter((message) => message.role === 'tool')
          expect(assistant?.tool_calls?.map((call) => call.id)).toEqual(['qwen_call_0', 'qwen_call_1'])
          expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['qwen_call_0', 'qwen_call_1'])
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'stream batch completed' }) } }] }) })
        }
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'text/event-stream' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(ssePayload({ choices: [{ delta: { tool_calls: [
                { id: 'qwen_call_0', index: 0, function: { name: 'read_file', arguments: '{"path":"a.' } },
                { id: 'qwen_call_1', index: 1, function: { name: 'read_file', arguments: '{"path":"b.' } }
              ] } }] }))
              controller.enqueue(ssePayload({ choices: [{ delta: { tool_calls: [
                { index: 0, function: { arguments: 'ts"}' } },
                { index: 1, function: { arguments: 'ts"}' } }
              ] } }] }))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            }
          })
        })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('content')
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('读取 a.ts 和 b.ts')

      expect(task.status).toBe('succeeded')
      expect(readFile).toHaveBeenCalledTimes(2)
      expect(readFile).toHaveBeenNthCalledWith(1, 'a.ts')
      expect(readFile).toHaveBeenNthCalledWith(2, 'b.ts')
    })

    it('falls back to a user Observation when native tool arguments are repaired locally', async () => {
      const requests: Array<{ messages: Array<{ role: string; tool_call_id?: string; tool_calls?: unknown[] }> }> = []
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        callCount++
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: {
            content: null,
            tool_calls: [{ id: 'call_defaulted', type: 'function', function: { name: 'list_files', arguments: '{}' } }]
          } }] }) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'default completed' }) } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('empty')
      const { agent } = makeAgent(makeSettings({ model: 'Qwen3.6-32B' }))

      const task = await agent.run('列举项目文件')

      expect(task.status).toBe('succeeded')
      expect(requests[1].messages.some((message) => message.role === 'tool')).toBe(false)
      expect(requests[1].messages.some((message) => message.role === 'user')).toBe(true)
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
      const approval = vi.fn(async () => true)
      vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('directory listed')
      const result = await execute('list files', task, approval)

      expect(result).toBe('done after observation')
      expect(callCount).toBe(2)
      expect(approval).toHaveBeenCalledOnce()
      expect(task.steps.some(s => s.title.includes('run_command'))).toBe(true)
      expect(task.result).toBeUndefined()
    })

    it('does not expose raw thought text when the model repeats a successful action', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount <= 2
          ? '<think>I should read the same file again.</think>' + JSON.stringify({ action: { name: 'list_files', arguments: { path: '.' } } })
          : JSON.stringify({ final: 'used the existing observation' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const listFiles = vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('inspect project files')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('used the existing observation')
      expect(task.result).not.toContain('<think>')
      expect(listFiles).toHaveBeenCalledOnce()
      expect(task.steps.some((item) => item.title === '整理已有结果')).toBe(true)
    })

    it('repairs a thought-only JSON after a repeated action and continues with the required command', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount <= 2
          ? JSON.stringify({ thought: '准备读取启动脚本。', action: { name: 'read_file', arguments: { path: 'scripts/start-electron-detached.cjs' } } })
          : callCount === 3
            ? JSON.stringify({ thought: '已读取启动脚本，现在按照用户指示执行该脚本。' })
            : callCount === 4
              ? JSON.stringify({ thought: '准备执行已读取的启动脚本。', action: { name: 'run_command', arguments: { command: 'node', args: ['scripts/start-electron-detached.cjs'] } } })
              : JSON.stringify({ final: '启动脚本已执行。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('console.log("started")')
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('CodeAgent Electron client started in background. PID: 1234')
      const approval = vi.fn(async () => true)
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '执行启动脚本', approval)

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('启动脚本已执行。')
      expect(task.result).not.toContain('"thought"')
      expect(readFile).toHaveBeenCalledOnce()
      expect(runCommand).toHaveBeenCalledWith('node', ['scripts/start-electron-detached.cjs'], undefined, true, false)
      expect(task.steps.some((item) => item.title === '模型输出格式不正确')).toBe(true)
      expect(callCount).toBe(5)
    })

    it('forces a user-facing result after repeated actions never produce a final', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = '<think>我会再次读取相同目录。</think>' + JSON.stringify({ action: { name: 'list_files', arguments: { path: '.' } } })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const listFiles = vi.spyOn(WorkspaceTools.prototype, 'listFiles').mockResolvedValue('目录为空')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('inspect project files')

      expect(task.status).toBe('succeeded')
      expect(task.result).toContain('已基于已获得的工具结果整理当前结果')
      expect(task.result).not.toContain('<think>')
      expect(listFiles).toHaveBeenCalledOnce()
      expect(callCount).toBe(5)
      expect(task.steps.some((item) => item.title === '整理已有结果')).toBe(true)
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

    it('retries an incomplete write_file action instead of displaying raw JSON as final', async () => {
      let callCount = 0
      const requestBodies: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requestBodies.push(String(init?.body ?? ''))
        callCount++
        const content = callCount === 1
          ? '{"action":{"name":"write_file","arguments":{"path":"tests/fixtures/generated-after-truncation.txt","content":"const page = `<html>`;\\'
          : callCount === 2
            ? JSON.stringify({ action: { name: 'write_file', arguments: { path: 'tests/fixtures/generated-after-truncation.txt', content: 'complete' } } })
            : JSON.stringify({ final: 'file written after retry' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const writeFile = vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockResolvedValue('已写入 tests/fixtures/generated-after-truncation.txt')
      const result = await execute('write a large page', task)

      expect(result).toBe('file written after retry')
      expect(callCount).toBe(3)
      expect(task.steps.some((item) => item.title === '工具调用响应不完整')).toBe(true)
      expect(requestBodies[1]).toContain('单次 content 不得超过 6000 个字符')
      expect(requestBodies[1]).not.toContain('const page = `<html>`')
      expect(requestBodies[1]).not.toContain('[上一条工具调用')
      expect(writeFile).toHaveBeenCalledWith('tests/fixtures/generated-after-truncation.txt', 'complete')
    })

    it('rejects an echoed internal recovery marker and continues from existing observations', async () => {
      let callCount = 0
      const requestBodies: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requestBodies.push(String(init?.body ?? ''))
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'read_file', arguments: { path: 'package.json' } } })
          : callCount === 2
            ? '[上一条工具调用在 Action JSON 闭合前被截断，未执行。]'
            : JSON.stringify({ final: '已根据现有工具结果完成检查。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('{"name":"codext-agent"}')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('读取 package.json 并总结')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('已根据现有工具结果完成检查。')
      expect(task.result).not.toContain('上一条工具调用')
      expect(task.steps.some((item) => item.title === '模型响应无效，正在恢复')).toBe(true)
      expect(requestBodies[2]).not.toContain('[上一条工具调用')
      expect(requestBodies[2]).toContain('INTERNAL_PLACEHOLDER_ECHO')
      expect(callCount).toBe(3)
    })

    it('recovers a model connection failure after a successful file write', async () => {
      let callCount = 0
      const requestBodies: string[] = []
      const largeContent = 'x'.repeat(5000)
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requestBodies.push(String(init?.body ?? ''))
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ action: { name: 'write_file', arguments: { path: 'generated-page.html', content: largeContent } } }) } }] })
          })
        }
        if (callCount === 2) return Promise.reject(new TypeError('fetch failed'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'continued after reconnecting' }) } }] }) })
      })
      const writeFile = vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockResolvedValue('已写入 generated-page.html')
      const { execute } = makeAgent(makeSettings({ maxRetries: 0 }))
      const task = makeTask()

      const result = await execute('create a page', task)

      expect(result).toBe('continued after reconnecting')
      expect(callCount).toBe(3)
      expect(writeFile).toHaveBeenCalledOnce()
      expect(task.steps.some((item) => item.title === '模型连接中断，正在恢复')).toBe(true)
      expect(requestBodies[1]).toContain('generated-page.html')
      expect(requestBodies[1]).toContain(largeContent)
    })

    it('accepts thought tags before JSON without exposing the tagged reasoning', async () => {
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
      expect(stepSnapshots).toContain('准备执行所需工具。')
      expect(stepSnapshots.some((item) => item.includes('需要查看项目配置'))).toBe(false)
      expect(task.steps.some(s => s.title.includes('read_file'))).toBe(true)
    })

    it('assembles native streaming tool-call argument fragments before execution', async () => {
      const encoder = new TextEncoder()
      const ssePayload = (payload: unknown): Uint8Array => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n')
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'stream tool done' }) } }] })
          })
        }
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'text/event-stream' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(ssePayload({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":"pack' } }] } }] }))
              controller.enqueue(ssePayload({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'age.json"}' } }] } }] }))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            }
          })
        })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('{"name":"codext-agent"}')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('读取 package.json')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('stream tool done')
      expect(readFile).toHaveBeenCalledWith('package.json')
      expect(task.steps.some((item) => item.title === '修复工具调用参数')).toBe(false)
      expect(callCount).toBe(2)
    })

    it('classifies an interrupted native tool-call stream and repairs it with a focused request', async () => {
      const encoder = new TextEncoder()
      const ssePayload = (payload: unknown): Uint8Array => encoder.encode('data: ' + JSON.stringify(payload) + '\n\n')
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'text/event-stream' },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(ssePayload({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":' } }] } }] }))
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                controller.close()
              }
            })
          })
        }
        const content = callCount === 2
          ? JSON.stringify({ action: { name: 'read_file', arguments: { path: 'package.json' } } })
          : JSON.stringify({ final: 'repaired stream tool' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('{}')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('读取 package.json')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('repaired stream tool')
      expect(readFile).toHaveBeenCalledWith('package.json')
      expect(task.steps.some((item) => item.title === '修复工具调用参数' && item.detail.includes('STREAM_ASSEMBLY_ERROR'))).toBe(true)
      expect(callCount).toBe(3)
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
      const approval = vi.fn(async () => true)
      vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('directory listed')
      const result = await (agent as unknown as { execute: (p: string, pol: AgentPolicy, t: AgentTask, history?: [], onStep?: undefined, onDelta?: (delta: string) => void, attachments?: [], requestMcpApproval?: undefined, signal?: undefined, requestUserChoice?: undefined, requestCommandApproval?: (details: CommandApprovalDetails) => Promise<boolean>) => Promise<string> })
        .execute('list files', basePolicy, task, [], undefined, (delta) => { streamed += delta }, [], undefined, undefined, undefined, approval)

      expect(result).toBe('real final')
      expect(streamed).toBe('real final')
      expect(callCount).toBe(2)
      expect(approval).toHaveBeenCalledOnce()
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

    it('requires a successful validation command before completing after a command failure', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: 'npm', args: ['install'] } } })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'write_file', arguments: { path: 'package.json', content: '{}' } } })
            : callCount === 3
              ? JSON.stringify({ final: '构建定位尚未完成。' })
              : callCount === 4
                ? JSON.stringify({ action: { name: 'run-command', arguments: { command: 'npm', args: ['run', 'build'] } } })
                : JSON.stringify({ final: '构建修复并验证完成。' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand')
        .mockRejectedValueOnce(new Error('npm warn EBADENGINE'))
        .mockResolvedValueOnce('build succeeded')
      vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockResolvedValue('已写入 package.json')
      const { agent } = makeAgent(makeSettings())

      const task = await runWithCommandApproval(agent, '安装依赖', async () => true)

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('构建修复并验证完成。')
      expect(callCount).toBe(5)
      expect(runCommand).toHaveBeenCalledTimes(2)
      expect(task.steps.some((item) => item.detail.includes('EBADENGINE'))).toBe(true)
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

    it('retries transient fetch failures', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return Promise.reject(new TypeError('fetch failed'))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'network recovered' }) } }] })
        })
      })

      const { execute } = makeAgent(makeSettings({ maxRetries: 1 }))
      const task = makeTask()
      const result = await execute('retry fetch', task)

      expect(result).toBe('network recovered')
      expect(callCount).toBe(2)
      expect(task.steps.some((item) => item.title === '模型响应中断，正在重试')).toBe(true)
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

    it('continues after a tool Observation when the next model response is empty', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? JSON.stringify({ action: { name: 'run_command', arguments: { command: '/usr/bin/git --version', args: [] } } })
          : callCount === 2
            ? JSON.stringify({ choices: [] })
            : JSON.stringify({ final: '已继续完成检查。' })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(callCount === 2 ? { choices: [{ message: { content: '' } }] } : { choices: [{ message: { content } }] })
        })
      })
      vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('git version 2.40.0')

      const { execute } = makeAgent(makeSettings())
      const task = makeTask('检查 git 版本')
      const result = await execute('检查 git 版本', task)

      expect(result).toBe('已继续完成检查。')
      expect(callCount).toBe(3)
      expect(task.steps.some((item) => item.title === '模型响应为空，正在恢复')).toBe(true)
    })

    it('throws on AbortError with timeout message', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      globalThis.fetch = vi.fn().mockRejectedValue(abortError)

      const s = makeSettings({ timeoutMs: 3000, maxRetries: 0 })
      const { execute } = makeAgent(s)
      await expect(execute('test', makeTask())).rejects.toThrow('模型请求超时（3秒）')
    })

    it('fails quickly when the model does not return response headers', async () => {
      globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      const settings = makeSettings({ timeoutMs: 5000, maxRetries: 0 })
      const agent = new ReactAgent(() => settings, () => basePolicy, () => '', 100, 20)

      const task = await agent.run('hello')

      expect(task.status).toBe('failed')
      expect(task.error).toContain('模型连接超时')
      expect(task.steps.some((item) => item.title.includes('ReAct 第'))).toBe(false)
    })

    it('fails when an SSE stream stops producing model data', async () => {
      const encoder = new TextEncoder()
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/event-stream' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"thought":"working' } }] }) + '\n\n'))
          }
        })
      })
      const settings = makeSettings({ timeoutMs: 5000, maxRetries: 0 })
      const agent = new ReactAgent(() => settings, () => basePolicy, () => '', 100, 20)

      const task = await agent.run('hello')

      expect(task.status).toBe('failed')
      expect(task.error).toContain('没有新数据')
    })

    it('stops an unstructured reasoning stream before the total timeout', async () => {
      const encoder = new TextEncoder()
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'text/event-stream' },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'I am still analyzing. ' + 'x'.repeat(65_000) } }] }) + '\n\n'))
              }
            })
          })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'protocol recovered' }) } }] }) })
      })
      const settings = makeSettings({ timeoutMs: 5000, maxRetries: 0 })
      const agent = new ReactAgent(() => settings, () => basePolicy, () => '', 100, 20)

      const task = await agent.run('hello')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('protocol recovered')
      expect(callCount).toBe(2)
      expect(task.steps.some((item) => item.title === '模型输出格式不正确')).toBe(true)
      expect(JSON.stringify(task)).not.toContain('REACT_PROTOCOL_DRIFT')
    })

    it('falls back to a non-streaming request after an SSE stall', async () => {
      const requestBodies: Array<{ stream?: boolean }> = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean })
        if (requestBodies.length === 1) {
          return Promise.resolve({
            ok: true,
            headers: { get: () => 'text/event-stream' },
            body: new ReadableStream<Uint8Array>({ start() {} })
          })
        }
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ final: 'fallback succeeded' }) } }] })
        })
      })
      const settings = makeSettings({ timeoutMs: 5000, maxRetries: 1 })
      const agent = new ReactAgent(() => settings, () => basePolicy, () => '', 100, 20)

      const task = await agent.run('hello')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('fallback succeeded')
      expect(requestBodies.map((body) => body.stream)).toEqual([true, false])
      expect(task.steps.some((item) => item.title === '流式响应停顿，改用非流式重试')).toBe(true)
    })

    it('repairs missing tool arguments with a focused context before execution', async () => {
      let callCount = 0
      const requestBodies: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++
        requestBodies.push(String(init?.body ?? ''))
        const content = callCount === 1
          ? JSON.stringify({ tool_calls: [{ name: 'write_file', arguments: { path: 'test.txt' } }] })
          : callCount === 2
            ? JSON.stringify({ action: { name: 'write_file', arguments: { path: 'test.txt', content: 'fixed' } } })
            : JSON.stringify({ final: 'done' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const writeFile = vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockResolvedValue('已写入 test.txt')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('更新 test.txt', [{ role: 'user', content: 'UNRELATED_HISTORY_MARKER' }])

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('done')
      expect(writeFile).toHaveBeenCalledOnce()
      expect(callCount).toBe(3)
      expect(requestBodies[1]).toContain('TOOL_ARGUMENT_ERROR')
      const repairMessages = (JSON.parse(requestBodies[1]) as { messages: Array<{ content: unknown }> }).messages
        .map((message) => typeof message.content === 'string' ? message.content : '')
        .join('\n')
      expect(repairMessages).toContain('"missing": [\n    "content"')
      expect(requestBodies[1]).not.toContain('UNRELATED_HISTORY_MARKER')
      expect(task.steps.some((item) => item.title === '修复工具调用参数')).toBe(true)
      expect(task.steps.some((item) => item.title === '正在执行工具：write_file')).toBe(true)
    })

    it('repairs invalid arguments from a standard Thought Action response', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1
          ? 'Thought: inspect config\nAction: read_file\nAction Input: {"file_path":123}'
          : callCount === 2
            ? JSON.stringify({ action: { name: 'read_file', arguments: { path: 'package.json' } } })
            : JSON.stringify({ final: 'text action repaired' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('{}')
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('读取 package.json')

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('text action repaired')
      expect(readFile).toHaveBeenCalledWith('package.json')
      expect(task.steps.some((item) => item.title === '修复工具调用参数' && item.detail.includes('ARGUMENT_TYPE_ERROR'))).toBe(true)
    })

    it('stops when the model repeats the same incomplete tool arguments', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = JSON.stringify({ action: { name: 'write_file', arguments: { path: 'test.txt' } } })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const { execute } = makeAgent(makeSettings())

      await expect(execute('更新 test.txt', makeTask())).rejects.toThrow('[ARGUMENT_MISSING]')
      expect(callCount).toBe(2)
    })

    it('asks the user to resolve an ambiguous path after a repeated repair failure', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount <= 2
          ? JSON.stringify({ action: { name: 'read_file', arguments: {} } })
          : JSON.stringify({ final: 'compared' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })
      const readFile = vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('{}')
      const choices: string[][] = []
      const { agent } = makeAgent(makeSettings())

      const task = await agent.run('比较 package.json 和 tsconfig.json', [], undefined, undefined, [], undefined, undefined, undefined, async (request) => {
        choices.push(request.options.map((option) => option.label))
        return request.options.find((option) => option.label === 'tsconfig.json')?.id
      })

      expect(task.status).toBe('succeeded')
      expect(task.result).toBe('compared')
      expect(choices).toEqual([['package.json', 'tsconfig.json', '暂不执行']])
      expect(readFile).toHaveBeenCalledWith('tsconfig.json')
      expect(task.steps.some((item) => item.title === '用户已补充工具参数')).toBe(true)
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
    it('executes multiple tool calls in a single response up to the bounded batch limit', async () => {
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
      expect(observationSteps).toHaveLength(2)
      expect(callCount).toBe(2)
    })

    it('repairs an empty tool_calls response instead of accepting it as final', async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++
        const content = callCount === 1 ? JSON.stringify({ tool_calls: [] }) : JSON.stringify({ final: 'recovered' })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content } }] }) })
      })

      const { execute } = makeAgent(makeSettings())
      const task = makeTask()
      const result = await execute('test', task)
      expect(result).toBe('recovered')
      expect(callCount).toBe(2)
      expect(task.steps.some((item) => item.title === '模型输出格式不正确')).toBe(true)
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
      vi.spyOn(WorkspaceTools.prototype, 'readFile').mockResolvedValue('x'.repeat(1_000))

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
