import type { AgentPolicy, AgentTask, AppSettings, TaskStep } from '../../shared/types'
import { WorkspaceTools } from '../tools/workspace-tools'
import { getEnabledToolDefinitions, isToolName, type ToolCall } from '../tools/tool-registry'

const MAX_REACT_TURNS = 20
const MAX_ACTIONS_PER_TURN = 1

const step = (phase: TaskStep['phase'], title: string, detail: string): TaskStep => ({
  id: crypto.randomUUID(),
  phase,
  title,
  detail,
  timestamp: new Date().toISOString()
})

const THOUGHT_TAG_PATTERN = /<\s*\/?\s*(think|thought)\s*>/gi
const THOUGHT_BLOCK_PATTERN = /<\s*(think|thought)\s*>[\s\S]*?<\s*\/\s*(?:think|thought)\s*>/gi
const UNCLOSED_THOUGHT_PATTERN = /<\s*(think|thought)\s*>[\s\S]*$/i
const PARTIAL_THOUGHT_TAGS = ['<think>', '<thought>', '</think>', '</thought>']

type ReactModelReply = {
  thought?: string
  action?: ToolCall
  tool_calls?: ToolCall[]
  final?: string
}
type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type ConversationMessage = { role: 'user' | 'assistant'; content: string }
type StepCallback = (step: TaskStep) => void
type DeltaCallback = (delta: string) => void

export class ReactAgent {
  constructor(private readonly getSettings: () => AppSettings, private readonly getPolicy: () => AgentPolicy) {}

  async run(prompt: string, history: ConversationMessage[] = [], onStep?: StepCallback, onDelta?: DeltaCallback): Promise<AgentTask> {
    const task: AgentTask = { id: crypto.randomUUID(), prompt, status: 'reasoning', createdAt: new Date().toISOString(), steps: [] }
    const policy = this.getPolicy()

    task.status = 'acting'

    try {
      task.result = await this.execute(prompt, policy, task, history, onStep, onDelta)
      task.status = 'validating'
      task.status = 'succeeded'
    } catch (error) {
      task.error = error instanceof Error ? error.message : '未知执行错误'
      task.status = 'failed'
    }

    return task
  }

  private async execute(prompt: string, policy: AgentPolicy, task: AgentTask, history: ConversationMessage[] = [], onStep?: StepCallback, onDelta?: DeltaCallback): Promise<string> {
    const settings = this.getSettings()
    if (!settings.model.baseUrl || !settings.model.model) {
      this.addStep(task, step('reason', '演示模式', '模型接口未完整配置，本次不会调用远程模型。'), onStep)
      return this.demoResponse(prompt, policy)
    }

    const tools = new WorkspaceTools(policy.workspacePath)
    const messages: ModelMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(policy) },
      ...history.filter((message) => message.content.trim()).slice(-12),
      { role: 'user', content: prompt }
    ]
    let previousActionSignature = ''

    for (let turn = 1; turn <= MAX_REACT_TURNS; turn++) {
      const thoughtStep = step('reason', '思考过程', '')
      const stream = new ReactFieldStream(
        (delta) => {
          thoughtStep.detail += delta
          this.upsertStep(task, thoughtStep, onStep)
        },
        onDelta
      )
      const content = await this.callModel(messages, (delta) => stream.push(delta))
      messages.push({ role: 'assistant', content })

      const reply = this.parseReply(content)
      if (reply.thought) {
        thoughtStep.detail = reply.thought
        this.upsertStep(task, thoughtStep, onStep)
      }
      if (reply.final) {
        stream.flushFinal(reply.final)
        return reply.final
      }

      const toolCalls = this.getToolCalls(reply)
      if (!toolCalls.length) return content
      const actionSignature = JSON.stringify(toolCalls)
      if (actionSignature === previousActionSignature) return content
      previousActionSignature = actionSignature

      const observations: string[] = []
      for (const call of toolCalls.slice(0, MAX_ACTIONS_PER_TURN)) {
        this.addStep(task, step('act', '正在执行工具：' + call.name, this.toolDetail(call)), onStep)
        const output = await this.executeTool(call, tools, policy)
        const observation = call.name + ': ' + output
        observations.push(observation)
        this.addStep(task, step('act', 'Observation #' + turn + '：' + call.name, output.slice(0, 800)), onStep)
      }

      const observationText = 'Observation #' + turn + ':\n' + observations.join('\n\n')
      messages.push({ role: 'user', content: observationText })
    }

    throw new Error('ReAct 循环达到最大轮数，仍未得到 Final。')
  }

  private buildSystemPrompt(policy: AgentPolicy): string {
    const toolSchema = [
      '{',
      '  "action": { "name": "read_file|write_file|run_command", "arguments": { ... } }',
      '}'
    ].join('\n')

    const finalSchema = [
      '{',
      '  "final": "给用户的最终答复"',
      '}'
    ].join('\n')

    return [
      policy.systemPrompt,
      '',
      '你必须遵循 ReAct 循环：Thought -> Action -> Observation -> Thought -> ... -> Final。',
      '每一轮先输出一段可展示的简短思考过程，必须包裹在 <think>...</think> 或 <thought>...</thought> 标签中；标签内容会被实时流式展示给用户。',
      '思考标签结束后，只能输出一个 JSON 对象，不要输出 Markdown，不要包裹代码块，不要把 JSON 放进思考标签里。',
      '如果本轮输出 Action JSON，就必须立刻停止输出，等待工具 Observation；同一轮绝不能再输出 Final 或第二个 JSON 对象。',
      '当需要读取文件、写入文件或执行命令时，输出 Action JSON：',
      toolSchema,
      '当任务完成或不需要工具时，输出 Final JSON：',
      finalSchema,
      '工具注册表（只能调用 enabled=true 的工具；严格按 inputSchema 传 arguments）：',
      JSON.stringify(getEnabledToolDefinitions(policy.enabledTools), null, 2),
      '工作区根目录：' + policy.workspacePath,
      '所有文件路径必须是工作区内的相对路径。run_command 的 command 必须是可执行文件名，参数放入 args 数组。',
      '每轮最多请求 ' + MAX_ACTIONS_PER_TURN + ' 个工具调用；复杂任务应分多轮进行。'
    ].join('\n')
  }

  private async executeTool(call: ToolCall, tools: WorkspaceTools, policy: AgentPolicy): Promise<string> {
    if (!policy.enabledTools.includes(call.name)) throw new Error('工具未启用：' + call.name)
    if (call.name === 'read_file' && call.arguments.path) return tools.readFile(call.arguments.path)
    if (call.name === 'write_file' && call.arguments.path && typeof call.arguments.content === 'string') return tools.writeFile(call.arguments.path, call.arguments.content)
    if (call.name === 'run_command' && call.arguments.command) return tools.runCommand(call.arguments.command, call.arguments.args ?? [])
    throw new Error('工具参数不完整：' + call.name)
  }

  private async callModel(messages: ModelMessage[], onDelta?: DeltaCallback): Promise<string> {
    const { model } = this.getSettings()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), model.timeoutMs)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
      if (model.apiKey.trim()) headers.Authorization = 'Bearer ' + model.apiKey

      const response = await fetch(model.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({ model: model.model, messages, temperature: 0, max_tokens: 16384, stream: true })
      })

      if (!response.ok) {
        let errorDetail = ''
        try {
          const errorBody = await response.json() as { error?: { message?: string } }
          errorDetail = errorBody.error?.message ?? ''
        } catch {
          /* 响应体无法解析为 JSON */
        }
        throw new Error('模型请求失败：' + response.status + (errorDetail ? ' - ' + errorDetail : ''))
      }

      const contentType = response.headers?.get('content-type') ?? ''
      const content = contentType.includes('text/event-stream') ? await this.readStreamResponse(response, onDelta) : await this.readJsonResponse(response)
      if (!content) throw new Error('模型返回为空')
      return content
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('模型请求超时（' + model.timeoutMs / 1000 + '秒）')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async readJsonResponse(response: Response): Promise<string> {
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string }, delta?: { content?: string } }> }
    return payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.delta?.content ?? ''
  }

  private async readStreamResponse(response: Response, onDelta?: DeltaCallback): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return this.readJsonResponse(response)

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const processLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') return

      const delta = this.parseStreamDelta(data)
      if (!delta) return
      content += delta
      onDelta?.(delta)
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        processLine(line)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) processLine(buffer)
    return content
  }

  private parseStreamDelta(data: string): string {
    try {
      const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }, message?: { content?: string } }> }
      return payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? ''
    } catch {
      return ''
    }
  }

  private parseReply(content: string): ReactModelReply {
    const thought = extractThoughtTags(content).trim()
    const payload = stripThoughtTags(content).trim()

    try {
      return this.attachThought(JSON.parse(payload) as ReactModelReply, thought)
    } catch {
      const objects = this.parseJsonObjects(payload)
      const actionReply = objects.find((item) => this.getToolCalls(item).length > 0)
      if (actionReply) return this.attachThought(actionReply, thought)
      const recoveredAction = this.recoverAction(payload)
      if (recoveredAction) return { thought: thought || undefined, action: recoveredAction }
      const finalReply = objects.find((item) => typeof item.final === 'string')
      if (finalReply) return this.attachThought(finalReply, thought)
      return { thought: thought || undefined, final: payload || content }
    }
  }

  private attachThought(reply: ReactModelReply, thought: string): ReactModelReply {
    if (!thought || reply.thought) return reply
    return { ...reply, thought }
  }

  private parseJsonObjects(content: string): ReactModelReply[] {
    const objects: ReactModelReply[] = []
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = 0; index < content.length; index++) {
      const char = content[index]

      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }

      if (char === '"') {
        inString = true
        continue
      }

      if (char === '{') {
        if (depth === 0) start = index
        depth++
        continue
      }

      if (char !== '}') continue
      depth--
      if (depth !== 0 || start < 0) continue

      try {
        objects.push(JSON.parse(content.slice(start, index + 1)) as ReactModelReply)
      } catch {
        /* 忽略无法解析的片段，继续寻找下一个 JSON 对象 */
      }
      start = -1
    }

    return objects
  }

  private recoverAction(content: string): ToolCall | undefined {
    const actionKey = content.indexOf('"action"')
    if (actionKey < 0) return undefined
    const objectStart = content.indexOf('{', actionKey)
    if (objectStart < 0) return undefined
    const actionObject = this.extractBalancedObject(content, objectStart)
    if (!actionObject) return undefined
    try {
      const candidate = JSON.parse(this.normalizeJsonControlCharacters(actionObject)) as Partial<ToolCall>
      if (typeof candidate.name !== 'string' || !isToolName(candidate.name)) return undefined
      if (!candidate.arguments || typeof candidate.arguments !== 'object') return undefined
      return candidate as ToolCall
    } catch {
      return undefined
    }
  }

  private normalizeJsonControlCharacters(content: string): string {
    let result = ''
    let inString = false
    let escaped = false
    for (const char of content) {
      if (inString) {
        if (escaped) {
          result += char
          escaped = false
        } else if (char === String.fromCharCode(92)) {
          result += char
          escaped = true
        } else if (char === '"') {
          result += char
          inString = false
        } else if (char === '\n') result += '\\n'
        else if (char === '\r') result += '\\r'
        else if (char === '\t') result += '\\t'
        else result += char
      } else {
        result += char
        if (char === '"') inString = true
      }
    }
    return result
  }

  private extractBalancedObject(content: string, start: number): string | undefined {
    let depth = 0
    let inString = false
    let escaped = false
    const backslash = String.fromCharCode(92)
    for (let index = start; index < content.length; index++) {
      const char = content[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === backslash) escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{') depth++
      else if (char === '}') depth--
      if (depth === 0) return content.slice(start, index + 1)
    }
    return undefined
  }

  private getToolCalls(reply: ReactModelReply): ToolCall[] {
    const calls = reply.action ? [reply.action] : reply.tool_calls ?? []
    return calls.filter((item): item is ToolCall => isToolName(item.name))
  }

  private addStep(task: AgentTask, taskStep: TaskStep, onStep?: StepCallback): void {
    task.steps.push(taskStep)
    onStep?.(taskStep)
  }

  private upsertStep(task: AgentTask, taskStep: TaskStep, onStep?: StepCallback): void {
    const index = task.steps.findIndex((item) => item.id === taskStep.id)
    if (index < 0) task.steps.push(taskStep)
    else task.steps[index] = taskStep
    onStep?.(taskStep)
  }

  private toolDetail(call: ToolCall): string {
    const detail = JSON.stringify(call.arguments)
    return detail.length > 180 ? detail.slice(0, 177) + '...' : detail
  }

  private demoResponse(prompt: string, policy: AgentPolicy): string {
    return [
      '演示模式：模型服务尚未配置。',
      '系统提示词已加载，ReAct 循环会在模型配置完成后启用。',
      '允许工具：' + policy.enabledTools.join('、') + '。',
      '工作区：' + policy.workspacePath,
      '你的任务是：' + prompt
    ].join(' / ')
  }
}

function extractThoughtTags(content: string): string {
  let result = ''
  let activeStart = -1
  const matcher = new RegExp(THOUGHT_TAG_PATTERN.source, THOUGHT_TAG_PATTERN.flags)

  for (let match = matcher.exec(content); match; match = matcher.exec(content)) {
    const isClosingTag = /^<\s*\//.test(match[0])
    if (activeStart < 0) {
      if (!isClosingTag) activeStart = matcher.lastIndex
      continue
    }

    if (isClosingTag) {
      result += content.slice(activeStart, match.index)
      activeStart = -1
    }
  }

  if (activeStart >= 0) {
    result += trimTrailingPartialThoughtTag(content.slice(activeStart))
  }

  return result
}

function stripThoughtTags(content: string): string {
  return content
    .replace(THOUGHT_BLOCK_PATTERN, '')
    .replace(UNCLOSED_THOUGHT_PATTERN, '')
}

function trimTrailingPartialThoughtTag(content: string): string {
  const lastOpen = content.lastIndexOf('<')
  if (lastOpen < 0) return content

  const suffix = content.slice(lastOpen).toLowerCase().replace(/\s+/g, '')
  if (!suffix || PARTIAL_THOUGHT_TAGS.some((tag) => tag.startsWith(suffix))) {
    return content.slice(0, lastOpen)
  }

  return content
}

class ReactFieldStream {
  private buffer = ''
  private emittedThought = ''
  private emittedFinal = ''

  constructor(private readonly onThoughtDelta?: DeltaCallback, private readonly onFinalDelta?: DeltaCallback) {}

  push(delta: string): void {
    this.buffer += delta
    this.emitThought()
    this.emitFinal()
  }

  flushFinal(finalText: string): void {
    if (!this.onFinalDelta) return
    if (finalText.length > this.emittedFinal.length) {
      this.onFinalDelta(finalText.slice(this.emittedFinal.length))
    }
    this.emittedFinal = finalText
  }

  private emitThought(): void {
    if (!this.onThoughtDelta) return
    const taggedThought = extractThoughtTags(this.buffer)
    const thoughtText = taggedThought || this.extractStringField('thought')
    if (thoughtText.length <= this.emittedThought.length) return

    this.onThoughtDelta(thoughtText.slice(this.emittedThought.length))
    this.emittedThought = thoughtText
  }

  private emitFinal(): void {
    if (!this.onFinalDelta) return
    const finalText = this.extractFinalText()
    if (finalText.length <= this.emittedFinal.length) return

    this.onFinalDelta(finalText.slice(this.emittedFinal.length))
    this.emittedFinal = finalText
  }

  private extractFinalText(): string {
    const payload = stripThoughtTags(this.buffer)
    const finalIndex = payload.indexOf('"final"')
    if (finalIndex < 0) return ''
    const actionIndex = payload.search(/"(action|tool_calls)"\s*:/)
    if (actionIndex >= 0 && actionIndex < finalIndex) return ''
    return this.extractStringField('final', payload)
  }

  private extractStringField(fieldName: string, source = this.buffer): string {
    const keyIndex = source.indexOf('"' + fieldName + '"')
    if (keyIndex < 0) return ''

    const colonIndex = source.indexOf(':', keyIndex)
    if (colonIndex < 0) return ''

    let quoteIndex = -1
    for (let index = colonIndex + 1; index < source.length; index++) {
      const current = source[index]
      if (/\s/.test(current)) continue
      if (current !== '"') return ''
      quoteIndex = index
      break
    }
    if (quoteIndex < 0) return ''

    let value = ''
    for (let index = quoteIndex + 1; index < source.length; index++) {
      const current = source[index]
      if (current === '"') return value
      if (current !== '\\') {
        value += current
        continue
      }

      if (index + 1 >= source.length) return value
      const escaped = source[++index]
      if (escaped === 'n') value += '\n'
      else if (escaped === 'r') value += '\r'
      else if (escaped === 't') value += '\t'
      else if (escaped === 'b') value += '\b'
      else if (escaped === 'f') value += '\f'
      else if (escaped === 'u') {
        const hex = source.slice(index + 1, index + 5)
        if (hex.length < 4 || !/^[\da-f]{4}$/i.test(hex)) return value
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 4
      } else {
        value += escaped
      }
    }

    return value
  }
}
