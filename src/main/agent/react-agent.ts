import type { AgentPolicy, AgentTask, AppSettings, ChatAttachment, McpApprovalDetails, TaskStep, UserChoiceDetails } from '../../shared/types'
import { isDecryptableAttachmentName, isImageAttachmentType, isOfficeAttachmentType, isTextAttachmentType, MAX_TEXT_ATTACHMENT_CHARACTERS, officeAttachmentTool, type OfficeAttachmentTool } from '../../shared/attachments'
import { WorkspaceTools } from '../tools/workspace-tools'
import { getEnabledToolDefinitions, isToolName, type ToolCall } from '../tools/tool-registry'
import { parseOfficeDocument, type OfficeDocumentKind } from '../tools/office-parser'
import { PptMcpClient } from '../ppt/ppt-mcp-client'

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
  choice?: UserChoiceDetails
  final?: string
}
type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }
type ModelContent = string | ModelContentPart[]
type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: ModelContent }
type ConversationMessage = { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }
type StepCallback = (step: TaskStep) => void
type DeltaCallback = (delta: string) => void
type McpApprovalCallback = (request: McpApprovalDetails) => Promise<boolean>
type UserChoiceCallback = (request: UserChoiceDetails) => Promise<string | undefined>

export class ReactAgent {
  constructor(private readonly getSettings: () => AppSettings, private readonly getPolicy: () => AgentPolicy, private readonly getPptMcpUrl: () => string = () => '') {}

  async run(prompt: string, history: ConversationMessage[] = [], onStep?: StepCallback, onDelta?: DeltaCallback, attachments: ChatAttachment[] = [], requestMcpApproval?: McpApprovalCallback, signal?: AbortSignal, workspacePath?: string, requestUserChoice?: UserChoiceCallback): Promise<AgentTask> {
    const task: AgentTask = { id: crypto.randomUUID(), prompt, status: 'reasoning', createdAt: new Date().toISOString(), steps: [] }
    const configuredPolicy = this.getPolicy()
    const policy = workspacePath?.trim() ? { ...configuredPolicy, workspacePath: workspacePath.trim() } : configuredPolicy

    task.status = 'acting'

    try {
      task.result = await this.execute(prompt, policy, task, history, onStep, onDelta, attachments, requestMcpApproval, signal, requestUserChoice)
      task.status = 'validating'
      task.status = 'succeeded'
    } catch (error) {
      task.error = signal?.aborted ? '任务已暂停' : error instanceof Error ? error.message : '未知执行错误'
      task.status = signal?.aborted ? 'paused' : 'failed'
    }

    return task
  }

  private async execute(prompt: string, policy: AgentPolicy, task: AgentTask, history: ConversationMessage[] = [], onStep?: StepCallback, onDelta?: DeltaCallback, attachments: ChatAttachment[] = [], requestMcpApproval?: McpApprovalCallback, signal?: AbortSignal, requestUserChoice?: UserChoiceCallback): Promise<string> {
    throwIfAborted(signal)
    const settings = this.getSettings()
    if (!settings.model.baseUrl || !settings.model.model) {
      this.addStep(task, step('reason', '演示模式', '模型接口未完整配置，本次不会调用远程模型。'), onStep)
      return this.demoResponse(prompt, policy)
    }

    const tools = new WorkspaceTools(policy.workspacePath)
    const allAttachments = [...attachments, ...history.flatMap((message) => message.attachments ?? [])]
    const pendingDecryptPaths = new Set(allAttachments
      .filter((attachment) => attachment.workspacePath && isDecryptableAttachmentName(attachment.name) && looksLikeEncryptedTextAttachment(attachment))
      .map((attachment) => attachment.workspacePath as string))
    const pendingOfficeParses = new Map<string, OfficeAttachmentTool>()
    for (const attachment of allAttachments) {
      const toolName = officeAttachmentTool(attachment.name)
      if (attachment.workspacePath && toolName && policy.enabledTools.includes(toolName)) pendingOfficeParses.set(attachment.workspacePath, toolName)
    }
    const messages: ModelMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(policy) },
      ...history
        .filter((message) => message.content.trim() || message.attachments?.length)
        .slice(-12)
        .map((message): ModelMessage => ({
          role: message.role,
          content: message.role === 'user' ? this.buildUserContent(message.content, message.attachments) : message.content
        })),
      { role: 'user', content: this.buildUserContent(prompt, attachments) }
    ]
    let previousActionSignature = ''
    let previousActionHadError = false
    const deniedMcpPaths = new Set<string>()

    for (let turn = 1; turn <= MAX_REACT_TURNS; turn++) {
      throwIfAborted(signal)
      const thoughtStep = step('reason', '思考过程', '')
      const stream = new ReactFieldStream(
        (delta) => {
          thoughtStep.detail += delta
          this.upsertStep(task, thoughtStep, onStep)
        }
      )
      const content = await this.callModel(messages, (delta) => stream.push(delta), signal)
      messages.push({ role: 'assistant', content })

      const reply = this.parseReply(content)
      let toolCalls = this.getToolCalls(reply)
      const implicitOfficeCall = !toolCalls.length && !pendingDecryptPaths.size
        ? inferOfficeToolCall(prompt, reply, pendingOfficeParses)
        : undefined
      if (implicitOfficeCall) toolCalls = [implicitOfficeCall]
      const choiceRequest = !toolCalls.length ? normalizeChoiceRequest(reply.choice) ?? inferChoiceRequest(reply.final) : undefined
      if (reply.thought) {
        thoughtStep.detail = toolCalls.length ? sanitizeThoughtBeforeAction(reply.thought) : reply.thought
        this.upsertStep(task, thoughtStep, onStep)
      } else if (implicitOfficeCall) {
        thoughtStep.detail = '检测到需要读取 Office 附件，准备立即调用 ' + implicitOfficeCall.name + '。'
        this.upsertStep(task, thoughtStep, onStep)
      }
      if (choiceRequest) {
        const selectedId = requestUserChoice ? await requestUserChoice(choiceRequest) : undefined
        throwIfAborted(signal)
        const selected = choiceRequest.options.find((option) => option.id === selectedId)
        if (!selected) {
          messages.push({ role: 'user', content: '用户没有确认任何方案。不要重复请求相同选择；请采用不需要该选择的安全方案，或说明无法继续并输出 Final。' })
          continue
        }
        this.addStep(task, step('reason', '用户已选择方案', selected.label), onStep)
        messages.push({ role: 'user', content: 'UserChoice Observation:\n用户选择了方案 ' + selected.id + '：' + selected.label + (selected.description ? '\n' + selected.description : '') + '\n请基于该选择继续原任务，不要再次询问同一问题。' })
        continue
      }
      if (reply.final && !toolCalls.length) {
        if (pendingDecryptPaths.size) {
          messages.push({
            role: 'user',
            content: '附件内容疑似加密或二进制，不能直接猜测或要求用户重新提供文件。必须先调用 decrypt_file，path 使用：' + [...pendingDecryptPaths].join('、') + '。解密成功后用 read_file 读取返回的 output_path。'
          })
          continue
        }
        if (isIncompleteFinal(reply.final)) {
          messages.push({ role: 'user', content: '任务尚未完成。不要等待用户提供工具结果；如果需要检查、读取、写入或执行命令，请立即输出下一步 Action JSON。只有完成全部目标后才能输出 Final。' })
          continue
        }
        onDelta?.(reply.final)
        return reply.final
      }

      if (!toolCalls.length) return content
      const deniedMcpCall = toolCalls.find((call) => call.name === 'parse_powerpoint' && call.arguments.path && deniedMcpPaths.has(call.arguments.path))
      if (deniedMcpCall) {
        messages.push({ role: 'user', content: '用户已经拒绝对该文件的 PPT MCP 授权，不得再次请求同一路径。请立即改用其他可用工具或给出不依赖 MCP 的解决思路；如果没有可靠替代方案，如实说明限制并输出 Final。' })
        previousActionSignature = ''
        previousActionHadError = true
        continue
      }
      const actionSignature = JSON.stringify(toolCalls)
      if (actionSignature === previousActionSignature && !previousActionHadError) return content
      previousActionSignature = actionSignature

      const observations: string[] = []
      let currentActionHadError = false
      for (const call of toolCalls.slice(0, MAX_ACTIONS_PER_TURN)) {
        this.addStep(task, step('act', '正在执行工具：' + call.name, this.toolDetail(call)), onStep)
        if (call.name === 'decrypt_file' && call.arguments.path) pendingDecryptPaths.delete(call.arguments.path)
        if ((call.name === 'parse_word' || call.name === 'parse_excel' || call.name === 'parse_powerpoint') && call.arguments.path && pendingOfficeParses.get(call.arguments.path) === call.name) {
          pendingOfficeParses.delete(call.arguments.path)
        }
        let output: string
        try {
          output = await this.executeTool(call, tools, policy, requestMcpApproval, signal)
          throwIfAborted(signal)
          if (call.name === 'parse_powerpoint' && call.arguments.path && output.includes('用户未授权')) {
            deniedMcpPaths.add(call.arguments.path)
            currentActionHadError = true
            output += '\n不要再次请求该路径的 MCP 授权，请改用其他解决思路。'
          }
        } catch (error) {
          throwIfAborted(signal)
          if (!isRecoverableToolError(error, call.name)) throw error
          currentActionHadError = true
          output = '工具执行失败：' + (error instanceof Error ? error.message : String(error))
        }
        const observation = call.name + ': ' + output
        observations.push(observation)
        this.addStep(task, step('act', 'Observation #' + turn + '：' + call.name, output.slice(0, 800)), onStep)
      }

      const observationText = 'Observation #' + turn + ':\n' + observations.join('\n\n')
      messages.push({ role: 'user', content: observationText })
      previousActionHadError = currentActionHadError
    }

    throw new Error('ReAct 循环达到最大轮数，仍未得到 Final。')
  }

  private buildSystemPrompt(policy: AgentPolicy): string {
    const toolSchema = [
      '{',
      '  "action": { "name": "read_file|write_file|create_directory|list_files|decrypt_file|parse_word|parse_excel|parse_powerpoint|run_command", "arguments": { ... } }',
      '}'
    ].join('\n')

    const finalSchema = [
      '{',
      '  "final": "给用户的最终答复"',
      '}'
    ].join('\n')

    const choiceSchema = [
      '{',
      '  "choice": {',
      '    "title": "需要用户确认的简短标题",',
      '    "description": "为什么必须选择",',
      '    "options": [',
      '      { "id": "option_1", "label": "方案名称", "description": "该方案的影响" },',
      '      { "id": "option_2", "label": "方案名称", "description": "该方案的影响" }',
      '    ]',
      '  }',
      '}'
    ].join('\n')

    return [
      policy.systemPrompt,
      '',
      '你必须遵循 ReAct 循环：Thought -> Action -> Observation -> Thought -> ... -> Final。',
      '每一轮先输出一段可展示的简短思考过程，必须包裹在 <think>...</think> 或 <thought>...</thought> 标签中；标签内容会被实时流式展示给用户。',
      '如果本轮需要工具，思考内容只能描述将要执行的计划和原因，必须使用“准备、将要、需要”等未完成措辞；在工具 Observation 返回前，严禁声称文件已经创建、已经写入、已经修改、已经运行、已经完成或已经确认。',
      '只有收到对应工具的 Observation 后，下一轮 Thought 才能描述该工具确实完成的结果；不得在 Action 之前提前编造工具结果。',
      '思考标签结束后，只能输出一个 JSON 对象，不要输出 Markdown，不要包裹代码块，不要把 JSON 放进思考标签里。',
      '如果本轮输出 Action JSON，就必须立刻停止输出，等待工具 Observation；同一轮绝不能再输出 Final 或第二个 JSON 对象。',
      '这里的工具通过文本 Action JSON 协议调用；即使模型 API 的原生 tools 列表为空，也不代表这些工具不可用。禁止声称工具未挂载、无法调用或要求用户重新启用。',
      '当问题需要读取 PowerPoint 内容时，立即输出 parse_powerpoint Action JSON，不要先解释限制。宿主收到该 Action 后会在当前会话向用户请求单次 MCP 授权；授权通过后继续调用，授权拒绝后不得重复申请同一路径，必须考虑其他工具或如实给出替代方案。',
      '禁止使用 run_command 调用 python、PowerShell、tar、unzip 或临时脚本来拆解 Word、Excel、PowerPoint 文件。Office 内容只能使用对应 parse_word、parse_excel、parse_powerpoint 工具；解析失败且疑似加密时使用 decrypt_file，否则根据 Observation 如实说明。',
      '当需要读取、写入、创建目录、列举文件、解密文件、解析 Office 文档或执行命令时，输出 Action JSON：',
      toolSchema,
      '当任务完成或不需要工具时，输出 Final JSON：',
      finalSchema,
      '当存在两个或以上会改变执行路径、工作区、输出位置或实现方案的互斥选项，且无法从上下文安全决定时，输出 Choice JSON：',
      choiceSchema,
      '输出 Choice 后立即停止。禁止把“请选择”及编号方案写进 Final；宿主会显示单选按钮并等待用户确认，随后以 UserChoice Observation 返回选择结果，你必须在同一次任务中继续执行。',
      'Final 字符串必须使用规范的 GitHub Flavored Markdown 排版：用简短标题组织主题，用有序或无序列表拆分要点，需要对比时使用表格；不要输出未闭合的 Markdown 标记，不要用多余空行模拟布局。',
      '工具注册表（只能调用 enabled=true 的工具；严格按 inputSchema 传 arguments）：',
      JSON.stringify(getEnabledToolDefinitions(policy.enabledTools), null, 2),
      '工作区根目录：' + policy.workspacePath,
      '所有文件路径必须是工作区内的相对路径。Word、Excel 使用本地 parse_word、parse_excel 工具；PowerPoint 使用 parse_powerpoint PPT MCP 工具，调用前需要用户单次确认。解析因企业加密失败时，调用 decrypt_file 生成解密副本，再使用对应解析工具读取 output_path。run_command 的 command 必须是可执行文件名，参数放入 args 数组。',
      '每轮最多请求 ' + MAX_ACTIONS_PER_TURN + ' 个工具调用；复杂任务应分多轮进行。'
    ].join('\n')
  }

  private async executeTool(call: ToolCall, tools: WorkspaceTools, policy: AgentPolicy, requestMcpApproval?: McpApprovalCallback, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (!policy.enabledTools.includes(call.name)) throw new Error('工具未启用：' + call.name)
    if (call.name === 'read_file' && call.arguments.path) return tools.readFile(call.arguments.path)
    if (call.name === 'write_file' && call.arguments.path && typeof call.arguments.content === 'string') return tools.writeFile(call.arguments.path, call.arguments.content)
    if (call.name === 'create_directory' && call.arguments.path) return tools.createDirectory(call.arguments.path)
    if (call.name === 'list_files') return tools.listFiles(call.arguments.path ?? '.', call.arguments.recursive ?? false)
    if (call.name === 'decrypt_file' && call.arguments.path) {
      return signal
        ? tools.decryptFile(call.arguments.path, call.arguments.output_path, signal)
        : tools.decryptFile(call.arguments.path, call.arguments.output_path)
    }
    if ((call.name === 'parse_word' || call.name === 'parse_excel') && call.arguments.path) {
      const kind: OfficeDocumentKind = call.name === 'parse_word' ? 'word' : 'excel'
      return parseOfficeDocument(policy.workspacePath, call.arguments.path, kind, {
        maxCharacters: call.arguments.max_characters
      })
    }
    if (call.name === 'parse_powerpoint' && call.arguments.path) {
      const serverUrl = this.getPptMcpUrl()
      const approved = requestMcpApproval
        ? await requestMcpApproval({ toolName: call.name, serverUrl, path: call.arguments.path, workspacePath: policy.workspacePath }).catch(() => false)
        : false
      if (!approved) return '用户未授权本次 PPT MCP 调用，调用已取消。'
      return new PptMcpClient(serverUrl).parsePowerPoint({
        path: call.arguments.path,
        workspace_path: policy.workspacePath,
        max_characters: call.arguments.max_characters,
        include_notes: call.arguments.include_notes
      })
    }
    if (call.name === 'run_command' && call.arguments.command) {
      return signal
        ? tools.runCommand(call.arguments.command, call.arguments.args ?? [], signal)
        : tools.runCommand(call.arguments.command, call.arguments.args ?? [])
    }
    throw new Error('工具参数不完整：' + call.name)
  }

  private buildUserContent(prompt: string, attachments: ChatAttachment[] = []): ModelContent {
    if (!attachments.length) return prompt

    const parts: ModelContentPart[] = []
    if (prompt.trim()) parts.push({ type: 'text', text: prompt })

    for (const attachment of attachments) {
      if (isImageAttachmentType(attachment.mimeType)) {
        parts.push({ type: 'text', text: '图片附件：' + attachment.name })
        parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl, detail: 'auto' } })
        continue
      }
      if (isOfficeAttachmentType(attachment.mimeType, attachment.name)) {
        const toolName = officeAttachmentTool(attachment.name)
        parts.push({
          type: 'text',
          text: [
            'Office 文档附件：' + attachment.name,
            attachment.workspacePath ? '工作区相对路径：' + attachment.workspacePath : '工作区路径不可用。',
            toolName && attachment.workspacePath ? '需要读取内容时，调用 ' + toolName + '，path 必须使用上述工作区相对路径。' : '当前无法解析此附件。'
          ].join('\n')
        })
        continue
      }
      if (isTextAttachmentType(attachment.mimeType, attachment.name)) {
        const text = this.decodeTextAttachment(attachment)
        const decryptInstruction = attachment.workspacePath && isDecryptableAttachmentName(attachment.name) && looksLikeEncryptedTextAttachment(attachment)
          ? [
              '工作区相对路径：' + attachment.workspacePath,
              '检测结果：附件内容疑似加密或二进制。不要猜测内容，必须先调用 decrypt_file，path 使用上述路径；成功后调用 read_file 读取 output_path。'
            ].join('\n')
          : attachment.workspacePath
            ? '工作区相对路径：' + attachment.workspacePath
            : ''
        parts.push({
          type: 'text',
          text: '<attachment name="' + attachment.name + '" type="' + attachment.mimeType + '">\n' + [decryptInstruction, text].filter(Boolean).join('\n') + '\n</attachment>'
        })
      }
    }

    return parts.length ? parts : prompt
  }

  private decodeTextAttachment(attachment: ChatAttachment): string {
    const commaIndex = attachment.dataUrl.indexOf(',')
    if (commaIndex < 0) return '[附件内容无法读取]'
    try {
      const content = Buffer.from(attachment.dataUrl.slice(commaIndex + 1), 'base64').toString('utf8')
      if (content.length <= MAX_TEXT_ATTACHMENT_CHARACTERS) return content
      return content.slice(0, MAX_TEXT_ATTACHMENT_CHARACTERS) + '\n\n[附件内容过长，已截断]'
    } catch {
      return '[附件内容无法读取]'
    }
  }

  private async callModel(messages: ModelMessage[], onDelta?: DeltaCallback, signal?: AbortSignal): Promise<string> {
    const { model } = this.getSettings()
    const maxAttempts = Math.max(1, model.maxRetries + 1)
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal)
      try {
        return await this.callModelOnce(messages, model, onDelta, signal)
      } catch (error) {
        throwIfAborted(signal)
        lastError = error instanceof Error ? error : new Error('模型请求失败')
        if (!this.isRetryableModelError(lastError) || attempt === maxAttempts) throw lastError
        await abortableDelay(Math.min(1000 * 2 ** (attempt - 1), 5000), signal)
      }
    }
    throw lastError ?? new Error('模型请求失败')
  }

  private async callModelOnce(messages: ModelMessage[], model: AppSettings['model'], onDelta?: DeltaCallback, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), model.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
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
        const error = new Error('模型请求失败：' + response.status + (errorDetail ? ' - ' + errorDetail : ''))
        ;(error as Error & { status?: number }).status = response.status
        throw error
      }
      const contentType = response.headers?.get('content-type') ?? ''
      const content = contentType.includes('text/event-stream') ? await this.readStreamResponse(response, onDelta) : await this.readJsonResponse(response)
      if (!content) throw new Error('模型返回为空')
      return content
    } catch (error) {
      if (signal?.aborted) throw new DOMException('任务已暂停', 'AbortError')
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('模型请求超时（' + model.timeoutMs / 1000 + '秒）')
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private isRetryableModelError(error: Error): boolean {
    const status = (error as Error & { status?: number }).status
    return status === 408 || status === 429 || status === 502 || status === 503 || status === 504 || status === 524
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
      const recoveredFinal = this.recoverFinal(payload)
      if (recoveredFinal !== undefined) return this.attachThought({ final: recoveredFinal }, thought)
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

  private recoverFinal(content: string): string | undefined {
    const objectStart = content.indexOf('{')
    if (objectStart < 0) return undefined
    const object = this.extractBalancedObject(content, objectStart)
    if (!object) return undefined
    try {
      const candidate = JSON.parse(this.normalizeJsonControlCharacters(object)) as Partial<ReactModelReply>
      return typeof candidate.final === 'string' ? candidate.final : undefined
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

function sanitizeThoughtBeforeAction(thought: string): string {
  const completionPattern = /(?:已(?:经)?(?:成功)?(?:创建|写入|生成|完成|修改|实现|运行|确认)|(?:创建|写入|生成|修改|实现|运行)成功|任务已完成)/i
  const segments = thought.split(/[。！？.!?\n]/)
  const planned = segments.filter((segment) => !completionPattern.test(segment))
  const result = planned.join('。').trim()
  return result || '准备执行所需工具。'
}

function isIncompleteFinal(finalText: string): boolean {
  return /(?:请|需要).{0,16}(?:提供|返回).{0,12}(?:工具|Observation|结果)|(?:等待|获取).{0,12}(?:工具|Observation).{0,12}(?:结果|返回)|(?:任务|项目).{0,8}(?:尚未|未).{0,8}(?:完成|结束)|(?:还需|需要继续|将继续).{0,12}(?:创建|写入|检查|执行|完成)/i.test(finalText)
}

function inferOfficeToolCall(prompt: string, reply: ReactModelReply, pendingOfficeParses: Map<string, OfficeAttachmentTool>): ToolCall | undefined {
  if (!pendingOfficeParses.size) return undefined
  const text = [prompt, reply.thought, reply.final].filter(Boolean).join('\n')
  const matches = [...pendingOfficeParses].filter(([, toolName]) => {
    if (toolName === 'parse_powerpoint') return /parse_powerpoint|powerpoint|pptx?|幻灯片|演示文稿/i.test(text)
    if (toolName === 'parse_excel') return /parse_excel|excel|xlsx?|工作簿|电子表格/i.test(text)
    return /parse_word|word|docx?|文档|报告/i.test(text)
  })
  const selected = matches.length === 1
    ? matches[0]
    : pendingOfficeParses.size === 1 && /解析|读取|查看|介绍|总结|内容|工具|无法|不能/i.test(text)
      ? [...pendingOfficeParses][0]
      : undefined
  if (!selected) return undefined
  const [path, name] = selected
  return { name, arguments: name === 'parse_powerpoint' ? { path, include_notes: true } : { path } }
}

function normalizeChoiceRequest(value?: UserChoiceDetails): UserChoiceDetails | undefined {
  if (!value || typeof value.title !== 'string' || !Array.isArray(value.options)) return undefined
  const options = value.options
    .filter((option) => option && typeof option.id === 'string' && typeof option.label === 'string')
    .slice(0, 6)
    .map((option, index) => ({
      id: option.id.trim().slice(0, 80) || 'option_' + (index + 1),
      label: option.label.trim().slice(0, 300),
      description: typeof option.description === 'string' && option.description.trim() ? option.description.trim().slice(0, 600) : undefined
    }))
    .filter((option) => option.label)
  if (options.length < 2 || new Set(options.map((option) => option.id)).size !== options.length) return undefined
  return {
    title: value.title.trim().slice(0, 120) || '请选择方案',
    description: typeof value.description === 'string' && value.description.trim() ? value.description.trim().slice(0, 1000) : undefined,
    options
  }
}

function inferChoiceRequest(finalText?: string): UserChoiceDetails | undefined {
  if (!finalText || !/请选择|选择一种|选择以下|确认.+方案/i.test(finalText)) return undefined
  const lines = finalText.split(/\r?\n/)
  const options = lines.flatMap((line) => {
    const match = /^\s*(\d+)[.、)]\s+(.+?)\s*$/.exec(line)
    if (!match) return []
    return [{ id: 'option_' + match[1], label: cleanChoiceText(match[2]) }]
  }).filter((option) => option.label).slice(0, 6)
  if (options.length < 2) return undefined
  const firstOptionIndex = lines.findIndex((line) => /^\s*\d+[.、)]\s+/.test(line))
  const heading = lines.find((line) => /^#{1,4}\s+/.test(line))
  const title = cleanChoiceText(heading?.replace(/^#{1,4}\s+/, '') ?? lines.find((line) => line.trim()) ?? '请选择方案')
  const description = lines.slice(0, firstOptionIndex)
    .filter((line) => line !== heading && !/请选择|选择一种|选择以下/.test(line))
    .map(cleanChoiceText)
    .filter(Boolean)
    .join('\n')
  return normalizeChoiceRequest({ title, description: description || undefined, options })
}

function cleanChoiceText(value: string): string {
  return value.replace(/\*\*|__|`/g, '').trim()
}

function looksLikeEncryptedTextAttachment(attachment: ChatAttachment): boolean {
  const commaIndex = attachment.dataUrl.indexOf(',')
  if (commaIndex < 0) return false
  try {
    const sample = Buffer.from(attachment.dataUrl.slice(commaIndex + 1), 'base64').subarray(0, 8192)
    if (!sample.length) return false
    let controlBytes = 0
    for (const byte of sample) {
      if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) controlBytes++
    }
    const decoded = sample.toString('utf8')
    const replacementCharacters = decoded.split('\uFFFD').length - 1
    return controlBytes / sample.length > 0.02 || replacementCharacters >= 3
  } catch {
    return false
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已暂停', 'AbortError')
}

function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('任务已暂停', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isRecoverableToolError(error: unknown, toolName?: ToolCall['name']): boolean {
  if (toolName === 'decrypt_file' || toolName === 'parse_word' || toolName === 'parse_excel' || toolName === 'parse_powerpoint') return true
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
  const message = error instanceof Error ? error.message : String(error)
  return code === 'ENOENT' || /no such file|cannot find|找不到|不存在|路径不存在/i.test(message)
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
