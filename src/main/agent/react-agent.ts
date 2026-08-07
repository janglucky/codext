import type { AgentArtifact, AgentPolicy, AgentTask, AppSettings, ChatAttachment, CommandApprovalDetails, McpApprovalDetails, ModelConfig, TaskStep, TokenUsage, UserChoiceDetails } from '../../shared/types'
import { isDecryptableAttachmentName, isImageAttachmentType, isOfficeAttachmentType, isTextAttachmentType, MAX_TEXT_ATTACHMENT_CHARACTERS, officeAttachmentTool, type OfficeAttachmentTool } from '../../shared/attachments'
import { WorkspaceTools } from '../tools/workspace-tools'
import { getEnabledToolDefinitions, isToolName, type ToolCall } from '../tools/tool-registry'
import { parseOfficeDocument, type OfficeDocumentKind } from '../tools/office-parser'
import { PptMcpClient } from '../ppt/ppt-mcp-client'
import { classifyCommandRisk } from '../tools/command-risk'
import { modelFetch } from '../model-fetch'
import { prepareContext, estimateContextTokens, type ContextContent as ModelContent, type ContextContentPart as ModelContentPart, type ContextMessage as ModelMessage } from './context-manager'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '../../shared/models'
import {
  applyPathCandidate,
  asStreamAssemblyIssue,
  buildToolRepairPrompt,
  issueFailureMessage,
  normalizeRawToolCall,
  normalizeToolArguments,
  prepareToolCall,
  type ToolCallIssue
} from './tool-call-recovery'
import { selectTaskHistory } from './history-selector'

const MAX_REACT_TURNS = 100
const MAX_ACTIONS_PER_TURN = 1
const MAX_REACT_FORMAT_RETRIES = 2
const MAX_REPEATED_ACTION_RETRIES = 2
const MAX_TOOL_ARGUMENT_REPAIRS = 2
const MAX_INCOMPLETE_ACTION_REPAIRS = 2
const MODEL_INACTIVITY_TIMEOUT_MS = 60_000
// The model output is limited by max_tokens already. Keep this guard above the
// normal response budget so a long response is not cut off before its Action
// JSON arrives. Provider reasoning fields are discarded before this check.
const MAX_UNSTRUCTURED_RESPONSE_CHARACTERS = 64_000
const MAX_DISPLAYED_THOUGHT_CHARACTERS = 240

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

type ReactModelReply = {
  thought?: string
  action?: unknown
  tool_calls?: unknown[]
  choice?: UserChoiceDetails
  final?: string
  unparsed?: string
  toolIssue?: ToolCallIssue
}
type RawModelUsage = { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
type ModelResponse = { content: string; usage?: RawModelUsage; protocolDrift?: boolean; streamToolCallAssemblyError?: boolean }
type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
  attachments?: ChatAttachment[]
  status?: string
  steps?: TaskStep[]
}
type StepCallback = (step: TaskStep) => void
type DeltaCallback = (delta: string) => void
type McpApprovalCallback = (request: McpApprovalDetails) => Promise<boolean>
type CommandApprovalCallback = (request: CommandApprovalDetails) => Promise<boolean>
type UserChoiceSelection = string | { optionId?: string; workspacePath?: string }
type UserChoiceCallback = (request: UserChoiceDetails) => Promise<UserChoiceSelection | undefined>

function normalizeModelContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string') return part.text
    return ''
  }).join('')
}

export class ReactAgent {
  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly getPolicy: () => AgentPolicy,
    private readonly getPptMcpUrl: () => string = () => '',
    private readonly maxReactTurns = MAX_REACT_TURNS,
    private readonly modelInactivityTimeoutMs = MODEL_INACTIVITY_TIMEOUT_MS
  ) {}

  async run(prompt: string, history: ConversationMessage[] = [], onStep?: StepCallback, onDelta?: DeltaCallback, attachments: ChatAttachment[] = [], requestMcpApproval?: McpApprovalCallback, signal?: AbortSignal, workspacePath?: string, requestUserChoice?: UserChoiceCallback, requestCommandApproval?: CommandApprovalCallback, modelOverride?: ModelConfig): Promise<AgentTask> {
    const task: AgentTask = { id: crypto.randomUUID(), prompt, status: 'reasoning', createdAt: new Date().toISOString(), steps: [] }
    const configuredPolicy = this.getPolicy()
    const policy = workspacePath?.trim() ? { ...configuredPolicy, workspacePath: workspacePath.trim() } : configuredPolicy

    task.status = 'acting'

    try {
      const result = await this.execute(prompt, policy, task, history, onStep, onDelta, attachments, requestMcpApproval, signal, requestUserChoice, requestCommandApproval, modelOverride)
      task.result = result
      this.recordServiceArtifacts(task, result, false)
      task.status = 'validating'
      task.status = 'succeeded'
    } catch (error) {
      task.error = signal?.aborted ? '任务已暂停' : error instanceof Error ? error.message : '未知执行错误'
      task.status = signal?.aborted ? 'paused' : 'failed'
    }

    return task
  }

  private async execute(prompt: string, policy: AgentPolicy, task: AgentTask, history: ConversationMessage[] = [], onStep?: StepCallback, onDelta?: DeltaCallback, attachments: ChatAttachment[] = [], requestMcpApproval?: McpApprovalCallback, signal?: AbortSignal, requestUserChoice?: UserChoiceCallback, requestCommandApproval?: CommandApprovalCallback, modelOverride?: ModelConfig): Promise<string> {
    throwIfAborted(signal)
    const settings = this.getSettings()
    const model = modelOverride ?? settings.model
    if (!model.baseUrl || !model.model) {
      this.addStep(task, step('reason', '演示模式', '模型接口未完整配置，本次不会调用远程模型。'), onStep)
      return this.demoResponse(prompt, policy)
    }

    let currentPolicy = policy
    let tools = new WorkspaceTools(currentPolicy.workspacePath)
    const selectedHistory = selectTaskHistory(history, prompt, { hasCurrentAttachments: Boolean(attachments.length) })
    const allAttachments = [...attachments, ...selectedHistory.flatMap((message) => message.attachments ?? [])]
    const pendingDecryptPaths = new Set(allAttachments
      .filter((attachment) => attachment.workspacePath && isDecryptableAttachmentName(attachment.name) && looksLikeEncryptedTextAttachment(attachment))
      .map((attachment) => attachment.workspacePath as string))
    const pendingOfficeParses = new Map<string, OfficeAttachmentTool>()
    for (const attachment of allAttachments) {
      const toolName = officeAttachmentTool(attachment.name)
      if (attachment.workspacePath && toolName && currentPolicy.enabledTools.includes(toolName)) pendingOfficeParses.set(attachment.workspacePath, toolName)
    }
    const messages: ModelMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(currentPolicy) },
      ...selectedHistory
        .filter((message) => message.content.trim() || message.attachments?.length)
        .map((message): ModelMessage => ({
          role: message.role,
          content: message.role === 'user' ? this.buildUserContent(message.content, message.attachments) : message.content
        })),
      { role: 'user', content: this.buildUserContent(prompt, attachments) }
    ]
    let previousActionSignature = ''
    let unresolvedCommandFailure = false
    let incompleteToolCallRetries = 0
    let toolArgumentRepairRetries = 0
    let previousToolArgumentIssueSignature = ''
    let repeatedToolArgumentIssueCount = 0
    let focusedModelMessages: ModelMessage[] | undefined
    let reactFormatRetries = 0
    let repeatedActionRetries = 0
    let finalizationOnly = false
    let modelConnectionRecoveryUsed = false
    const observationsForFallback: string[] = []
    const deniedMcpPaths = new Set<string>()
    const deniedCommandSignatures = new Set<string>()
    const toolIntentPrompt = resolveToolIntentPrompt(prompt, selectedHistory)

    for (let turn = 1; turn <= this.maxReactTurns + 1; turn++) {
      throwIfAborted(signal)
      const thoughtStep = step('reason', '思考过程', '')
      const stream = new ReactFieldStream(
        (delta) => {
          thoughtStep.detail += delta
          this.upsertStep(task, thoughtStep, onStep)
        }
      )
      let content: string
      let modelResponse: ModelResponse
      try {
        const requestMessages = focusedModelMessages ?? messages
        focusedModelMessages = undefined
        modelResponse = await this.callModel(requestMessages, (delta) => stream.push(delta), signal, task, model, onStep)
        content = modelResponse.content
      } catch (error) {
        const modelError = error instanceof Error ? error : new Error(String(error))
        const hasToolProgress = task.steps.some((item) => item.phase === 'act' && item.title.startsWith('Observation #'))
        if (!modelConnectionRecoveryUsed && hasToolProgress && this.isRetryableModelError(modelError)) {
          modelConnectionRecoveryUsed = true
          this.addStep(task, step('reason', '模型连接中断，正在恢复', '已保留当前上下文和工具结果，准备继续未完成的任务。'), onStep)
          await abortableDelay(1000, signal)
          turn--
          continue
        }
        if (this.isRetryableModelError(modelError)) throw new Error('模型连接中断，自动重试后仍未恢复：' + modelError.message)
        throw modelError
      }
      modelConnectionRecoveryUsed = false
      const reply = this.parseReply(content)
      const assistantMessageIndex = messages.length
      messages.push({ role: 'assistant', content: modelReplyForHistory(reply, content) })
      let toolCalls = this.getToolCalls(reply)
      let toolIssue = reply.toolIssue
      if (toolIssue && modelResponse.streamToolCallAssemblyError) toolIssue = asStreamAssemblyIssue(toolIssue)
      if (!toolCalls.length && !toolIssue && looksLikeIncompleteToolCall(content)) {
        incompleteToolCallRetries++
        if (incompleteToolCallRetries > MAX_INCOMPLETE_ACTION_REPAIRS || turn > this.maxReactTurns) throw new Error('模型工具调用连续被截断，无法生成可执行的完整 Action。')
        messages[messages.length - 1] = { role: 'assistant', content: '[上一条工具调用在 Action JSON 闭合前被截断，未执行。]' }
        this.addStep(task, step('reason', '工具调用响应不完整', 'Action JSON 在传输完成前被截断，正在请求模型缩小内容后重新生成。'), onStep)
        const repairPrompt = 'ACTION_TRUNCATED：上一条 Action JSON 在结束前被截断，不能执行，也不能把它作为 Final。请立即重新输出一个完整 Action JSON。若 write_file 的 content 较长，必须精简实现，或把 HTML、CSS、JavaScript 拆成多个文件并逐个调用 write_file；单次 content 不得超过 6000 个字符。不要重复发送同样的超长内容。'
        messages.push({ role: 'user', content: repairPrompt })
        focusedModelMessages = buildFocusedRepairContext(messages[0], toolIntentPrompt, latestObservationText(messages), repairPrompt)
        turn--
        continue
      }
      if (toolCalls.length) incompleteToolCallRetries = 0
      const implicitOfficeCall = !toolCalls.length && !pendingDecryptPaths.size
        ? inferOfficeToolCall(prompt, reply, pendingOfficeParses)
        : undefined
      if (implicitOfficeCall) toolCalls = [implicitOfficeCall]
      if (finalizationOnly) {
        const forcedFinal = !toolCalls.length && typeof reply.final === 'string' && !isIncompleteFinal(reply.final)
          ? sanitizeThoughtText(reply.final)
          : ''
        if (forcedFinal) {
          onDelta?.(forcedFinal)
          return forcedFinal
        }
        return this.fallbackFinalAfterRepeatedAction(task, observationsForFallback)
      }
      if (turn > this.maxReactTurns && toolCalls.length) {
        if (task.steps.some((item) => item.phase === 'act' && item.title.startsWith('Observation #'))) {
          return this.fallbackFinalAfterRepeatedAction(task, observationsForFallback)
        }
        throw new Error('ReAct 已达到最大工具轮数，收尾轮不能继续调用工具。')
      }
      toolCalls = toolCalls.slice(0, MAX_ACTIONS_PER_TURN)
      let argumentAdjustments: string[] = []
      if (!toolIssue && toolCalls.length) {
        const preparedCall = prepareToolCall(toolCalls[0], {
          currentRequest: toolIntentPrompt,
          latestObservation: latestObservationText(messages)
        })
        toolIssue = preparedCall.issue
        argumentAdjustments = preparedCall.adjustments
        toolCalls = preparedCall.call ? [preparedCall.call] : []
      }
      if (toolIssue) {
        if (toolIssue.signature === previousToolArgumentIssueSignature) repeatedToolArgumentIssueCount++
        else {
          previousToolArgumentIssueSignature = toolIssue.signature
          repeatedToolArgumentIssueCount = 1
        }
        const shouldStopRepairing = !toolIssue.recoverable ||
          toolArgumentRepairRetries >= MAX_TOOL_ARGUMENT_REPAIRS ||
          repeatedToolArgumentIssueCount >= 2
        if (shouldStopRepairing) {
          const canChoosePath = Boolean(requestUserChoice && toolIssue.partialCall && toolIssue.candidates.length)
          if (!canChoosePath) throw new Error(issueFailureMessage(toolIssue))
          const candidateOptions = toolIssue.candidates.map((path, index) => ({
            id: 'tool_path_' + index,
            label: path,
            description: '将此路径用于 ' + (toolIssue?.toolName ?? '工具') + ' 的 path 参数。'
          }))
          const cancelOption = { id: 'cancel_tool_argument', label: '暂不执行', description: '停止本次工具调用，稍后提供更明确的参数。' }
          const selection = await requestUserChoice?.({
            title: '确认工具路径',
            description: (toolIssue.toolName ?? '工具调用') + ' 缺少唯一明确的 path，请选择本次任务要使用的路径。',
            options: [...candidateOptions, cancelOption]
          })
          throwIfAborted(signal)
          const selectedId = typeof selection === 'string' ? selection : selection?.optionId
          if (!selectedId || selectedId === cancelOption.id) throw new Error('用户未确认工具路径，本次工具调用已停止。')
          const selectedIndex = Number(selectedId.replace('tool_path_', ''))
          const selectedPath = toolIssue.candidates[selectedIndex]
          const clarifiedCall = selectedPath ? applyPathCandidate(toolIssue, selectedPath) : undefined
          if (!clarifiedCall) throw new Error(issueFailureMessage(toolIssue))
          const clarified = prepareToolCall(clarifiedCall, { currentRequest: toolIntentPrompt, latestObservation: latestObservationText(messages) })
          if (!clarified.call) throw new Error(issueFailureMessage(clarified.issue ?? toolIssue))
          toolCalls = [clarified.call]
          toolIssue = undefined
          argumentAdjustments = [...clarified.adjustments, 'path 已由用户确认为 ' + selectedPath]
          messages[assistantMessageIndex] = { role: 'assistant', content: JSON.stringify({ action: clarified.call }) }
          this.addStep(task, step('reason', '用户已补充工具参数', selectedPath), onStep)
        } else {
          toolArgumentRepairRetries++
          const issueContext = { currentRequest: toolIntentPrompt, latestObservation: latestObservationText(messages) }
          const repairPrompt = buildToolRepairPrompt(toolIssue, issueContext, currentPolicy.enabledTools)
          messages[assistantMessageIndex] = {
            role: 'assistant',
            content: '[上一条 ' + (toolIssue.toolName ?? '工具') + ' Action 参数无效，未执行。]'
          }
          messages.push({ role: 'user', content: repairPrompt })
          focusedModelMessages = buildFocusedRepairContext(messages[0], toolIntentPrompt, issueContext.latestObservation, repairPrompt)
          this.addStep(task, step(
            'reason',
            '修复工具调用参数',
            formatToolIssueDetail(toolIssue, toolArgumentRepairRetries, MAX_TOOL_ARGUMENT_REPAIRS)
          ), onStep)
          turn--
          continue
        }
      }
      if (argumentAdjustments.length) {
        this.addStep(task, step('reason', '已补全工具参数', argumentAdjustments.join('；')), onStep)
      }
      const choiceRequest = !toolCalls.length ? normalizeChoiceRequest(reply.choice) ?? inferChoiceRequest(reply.final) : undefined
      const hasToolProgress = task.steps.some((item) => item.phase === 'act' && item.title.startsWith('Observation #'))
      const hasUserChoiceProgress = task.steps.some((item) => item.title === '用户已选择方案')
      const malformedReply = reply.unparsed !== undefined && (modelResponse.protocolDrift || looksLikeMalformedReactReply(content))
      const missingRequiredAction = !toolCalls.length && !choiceRequest && !hasToolProgress && !hasUserChoiceProgress && promptRequiresToolUse(toolIntentPrompt) &&
        (reply.unparsed !== undefined || typeof reply.final === 'string')
      if (malformedReply || missingRequiredAction) {
        reactFormatRetries++
        if (reactFormatRetries > MAX_REACT_FORMAT_RETRIES) {
          throw new Error('模型连续未按 ReAct 协议返回可执行 Action。请检查模型是否支持指令遵循，或切换其他模型后重试。')
        }
        messages[assistantMessageIndex] = {
          role: 'assistant',
          content: missingRequiredAction
            ? '[上一条响应在没有任何工具 Observation 的情况下提前结束，未作为 Final 接受。]'
            : '[上一条响应不符合 ReAct 输出协议，未执行也未作为 Final 接受。]'
        }
        this.addStep(task, step(
          'reason',
          missingRequiredAction ? '模型尚未执行所需工具' : '模型输出格式不正确',
          '正在要求模型改用单个 JSON ReAct 对象继续本次任务。'
        ), onStep)
        messages.push({ role: 'user', content: buildReactCorrectionPrompt(missingRequiredAction) })
        continue
      }
      reactFormatRetries = 0
      if (reply.thought) {
        thoughtStep.detail = formatThoughtDetail(toolCalls.length ? sanitizeThoughtBeforeAction(reply.thought) : sanitizeThoughtText(reply.thought))
        this.upsertStep(task, thoughtStep, onStep)
      } else if (implicitOfficeCall) {
        thoughtStep.detail = '检测到需要读取 Office 附件，准备立即调用 ' + implicitOfficeCall.name + '。'
        this.upsertStep(task, thoughtStep, onStep)
      }
      if (choiceRequest) {
        const selection = requestUserChoice ? await requestUserChoice(choiceRequest) : undefined
        throwIfAborted(signal)
        const selectedId = typeof selection === 'string' ? selection : selection?.optionId
        const selected = choiceRequest.options.find((option) => option.id === selectedId)
        if (!selected) {
          messages.push({ role: 'user', content: '用户没有确认任何方案。不要重复请求相同选择；请采用不需要该选择的安全方案，或说明无法继续并输出 Final。' })
          continue
        }
        this.addStep(task, step('reason', '用户已选择方案', selected.label), onStep)
        const selectedWorkspacePath = typeof selection === 'object' ? selection.workspacePath?.trim() : undefined
        if (selectedWorkspacePath) {
          currentPolicy = { ...currentPolicy, workspacePath: selectedWorkspacePath }
          tools = new WorkspaceTools(selectedWorkspacePath)
          messages[0] = { role: 'system', content: this.buildSystemPrompt(currentPolicy) }
          this.addStep(task, step('reason', '会话工作区已切换', selectedWorkspacePath), onStep)
        }
        messages.push({ role: 'user', content: 'UserChoice Observation:\n用户选择了方案 ' + selected.id + '：' + selected.label + (selected.description ? '\n' + selected.description : '') + (selectedWorkspacePath ? '\n会话工作区已切换为：' + selectedWorkspacePath + '。后续工具必须立即使用该工作区。' : '') + '\n请基于该选择继续原任务，不要再次询问同一问题。' })
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
        if (unresolvedCommandFailure) {
          messages.push({ role: 'user', content: '上一条 run_command 仍处于失败状态，任务尚未验证完成，不能输出 Final。请根据 Observation 中的 stdout/stderr 读取相关文件并修复，然后重新执行对应的构建、测试或检查命令；只有命令成功后才能完成任务。工具名必须使用 run_command，不能写成 run-command。' })
          continue
        }
        if (isIncompleteFinal(reply.final)) {
          messages.push({ role: 'user', content: '任务尚未完成。不要等待用户提供工具结果；如果需要检查、读取、写入或执行命令，请立即输出下一步 Action JSON。只有完成全部目标后才能输出 Final。' })
          continue
        }
        const finalText = sanitizeAssistantText(reply.final)
        onDelta?.(finalText)
        return finalText
      }

      if (!toolCalls.length) {
        const finalText = sanitizeAssistantText(reply.unparsed ?? content)
        onDelta?.(finalText)
        return finalText
      }
      const deniedMcpCall = toolCalls.find((call) => call.name === 'parse_powerpoint' && call.arguments.path && deniedMcpPaths.has(call.arguments.path))
      if (deniedMcpCall) {
        messages.push({ role: 'user', content: '用户已经拒绝对该文件的 PPT MCP 授权，不得再次请求同一路径。请立即改用其他可用工具或给出不依赖 MCP 的解决思路；如果没有可靠替代方案，如实说明限制并输出 Final。' })
        previousActionSignature = ''
        continue
      }
      const deniedCommandCall = toolCalls.find((call) => call.name === 'run_command' && call.arguments.command && deniedCommandSignatures.has(commandSignature(call.arguments.command, call.arguments.args ?? [])))
      if (deniedCommandCall) {
        messages.push({ role: 'user', content: '用户或安全策略已经拒绝执行相同命令，不得再次申请。请改用只读命令、其他安全方案，或如实说明限制并输出 Final。' })
        previousActionSignature = ''
        continue
      }
      const actionSignature = JSON.stringify(toolCalls)
      if (actionSignature === previousActionSignature) {
        repeatedActionRetries++
        if (repeatedActionRetries > MAX_REPEATED_ACTION_RETRIES) {
          finalizationOnly = true
          messages[0] = {
            role: 'system',
            content: this.buildSystemPrompt(currentPolicy) + '\n\n强制收尾：工具已经返回结果，本轮只允许输出一个 Final JSON，禁止输出任何 Action、Choice、Thought 标签或分析正文。'
          }
          messages[assistantMessageIndex] = { role: 'assistant', content: '[模型重复调用已成功执行的工具，已停止重复执行。]' }
          this.addStep(task, step('reason', '整理已有结果', '工具结果已经足够继续，本轮只请求最终答复。'), onStep)
          const latestObservation = [...messages].reverse().find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('Observation #'))
          messages.push({
            role: 'user',
            content: '强制收尾请求：请只输出 Final JSON，不得调用工具。最近一次 Observation 如下：\n' + (latestObservation?.content ?? '工具已成功执行，但 Observation 未能保留。')
          })
          previousActionSignature = actionSignature
          continue
        }
        messages[assistantMessageIndex] = { role: 'assistant', content: '[上一条 Action 与已成功执行的 Action 重复，未再次执行。]' }
        this.addStep(task, step('reason', '整理已有结果', '工具已执行过，正在要求模型使用已有结果继续。'), onStep)
        messages.push({
          role: 'user',
          content: 'REPEATED_ACTION：该 Action 已经成功执行并返回 Observation，不能再次调用，也不能输出原始思考文本。请直接依据最近 Observation 继续；如果任务已完成，只输出 Final JSON。最近一次 Observation：\n' + ([...messages].reverse().find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('Observation #'))?.content ?? '工具已成功执行。')
        })
        continue
      }
      repeatedActionRetries = 0
      previousActionSignature = actionSignature

      const observations: string[] = []
      for (const call of toolCalls.slice(0, MAX_ACTIONS_PER_TURN)) {
        this.addStep(task, step('act', '正在执行工具：' + call.name, this.toolDetail(call)), onStep)
        if (call.name === 'decrypt_file' && call.arguments.path) pendingDecryptPaths.delete(call.arguments.path)
        if ((call.name === 'parse_word' || call.name === 'parse_excel' || call.name === 'parse_powerpoint') && call.arguments.path && pendingOfficeParses.get(call.arguments.path) === call.name) {
          pendingOfficeParses.delete(call.arguments.path)
        }
        let output: string
        try {
          output = await this.executeTool(call, tools, currentPolicy, requestMcpApproval, requestCommandApproval, signal)
          throwIfAborted(signal)
          this.recordToolArtifacts(task, call, output)
          if (call.name === 'run_command') unresolvedCommandFailure = false
          if (call.name === 'parse_powerpoint' && call.arguments.path && output.includes('用户未授权')) {
            deniedMcpPaths.add(call.arguments.path)
            output += '\n不要再次请求该路径的 MCP 授权，请改用其他解决思路。'
          }
          if (call.name === 'run_command' && call.arguments.command && output.includes('用户拒绝')) {
            deniedCommandSignatures.add(commandSignature(call.arguments.command, call.arguments.args ?? []))
            output += '\n不要再次申请相同命令；请改用只读命令或其他安全方案。'
          }
        } catch (error) {
          throwIfAborted(signal)
          if (!isRecoverableToolError(error, call.name)) throw error
          output = '工具执行失败：' + (error instanceof Error ? error.message : String(error))
          const securityBlocked = call.name === 'run_command' && output.includes('安全策略阻止')
          if (call.name === 'run_command') unresolvedCommandFailure = !securityBlocked
          if (securityBlocked && call.arguments.command) {
            deniedCommandSignatures.add(commandSignature(call.arguments.command, call.arguments.args ?? []))
            output += '\n安全策略已拒绝该命令，不得再次尝试。'
          }
        }
        const observation = call.name + ': ' + output
        observations.push(observation)
        this.addStep(task, step('act', 'Observation #' + turn + '：' + call.name, output.slice(0, 800)), onStep)
      }

      const observationText = 'Observation #' + turn + ':\n' + observations.join('\n\n')
      messages.push({ role: 'user', content: observationText })
      observationsForFallback.push(observationText)
      toolArgumentRepairRetries = 0
      previousToolArgumentIssueSignature = ''
      repeatedToolArgumentIssueCount = 0
      if (turn === this.maxReactTurns) {
        messages.push({
          role: 'user',
          content: '已达到本次任务的最大工具轮数。你还有一个不允许调用工具的收尾轮次：请完整读取最后一个 Observation；如果任务和验证已经完成，立即输出 Final JSON，总结实际完成内容和验证结果。禁止再次输出 Action 或 Choice。'
        })
      }
    }

    throw new Error('ReAct 达到最大工具轮数，并在追加收尾轮后仍未得到 Final。')
  }

  private fallbackFinalAfterRepeatedAction(task: AgentTask, observationTexts: string[] = []): string {
    const observations = observationTexts.length
      ? observationTexts.join('\n\n')
      : task.steps
        .filter((item) => item.phase === 'act' && (item.title.startsWith('Observation #') || item.title.startsWith('工具结果')))
        .map((item) => item.title + '\n' + item.detail)
        .join('\n\n')
    return '已基于已获得的工具结果整理当前结果：\n\n' + (observations || '暂无可用工具结果。')
  }

  private buildSystemPrompt(policy: AgentPolicy): string {
    const toolSchema = [
      '{',
      '  "thought": "简短说明下一步及原因",',
      '  "action": { "name": "read_file|write_file|create_directory|list_files|decrypt_file|parse_word|parse_excel|parse_powerpoint|run_command|start_service", "arguments": { ... } }',
      '}'
    ].join('\n')

    const finalSchema = [
      '{',
      '  "thought": "简短说明为何可以结束",',
      '  "final": "给用户的最终答复"',
      '}'
    ].join('\n')

    const choiceSchema = [
      '{',
      '  "thought": "简短说明为何必须由用户选择",',
      '  "choice": {',
      '    "title": "需要用户确认的简短标题",',
      '    "description": "为什么必须选择",',
      '    "options": [',
      '      { "id": "option_1", "label": "方案名称", "description": "该方案的影响" },',
      '      { "id": "option_2", "label": "切换会话工作区", "description": "该方案的影响", "workspacePath": "用户指定的绝对目录" }',
      '    ]',
      '  }',
      '}'
    ].join('\n')

    return [
      policy.systemPrompt,
      '',
      '你必须遵循 ReAct 循环：Thought -> Action -> Observation -> Thought -> ... -> Final。',
      '输出协议是最高优先级约束：每轮只能输出一个合法 JSON 对象，thought 必须作为 JSON 字符串字段；不要输出 Markdown、代码块、XML 标签、JSON 前后说明或第二个 JSON 对象。',
      'thought 只能是 300 字以内的行动摘要，禁止在 thought 中长篇排查、逐段分析代码或反复自问自答；一旦需要查看文件或运行检查，立即结束 thought 并输出 action。',
      '如果本轮需要工具，思考内容只能描述将要执行的计划和原因，必须使用“准备、将要、需要”等未完成措辞；在工具 Observation 返回前，严禁声称文件已经创建、已经写入、已经修改、已经运行、已经完成或已经确认。',
      '只有收到对应工具的 Observation 后，下一轮 Thought 才能描述该工具确实完成的结果；不得在 Action 之前提前编造工具结果。',
      '如果本轮输出 Action JSON，就必须立刻停止输出，等待工具 Observation；同一轮绝不能再输出 Final 或第二个 JSON 对象。',
      '这里的工具通过文本 Action JSON 协议调用；即使模型 API 的原生 tools 列表为空，也不代表这些工具不可用。禁止声称工具未挂载、无法调用或要求用户重新启用。',
      '当问题需要读取 PowerPoint 内容时，立即输出 parse_powerpoint Action JSON，不要先解释限制。宿主收到该 Action 后会在当前会话向用户请求单次 MCP 授权；授权通过后继续调用，授权拒绝后不得重复申请同一路径，必须考虑其他工具或如实给出替代方案。',
      '禁止使用 run_command 调用 python、PowerShell、tar、unzip 或临时脚本来拆解 Word、Excel、PowerPoint 文件。Office 内容只能使用对应 parse_word、parse_excel、parse_powerpoint 工具；解析失败且疑似加密时使用 decrypt_file，否则根据 Observation 如实说明。',
      '当需要读取、写入、创建目录、列举文件、解密文件、解析 Office 文档、执行命令或启动服务时，输出 Action JSON：',
      toolSchema,
      '当任务完成或不需要工具时，输出 Final JSON：',
      finalSchema,
      '当存在两个或以上会改变执行路径、工作区、输出位置或实现方案的互斥选项，且无法从上下文安全决定时，输出 Choice JSON：',
      choiceSchema,
      '如果某个选项表示切换会话工作区，该选项必须提供 workspacePath，值为用户明确指定的绝对目录；不要只在 label 或 description 中描述目录。用户确认后宿主会真正切换工作区，不能自行声称已经切换。',
      '输出 Choice 后立即停止。禁止把“请选择”及编号方案写进 Final；宿主会显示单选按钮并等待用户确认，随后以 UserChoice Observation 返回选择结果，你必须在同一次任务中继续执行。',
      'Final 字符串必须使用规范的 GitHub Flavored Markdown 排版：用简短标题组织主题，用有序或无序列表拆分要点，需要对比时使用表格；不要输出未闭合的 Markdown 标记，不要用多余空行模拟布局。',
      '工具注册表（只能调用 enabled=true 的工具；严格按 inputSchema 传 arguments）：',
      JSON.stringify(getEnabledToolDefinitions(policy.enabledTools), null, 2),
      '工作区根目录：' + policy.workspacePath,
      '所有文件路径必须是工作区内的相对路径。write_file 的单次 content 不得超过 6000 个字符；较大的页面或程序必须拆分为多个文件并逐个写入，禁止在一个 Action 中嵌入超长文件。Word、Excel 使用本地 parse_word、parse_excel 工具；PowerPoint 使用 parse_powerpoint PPT MCP 工具，调用前需要用户单次确认。解析因企业加密失败时，调用 decrypt_file 生成解密副本，再使用对应解析工具读取 output_path。run_command 的工具名必须严格写成 run_command，不能写成 run-command；command 必须是可执行文件名，参数放入 args 数组。宿主会识别命令风险：ls、dir、cat、find、grep、git status/diff/log 以及 SSH 远程只读查询可以直接执行；可能写入文件、安装依赖、运行脚本或修改远程状态的命令会在当前会话请求用户单次授权；删除、格式化、关机、终止进程和强制清理命令会直接拒绝。用户明确要求查看远程目录或文件时，应立即调用 ssh 等只读命令，不要仅因远程路径不在本地工作区而拒绝；但远程写操作仍必须等待宿主授权。调用 Node 包管理器时 command 始终使用 npm 或 npx；宿主会自动处理 Windows 的 .cmd 启动文件，禁止自行改用 npm.cmd、npm。cmd，禁止仅为探测 PATH 重复调用同一命令。创建或更新 Node 项目时必须先读取 node --version，并选择满足当前 Node 引擎要求的依赖版本；遇到 EBADENGINE 时应修改 package.json 中不兼容的依赖版本后重新安装，不要反复执行相同的 npm install。任何构建、测试或检查命令失败后，必须根据完整 Observation 定位并修改文件，再重新运行验证命令；验证成功前禁止输出 Final。启动开发服务器或其他长驻 Web 服务必须使用 start_service，禁止使用 run_command；start_service 返回地址后，Final 必须包含该完整 http 或 https 地址。',
      '每轮最多请求 ' + MAX_ACTIONS_PER_TURN + ' 个工具调用；复杂任务应分多轮进行。',
      '再次确认输出契约：只返回一个 JSON 对象，并且只包含 thought + action、thought + choice 或 thought + final 三种结构之一。需要操作文件、仓库、命令或服务且尚未收到 Observation 时，禁止输出 final。'
    ].join('\n')
  }

  private async executeTool(call: ToolCall, tools: WorkspaceTools, policy: AgentPolicy, requestMcpApproval?: McpApprovalCallback, requestCommandApproval?: CommandApprovalCallback, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (!policy.enabledTools.includes(call.name)) throw new Error('工具未启用：' + call.name)
    const validated = prepareToolCall(call, { currentRequest: '' })
    if (!validated.call) throw new Error(issueFailureMessage(validated.issue!))
    call = validated.call
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
      const args = call.arguments.args ?? []
      const risk = classifyCommandRisk(call.arguments.command, args)
      if (risk.level === 'blocked') return tools.runCommand(call.arguments.command, args, signal)
      const approved = risk.level === 'write' && requestCommandApproval
        ? await requestCommandApproval({ command: call.arguments.command, args, displayCommand: risk.displayCommand, reason: risk.reason, workspacePath: policy.workspacePath }).catch(() => false)
        : false
      if (risk.level === 'write' && !approved) return '用户拒绝执行本次写入类命令，命令已取消。'
      return signal
        ? tools.runCommand(call.arguments.command, args, signal, approved)
        : tools.runCommand(call.arguments.command, args, undefined, approved)
    }
    if (call.name === 'start_service' && call.arguments.command) return tools.startService(call.arguments.command, call.arguments.args ?? [], signal)
    throw new Error('工具调用无法执行：' + call.name)
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

  private recordToolArtifacts(task: AgentTask, call: ToolCall, output: string): void {
    if (call.name === 'write_file' && call.arguments.path) {
      this.addArtifact(task, { type: 'file', path: call.arguments.path })
    }
    if (call.name === 'decrypt_file') {
      try {
        const result = JSON.parse(output) as { output_path?: unknown }
        if (typeof result.output_path === 'string' && result.output_path.trim()) this.addArtifact(task, { type: 'file', path: result.output_path.trim() })
      } catch {
        /* 解密工具的非结构化输出不包含可导航文件。 */
      }
    }
    if (call.name === 'run_command' || call.name === 'start_service') this.recordServiceArtifacts(task, output, true)
  }

  private recordServiceArtifacts(task: AgentTask, text: string, localOnly: boolean): void {
    for (const url of extractWebUrls(text, localOnly)) this.addArtifact(task, { type: 'service', url })
  }

  private addArtifact(task: AgentTask, artifact: AgentArtifact): void {
    const artifacts = task.artifacts ?? []
    const key = artifact.type === 'file' ? 'file:' + artifact.path.replaceAll('\\', '/').toLowerCase() : 'service:' + artifact.url
    const exists = artifacts.some((item) => (item.type === 'file' ? 'file:' + item.path.replaceAll('\\', '/').toLowerCase() : 'service:' + item.url) === key)
    if (!exists) task.artifacts = [...artifacts, artifact]
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

  private async callModel(messages: ModelMessage[], onDelta: DeltaCallback | undefined, signal: AbortSignal | undefined, task: AgentTask, model: ModelConfig, onStep?: StepCallback): Promise<ModelResponse> {
    const prepared = prepareContext(messages, {
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens
    })
    if (prepared.compressed) {
      messages.splice(0, messages.length, ...prepared.messages)
      this.addStep(task, step(
        'reason',
        '已完成上下文压缩',
        '第 ' + prepared.level + ' 级 · ' + prepared.beforeTokens.toLocaleString('zh-CN') + ' → ' + prepared.afterTokens.toLocaleString('zh-CN') + ' tokens'
      ), onStep)
    }
    const maxAttempts = Math.max(1, model.maxRetries + 1)
    const totalTimeoutMs = Math.max(1000, model.timeoutMs)
    const deadline = Date.now() + totalTimeoutMs
    let lastError: Error | undefined
    let useStreaming = true
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal)
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new Error('模型请求超时（' + totalTimeoutMs / 1000 + '秒）')
      try {
        const startedAt = performance.now()
        const response = await this.callModelOnce(messages, model, onDelta, signal, remainingMs, useStreaming)
        this.recordTokenUsage(task, messages, response, Math.max(1, performance.now() - startedAt))
        return response
      } catch (error) {
        throwIfAborted(signal)
        lastError = error instanceof Error ? error : new Error('模型请求失败')
        if (!this.isRetryableModelError(lastError) || attempt === maxAttempts) throw lastError
        const retryDelayMs = Math.min(1000 * 2 ** (attempt - 1), 5000)
        if (Date.now() + retryDelayMs >= deadline) throw new Error('模型请求超时（' + totalTimeoutMs / 1000 + '秒）')
        const stalledStream = useStreaming && /模型连接超时|没有新数据/.test(lastError.message)
        if (stalledStream) useStreaming = false
        this.addStep(task, step(
          'reason',
          stalledStream ? '流式响应停顿，改用非流式重试' : '模型响应中断，正在重试',
          '第 ' + attempt + ' 次请求失败：' + lastError.message
        ), onStep)
        await abortableDelay(retryDelayMs, signal)
      }
    }
    throw lastError ?? new Error('模型请求失败')
  }

  private async callModelOnce(messages: ModelMessage[], model: ModelConfig, onDelta: DeltaCallback | undefined, signal: AbortSignal | undefined, remainingMs: number, useStreaming: boolean): Promise<ModelResponse> {
    const controller = new AbortController()
    const totalTimeoutMs = Math.max(1000, remainingMs)
    const inactivityTimeoutMs = Math.min(totalTimeoutMs, Math.max(10, this.modelInactivityTimeoutMs))
    let timeoutKind: 'total' | 'inactivity' | undefined
    const abortForTimeout = (kind: 'total' | 'inactivity'): void => {
      if (!timeoutKind) timeoutKind = kind
      controller.abort()
    }
    const totalTimer = setTimeout(() => abortForTimeout('total'), totalTimeoutMs)
    const firstByteTimer = setTimeout(() => abortForTimeout('inactivity'), inactivityTimeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: useStreaming ? 'text/event-stream' : 'application/json' }
      if (model.apiKey.trim()) headers.Authorization = 'Bearer ' + model.apiKey
      const contextWindowTokens = Math.max(4096, Math.floor(model.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS))
      const maxOutputTokens = Math.min(Math.max(256, Math.floor(model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)), Math.floor(contextWindowTokens * 0.5))
      const requestBody: Record<string, unknown> = { model: model.model, messages, temperature: 0, max_tokens: maxOutputTokens, stream: useStreaming }
      if (useStreaming) requestBody.stream_options = { include_usage: true }
      const response = await modelFetch(model.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify(requestBody)
      })
      clearTimeout(firstByteTimer)
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
      const result = contentType.includes('text/event-stream')
        ? await this.readStreamResponse(response, onDelta, inactivityTimeoutMs)
        : await this.readJsonResponse(response)
      if (!result.content) throw new Error('模型返回为空')
      return result
    } catch (error) {
      if (signal?.aborted) throw new DOMException('任务已暂停', 'AbortError')
      if (timeoutKind === 'inactivity') throw new Error('模型连接超时（' + inactivityTimeoutMs / 1000 + '秒内未收到响应）')
      if (timeoutKind === 'total') throw new Error('模型请求超时（' + totalTimeoutMs / 1000 + '秒）')
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('模型请求超时（' + totalTimeoutMs / 1000 + '秒）')
      }
      throw error
    } finally {
      clearTimeout(totalTimer)
      clearTimeout(firstByteTimer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private isRetryableModelError(error: Error): boolean {
    const status = (error as Error & { status?: number }).status
    const causeCode = (error as Error & { cause?: { code?: unknown } }).cause?.code
    return status === 408 || status === 429 || status === 502 || status === 503 || status === 504 || status === 524 ||
      error.name === 'TypeError' || /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|UND_ERR|超时|中断|无数据|没有新数据|timeout|timed out/i.test(error.message) ||
      (typeof causeCode === 'string' && /ECONNRESET|ETIMEDOUT|UND_ERR|EAI_AGAIN|ENETUNREACH/i.test(causeCode))
  }

  private async readJsonResponse(response: Response): Promise<ModelResponse> {
    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: unknown
          reasoning_content?: unknown
          reasoning?: unknown
          thinking?: unknown
          tool_calls?: Array<{ function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown }>
        }
        delta?: { content?: unknown }
      }>
      usage?: RawModelUsage
    }
    const message = payload.choices?.[0]?.message
    const nativeToolCalls = message?.tool_calls?.flatMap((item) => {
      const source = item.function ?? item
      return typeof source.name === 'string' ? [{ name: source.name, arguments: source.arguments ?? {} }] : []
    }) ?? []
    const messageContent = normalizeModelContent(message?.content ?? payload.choices?.[0]?.delta?.content)
    const content = nativeToolCalls.length
      ? JSON.stringify({ thought: '准备执行模型返回的工具调用。', tool_calls: nativeToolCalls })
      : messageContent
    return {
      content,
      usage: payload.usage
    }
  }

  private async readStreamResponse(response: Response, onDelta: DeltaCallback | undefined, inactivityTimeoutMs: number): Promise<ModelResponse> {
    const reader = response.body?.getReader()
    if (!reader) return this.readJsonResponse(response)

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let usage: RawModelUsage | undefined
    let streamDone = false
    let protocolDrift = false
    let lastActivityAt = Date.now()
    const streamedToolCalls = new Map<number, { name: string; arguments: string }>()
    const processLine = (line: string): boolean => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return false
      const data = trimmed.slice(5).trim()
      if (!data) return false
      if (data === '[DONE]') {
        streamDone = true
        return true
      }

      const payload = this.parseStreamPayload(data)
      if (payload.usage) usage = payload.usage
      for (const toolCall of payload.toolCallDeltas ?? []) {
        const current = streamedToolCalls.get(toolCall.index) ?? { name: '', arguments: '' }
        current.name += toolCall.name ?? ''
        current.arguments += toolCall.arguments ?? ''
        streamedToolCalls.set(toolCall.index, current)
      }
      if (payload.delta) {
        content += payload.delta
        onDelta?.(payload.delta)
      }
      return Boolean(payload.delta || payload.reasoningDelta || payload.usage || payload.toolCallDeltas?.length)
    }

    const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      const remainingIdleMs = Math.max(1, inactivityTimeoutMs - (Date.now() - lastActivityAt))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('模型响应流超过 ' + inactivityTimeoutMs / 1000 + ' 秒没有新数据。')), remainingIdleMs)
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    try {
      while (!streamDone) {
        const { value, done } = await readWithTimeout()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        let hadActivity = false
        for (const line of lines) hadActivity = processLine(line) || hadActivity
        if (hadActivity) lastActivityAt = Date.now()
        if (!streamDone && content.length >= MAX_UNSTRUCTURED_RESPONSE_CHARACTERS && !hasReactProtocolPayload(content)) {
          protocolDrift = true
          streamDone = true
        }
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined)
      throw error
    }
    if (streamDone) void reader.cancel().catch(() => undefined)

    buffer += decoder.decode()
    if (buffer.trim()) processLine(buffer)
    if (streamedToolCalls.size) {
      const toolCalls = [...streamedToolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({ name: call.name, arguments: call.arguments || {} }))
      const streamToolCallAssemblyError = toolCalls.some((call) => {
        if (!call.name) return true
        if (typeof call.arguments !== 'string') return false
        try {
          const value = JSON.parse(call.arguments) as unknown
          return !value || typeof value !== 'object' || Array.isArray(value)
        } catch {
          return true
        }
      })
      content = JSON.stringify({
        thought: explicitJsonThought(content) || '准备执行模型返回的工具调用。',
        tool_calls: toolCalls
      })
      return { content, usage, protocolDrift, streamToolCallAssemblyError }
    }
    return { content, usage, protocolDrift }
  }

  private parseStreamPayload(data: string): { delta: string; reasoningDelta?: string; usage?: RawModelUsage; toolCallDeltas?: Array<{ index: number; name?: string; arguments?: string }> } {
    try {
      const payload = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: unknown
            reasoning_content?: unknown
            reasoning?: unknown
            thinking?: unknown
            tool_calls?: Array<{ index?: number; function?: { name?: unknown; arguments?: unknown }; name?: unknown; arguments?: unknown }>
          }
          message?: {
            content?: unknown
            tool_calls?: Array<{ index?: number; function?: { name?: unknown; arguments?: unknown }; name?: unknown; arguments?: unknown }>
          }
        }>
        usage?: RawModelUsage
      }
      const delta = payload.choices?.[0]?.delta
      const rawToolCalls = delta?.tool_calls ?? payload.choices?.[0]?.message?.tool_calls ?? []
      return {
        delta: normalizeModelContent(delta?.content ?? payload.choices?.[0]?.message?.content),
        reasoningDelta: normalizeModelContent(delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking) || undefined,
        usage: payload.usage,
        toolCallDeltas: rawToolCalls.flatMap((item, index) => {
          const source = item.function ?? item
          const name = typeof source.name === 'string' ? source.name : undefined
          const argumentsValue = typeof source.arguments === 'string'
            ? source.arguments
            : source.arguments && typeof source.arguments === 'object'
              ? JSON.stringify(source.arguments)
              : undefined
          return name !== undefined || argumentsValue !== undefined
            ? [{ index: typeof item.index === 'number' ? item.index : index, name, arguments: argumentsValue }]
            : []
        })
      }
    } catch {
      return { delta: '' }
    }
  }

  private recordTokenUsage(task: AgentTask, messages: ModelMessage[], response: ModelResponse, durationMs: number): void {
    const inputTokens = normalizedTokenCount(response.usage?.prompt_tokens ?? response.usage?.input_tokens)
    const outputTokens = normalizedTokenCount(response.usage?.completion_tokens ?? response.usage?.output_tokens)
    const current: TokenUsage = {
      inputTokens: inputTokens ?? estimateContextTokens(messages),
      outputTokens: outputTokens ?? estimateTokenCount(response.content),
      durationMs,
      estimated: inputTokens === undefined || outputTokens === undefined
    }
    const previous = task.tokenUsage
    task.tokenUsage = previous ? {
      inputTokens: previous.inputTokens + current.inputTokens,
      outputTokens: previous.outputTokens + current.outputTokens,
      durationMs: previous.durationMs + current.durationMs,
      estimated: previous.estimated || current.estimated
    } : current
  }

  private parseReply(content: string): ReactModelReply {
    const payload = stripCodeFences(stripThoughtTags(content)).trim()

    try {
      const parsed = this.normalizeReplyCandidate(JSON.parse(payload))
      if (parsed) return parsed
    } catch {
      /* 继续尝试从带说明文字、相邻 JSON 或标准 ReAct 文本中恢复。 */
    }

    const objects = this.parseJsonObjects(payload)
    for (const object of objects) {
      const parsed = this.normalizeReplyCandidate(object)
      if (parsed) return parsed
    }
    const recoveredAction = this.recoverAction(payload)
    if (recoveredAction) return this.attachThought({ action: recoveredAction })
    const textReply = this.parseTextReactReply(payload)
    if (textReply) return textReply
    const narrativeAction = inferNarrativeReadCall(payload)
    if (narrativeAction) return this.attachThought({ action: narrativeAction })
    const recoveredFinal = this.recoverFinal(payload)
    if (recoveredFinal !== undefined) return this.attachThought({ final: recoveredFinal })
    return { unparsed: payload || stripThoughtTags(content).trim() }
  }

  private normalizeReplyCandidate(value: unknown): ReactModelReply | undefined {
    if (!value || typeof value !== 'object') return undefined
    const candidate = value as ReactModelReply
    const calls = this.getToolCalls(candidate)
    if (calls.length) {
      const normalized = candidate.action ? { ...candidate, action: calls[0], tool_calls: undefined } : { ...candidate, tool_calls: calls }
      return this.attachThought(normalized)
    }
    const toolIssue = this.getToolCallIssue(candidate)
    if (toolIssue) return this.attachThought({ toolIssue })
    if (typeof candidate.final === 'string') return this.attachThought({ ...candidate, final: candidate.final })
    if (candidate.choice && typeof candidate.choice === 'object') return this.attachThought(candidate)
    return undefined
  }

  private parseTextReactReply(content: string): ReactModelReply | undefined {
    const actionMatch = /(?:^|\n)\s*(?:thoughtful\s+)?(?:action|行动|动作)\s*[:：]\s*([^\n]*)/im.exec(content)
    const finalMatch = /(?:^|\n)\s*(?:final\s+answer|final|最终答案|最终回复)\s*[:：]\s*([\s\S]*)$/im.exec(content)
    const thought = extractReactSection(content, /(?:thought|思考|计划)\s*[:：]/i, /(?:action|行动|动作|action\s+input|行动输入|observation|观察|final|最终答案)\s*[:：]/i)

    if (actionMatch) {
      const actionLine = actionMatch[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
      const inputMatch = /(?:^|\n)\s*(?:action\s*input|actioninput|行动输入|动作输入|参数|输入)\s*[:：]\s*([\s\S]*)/im.exec(content)
      const input = inputMatch?.[1]
        ?.split(/\n\s*(?:observation|观察|thought|思考|final(?:\s+answer)?|最终答案)\s*[:：]/i)[0]
        .trim()
      const action = this.parseLooseAction(actionLine, input)
      if (action) return this.attachThought({ thought: thought || undefined, action })
      const toolIssue = this.parseLooseActionIssue(actionLine, input)
      if (toolIssue) return this.attachThought({ thought: thought || undefined, toolIssue })
    }
    if (finalMatch) return this.attachThought({ thought: thought || undefined, final: finalMatch[1].trim() })
    return undefined
  }

  private parseLooseAction(actionLine: string, input?: string): ToolCall | undefined {
    const actionObject = actionLine.startsWith('{') ? this.extractBalancedObject(actionLine, 0) : undefined
    if (actionObject) {
      try {
        const parsed = JSON.parse(this.normalizeJsonControlCharacters(actionObject)) as ReactModelReply
        const parsedCalls = this.getToolCalls(parsed)
        const calls = parsedCalls.length ? parsedCalls : this.getToolCalls({ action: parsed as unknown as ToolCall })
        if (calls.length) return calls[0]
        if (typeof (parsed as unknown as { name?: unknown }).name === 'string') {
          return normalizeRawToolCall(parsed).call
        }
      } catch {
        return undefined
      }
    }

    const name = normalizeToolName(actionLine.match(/^[a-zA-Z_][\w-]*/)?.[0] ?? '')
    if (!isToolName(name)) return undefined
    const inlineObjectStart = actionLine.indexOf('{')
    const rawInput = inlineObjectStart >= 0 ? actionLine.slice(inlineObjectStart) : input
    const object = rawInput ? this.extractBalancedObject(rawInput, 0) : undefined
    const args = object ? parseLooseArguments(this.normalizeJsonControlCharacters(object)) : normalizeLooseArguments(rawInput, name)
    if (args) return { name, arguments: args }
    return undefined
  }

  private parseLooseActionIssue(actionLine: string, input?: string): ToolCallIssue | undefined {
    if (actionLine.startsWith('{')) {
      const actionObject = this.extractBalancedObject(actionLine, 0)
      if (!actionObject) return undefined
      try {
        return normalizeRawToolCall(JSON.parse(this.normalizeJsonControlCharacters(actionObject))).issue
      } catch {
        return undefined
      }
    }
    const rawName = actionLine.match(/^[a-zA-Z_][\w-]*/)?.[0]
    if (!rawName) return undefined
    const inlineObjectStart = actionLine.indexOf('{')
    const rawInput = inlineObjectStart >= 0 ? actionLine.slice(inlineObjectStart) : input
    return normalizeRawToolCall({ name: rawName, arguments: rawInput ?? {} }).issue
  }

  private attachThought(reply: ReactModelReply): ReactModelReply {
    const explicitThought = typeof reply.thought === 'string' ? formatThoughtDetail(sanitizeThoughtText(reply.thought)) : ''
    if (explicitThought) return { ...reply, thought: explicitThought }
    if (reply.action || reply.tool_calls?.length) return { ...reply, thought: '准备执行所需工具。' }
    if (reply.toolIssue) return { ...reply, thought: '正在修复工具调用参数。' }
    if (reply.choice) return { ...reply, thought: '需要确认下一步方案。' }
    return reply
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
      return normalizeRawToolCall(candidate).call
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
    const calls: unknown[] = reply.action ? [reply.action] : reply.tool_calls ?? []
    return calls.flatMap((item) => normalizeRawToolCall(item).call ?? [])
  }

  private getToolCallIssue(reply: ReactModelReply): ToolCallIssue | undefined {
    const calls: unknown[] = reply.action ? [reply.action] : reply.tool_calls ?? []
    return calls.map((item) => normalizeRawToolCall(item).issue).find((issue): issue is ToolCallIssue => Boolean(issue))
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

function latestObservationText(messages: ModelMessage[]): string | undefined {
  const message = [...messages].reverse().find((candidate) =>
    candidate.role === 'user' && typeof candidate.content === 'string' &&
    (/^Observation #/i.test(candidate.content) || /^UserChoice Observation:/i.test(candidate.content))
  )
  return typeof message?.content === 'string' ? message.content : undefined
}

function buildFocusedRepairContext(systemMessage: ModelMessage, currentRequest: string, latestObservation: string | undefined, repairPrompt: string): ModelMessage[] {
  return [
    systemMessage,
    { role: 'user', content: '当前用户请求：\n' + currentRequest },
    ...(latestObservation ? [{ role: 'user' as const, content: latestObservation }] : []),
    { role: 'assistant', content: '[上一条工具调用无效，未执行。]' },
    { role: 'user', content: repairPrompt }
  ]
}

function formatToolIssueDetail(issue: ToolCallIssue, attempt: number, maximum: number): string {
  const fields = [
    issue.type,
    issue.toolName ? '工具：' + issue.toolName : '',
    issue.missing.length ? '缺少：' + issue.missing.join('、') : '',
    issue.invalid.length ? '类型错误：' + issue.invalid.join('、') : '',
    issue.candidates.length ? '候选路径：' + issue.candidates.join('、') : '',
    '修复尝试 ' + attempt + '/' + maximum
  ]
  return fields.filter(Boolean).join(' · ')
}

function stripThoughtTags(content: string): string {
  return content
    .replace(THOUGHT_BLOCK_PATTERN, '')
    .replace(UNCLOSED_THOUGHT_PATTERN, '')
}

function stripCodeFences(content: string): string {
  return content
    .replace(/^\s*```(?:json|re?act)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
}

function extractReactSection(content: string, startPattern: RegExp, stopPattern: RegExp): string {
  const start = startPattern.exec(content)
  if (!start) return ''
  const remainder = content.slice(start.index + start[0].length)
  const stop = stopPattern.exec(remainder)
  return (stop ? remainder.slice(0, stop.index) : remainder).trim()
}

function parseLooseArguments(value: string): ToolCall['arguments'] | undefined {
  const normalized = value.trim()
  if (!normalized) return {}
  try {
    return normalizeToolArguments(JSON.parse(normalized))
  } catch {
    return undefined
  }
}

function normalizeLooseArguments(value: string | undefined, name: string): ToolCall['arguments'] | undefined {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, '')
  if (!normalized) return {}
  const parsed = parseLooseArguments(normalized)
  if (parsed) return parsed
  const keyValue = /^(?:path|file|文件|路径)\s*[:=：]\s*["']?(.+?)["']?$/i.exec(normalized)
  if (keyValue && ['read_file', 'list_files', 'create_directory', 'decrypt_file', 'parse_word', 'parse_excel', 'parse_powerpoint'].includes(name)) return { path: keyValue[1].trim() }
  if (['read_file', 'list_files', 'create_directory', 'decrypt_file', 'parse_word', 'parse_excel', 'parse_powerpoint'].includes(name)) return { path: normalized }
  if (name === 'run_command') {
    const pieces = normalized.split(/\s+/).filter(Boolean)
    return pieces.length ? { command: pieces[0], args: pieces.slice(1) } : undefined
  }
  return undefined
}

function promptRequiresToolUse(prompt: string): boolean {
  if (!prompt.trim()) return false
  const chineseAction = /(?:读取|查看|看一下|检查|列出|遍历|搜索|查找|打开|修改|编辑|写入|创建|新建|生成|保存|删除|重命名|移动|复制).{0,20}(?:文件|目录|文件夹|代码|仓库|项目|配置|脚本|工作区|文档)/i.test(prompt)
  const chineseReverseAction = /(?:文件|目录|文件夹|代码|仓库|项目|配置|脚本|工作区|文档).{0,20}(?:读取|查看|检查|列出|搜索|修改|编辑|写入|创建|生成|保存|提交|推送|启动|运行|构建|测试)/i.test(prompt)
  const chineseCommand = /(?:运行|执行|启动|构建|编译|测试|安装|提交|推送|拉取|下载).{0,20}(?:命令|服务|项目|测试|构建|依赖|代码|仓库)/i.test(prompt)
  const englishAction = /\b(?:read|inspect|list|find|search|open|edit|write|create|update|build|compile|test|run|start|install|clone|push|pull)\b.{0,28}\b(?:file|files|folder|directory|project|repo|repository|command|service|app|package|code)\b/i.test(prompt)
  const fileMention = /\b[\w.-]+\.(?:json|ya?ml|md|txt|csv|ts|tsx|js|jsx|py|java|kt|html|css|docx?|xlsx?|pptx?)\b/i.test(prompt)
  return chineseAction || chineseReverseAction || chineseCommand || englishAction || fileMention
}

function hasReactProtocolPayload(content: string): boolean {
  const payload = stripThoughtTags(content)
  return /"(?:action|tool_calls|choice|final)"\s*:/i.test(payload) ||
    /(?:^|\n)\s*(?:action|行动|动作|final|最终答案)\s*[:：]/im.test(payload)
}

function resolveToolIntentPrompt(prompt: string, history: ConversationMessage[]): string {
  if (!/^\s*(?:继续|接着|接着做|继续执行|继续处理|重试|再试一次|continue|go on|retry)\s*[。.!！]?\s*$/i.test(prompt)) return prompt
  const previousRequest = [...history].reverse().find((message) => message.role === 'user' && message.content.trim() && message.content.trim() !== prompt.trim())
  return previousRequest ? previousRequest.content + '\n' + prompt : prompt
}

function looksLikeMalformedReactReply(content: string): boolean {
  return /(?:^|\n)\s*(?:thought|action|action\s*input|observation|final\s*answer|思考|行动|动作|行动输入|观察|最终答案)\s*[:：]/im.test(content) ||
    /```(?:json|react)?\s*\{/i.test(content) ||
    /"(?:action|tool_calls|choice|final)"\s*:/i.test(content) ||
    (/<\s*(?:think|thought)\s*>/i.test(content) && !hasReactProtocolPayload(content))
}

function inferNarrativeReadCall(text: string): ToolCall | undefined {
  const pathPattern = /(?:^|[\s`"'(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|(?:package\.json|requirements\.txt|pyproject\.toml|tsconfig\.json))(?=$|[\s`"'),:;])/gim
  const readIntent = /(?:read|inspect|check|look\s+at|open|查看|读取|检查|先看|查看当前|需要了解)/i
  const explicitNextStep = /(?:need\s+to|must|should|let\s+me|first|next|需要|必须|让我|先|接下来).{0,100}(?:read|inspect|check|look\s+at|open|查看|读取|检查)/is
  const candidates: Array<{ path: string; index: number; score: number }> = []
  for (const match of text.matchAll(pathPattern)) {
    const path = match[1].replaceAll('\\', '/')
    if (path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.includes('..')) continue
    const index = (match.index ?? 0) + match[0].lastIndexOf(match[1])
    const before = text.slice(Math.max(0, index - 300), index)
    const around = text.slice(Math.max(0, index - 300), Math.min(text.length, index + path.length + 180))
    let score = 0
    if (explicitNextStep.test(before)) score += 4
    if (readIntent.test(around)) score += 2
    if (/haven't\s+(?:read|checked)|尚未|还没/i.test(around)) score += 1
    if (score) candidates.push({ path, index, score })
  }
  const selected = candidates.sort((left, right) => right.score - left.score || left.index - right.index)[0]
  return selected ? { name: 'read_file', arguments: { path: selected.path } } : undefined
}

function buildReactCorrectionPrompt(missingRequiredAction: boolean): string {
  return [
    'FORMAT_ERROR：上一条响应没有被宿主执行。',
    missingRequiredAction
      ? '当前用户任务需要实际读取、写入、检查或执行，但你还没有输出 Action，也没有收到任何 Observation。'
      : '上一条响应不是可解析的 ReAct JSON，不能把计划、解释或未验证结果当作 Final。',
    '请立刻只返回一个合法 JSON 对象，不要 Markdown、代码块、XML、前后解释，也不要返回多个对象。',
    '需要工具时严格使用：{"thought":"准备执行的简短计划","action":{"name":"工具名","arguments":{}}}',
    '任务完成时严格使用：{"thought":"已根据 Observation 完成验证","final":"给用户的答复"}',
    '每轮只能有 action、choice、final 三者之一；输出 action 后立即停止，等待宿主发送 Observation。'
  ].join('\n')
}

function sanitizeThoughtBeforeAction(thought: string): string {
  const completionPattern = /(?:已(?:经)?(?:成功)?(?:创建|写入|生成|完成|修改|实现|运行|确认)|(?:创建|写入|生成|修改|实现|运行)成功|任务已完成)/i
  const segments = sanitizeThoughtText(thought).split(/[。！？.!?\n]/)
  const planned = segments.filter((segment) => !completionPattern.test(segment))
  const result = planned.join('。').trim()
  return result || '准备执行所需工具。'
}

function sanitizeThoughtText(thought: string): string {
  return stripThoughtTags(thought).replace(THOUGHT_TAG_PATTERN, '').trim()
}

function sanitizeAssistantText(text: string): string {
  const sanitized = sanitizeThoughtText(text)
  return sanitized || '模型未按 ReAct 协议返回最终结果，原始思考内容已隐藏。'
}

function formatThoughtDetail(thought: string): string {
  const normalized = thought.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_DISPLAYED_THOUGHT_CHARACTERS
    ? normalized
    : normalized.slice(0, MAX_DISPLAYED_THOUGHT_CHARACTERS - 1).trimEnd() + '…'
}

function explicitJsonThought(content: string): string {
  const payload = stripCodeFences(stripThoughtTags(content)).trim()
  try {
    const value = JSON.parse(payload) as { thought?: unknown }
    return typeof value.thought === 'string' ? formatThoughtDetail(sanitizeThoughtText(value.thought)) : ''
  } catch {
    return ''
  }
}

function modelReplyForHistory(reply: ReactModelReply, originalContent: string): string {
  const thought = typeof reply.thought === 'string' ? formatThoughtDetail(sanitizeThoughtText(reply.thought)) : ''
  const prefix = thought ? { thought } : {}
  if (reply.action) return JSON.stringify({ ...prefix, action: reply.action })
  if (reply.tool_calls?.length) return JSON.stringify({ ...prefix, tool_calls: reply.tool_calls })
  if (reply.choice) return JSON.stringify({ ...prefix, choice: reply.choice })
  if (typeof reply.final === 'string') return JSON.stringify({ ...prefix, final: reply.final })
  return stripThoughtTags(originalContent).trim()
}

function isIncompleteFinal(finalText: string): boolean {
  return /(?:请|需要).{0,16}(?:提供|返回).{0,12}(?:工具|Observation|结果)|(?:等待|获取).{0,12}(?:工具|Observation).{0,12}(?:结果|返回)|(?:任务|项目|构建|验证|修复|定位).{0,8}(?:尚未|未).{0,8}(?:完成|结束|通过|解决)|(?:还需|需要继续|将继续).{0,12}(?:创建|写入|检查|执行|完成)/i.test(finalText)
}

function looksLikeIncompleteToolCall(content: string): boolean {
  const payload = stripThoughtTags(content)
  if (!/"(?:action|tool_calls)"\s*:/.test(payload)) return false
  const toolName = /"name"\s*:\s*"([^"]+)"/.exec(payload)?.[1]
  return Boolean(toolName && isToolName(normalizeToolName(toolName)))
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replaceAll('-', '_')
}

function commandSignature(command: string, args: string[]): string {
  return command.trim().toLowerCase() + '\n' + JSON.stringify(args)
}

function extractWebUrls(text: string, localOnly: boolean): string[] {
  const ansiEscapePattern = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g')
  const markdownLinkPattern = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi
  const sanitized = text.replace(ansiEscapePattern, '').replace(markdownLinkPattern, '$1')
  const matches = sanitized.match(/https?:\/\/[^\s<>"'`()\u005b\u005d]+/gi) ?? []
  const urls = new Set<string>()
  for (const match of matches) {
    try {
      const url = new URL(match.replace(/[),.;\]，。；]+$/, ''))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (localOnly && !isLocalServiceHost(url.hostname)) continue
      if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') url.hostname = 'localhost'
      urls.add(url.toString())
    } catch {
      /* 忽略无法解析的模型或命令输出片段。 */
    }
  }
  return [...urls]
}

function isLocalServiceHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || host.endsWith('.local')) return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  const private172 = /^172\.(\d{1,2})\./.exec(host)
  return private172 ? Number(private172[1]) >= 16 && Number(private172[1]) <= 31 : false
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
      description: typeof option.description === 'string' && option.description.trim() ? option.description.trim().slice(0, 600) : undefined,
      workspacePath: typeof option.workspacePath === 'string' && option.workspacePath.trim() ? option.workspacePath.trim().slice(0, 1000) : undefined
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

function normalizedTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function estimateTokenCount(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  if (!text) return 0
  const cjkCount = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  return Math.max(1, Math.ceil(cjkCount + (text.length - cjkCount) / 4))
}

function isRecoverableToolError(error: unknown, toolName?: ToolCall['name']): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/工具未启用|工具调用参数修复失败|工具调用无法执行/.test(message)) return false
  if (toolName === 'run_command' || toolName === 'start_service' || toolName === 'decrypt_file' || toolName === 'parse_word' || toolName === 'parse_excel' || toolName === 'parse_powerpoint') return true
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
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
    const thoughtText = formatThoughtDetail(this.extractStringField('thought', stripThoughtTags(this.buffer)))
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
