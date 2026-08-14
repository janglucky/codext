import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentPolicy, AgentTask, AppSettings, ChatMessage, Conversation, ModelConfig, ModelProfile, PermissionMode } from '../../shared/types'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, LEGACY_MODEL_ID, getModelProfiles } from '../../shared/models'
import { isInternalAgentPlaceholder } from '../../shared/text'

interface PersistedState { settings: AppSettings; policy: AgentPolicy; conversations: Conversation[] }
type SettingsDraft = Omit<Partial<AppSettings>, 'model' | 'navigation'> & {
  model?: Partial<AppSettings['model']>
  navigation?: Partial<AppSettings['navigation']>
}
type PersistedStateDraft = Partial<PersistedState> & {
  settings?: SettingsDraft
  policy?: Partial<AgentPolicy>
  tasks?: AgentTask[]
}

const defaultModelConfig: ModelConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4.1-mini', timeoutMs: 300000, maxRetries: 3, contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS }
const defaultModelProfile: ModelProfile = { id: LEGACY_MODEL_ID, name: 'OpenAI', provider: 'OpenAI', ...defaultModelConfig }

export const defaults: AppSettings = {
  model: defaultModelConfig,
  models: [defaultModelProfile],
  defaultModelId: defaultModelProfile.id,
  skillsEnabled: true,
  permissionMode: 'request_approval',
  navigation: { fileApplicationPath: '', browserApplicationPath: '' }
}

function normalizeSettings(settings?: SettingsDraft): AppSettings {
  const legacyConfig = { ...defaultModelConfig, ...settings?.model }
  const rawProfiles = settings?.models?.length
    ? settings.models
    : [{ ...legacyConfig, id: LEGACY_MODEL_ID, name: legacyConfig.model || '默认模型', provider: 'OpenAI 兼容' }]
  const usedIds = new Set<string>()
  const profiles = rawProfiles.map((profile, index): ModelProfile => {
    const requestedId = typeof profile.id === 'string' && profile.id.trim() ? profile.id.trim() : 'model-' + (index + 1)
    let id = requestedId
    let suffix = 2
    while (usedIds.has(id)) id = requestedId + '-' + suffix++
    usedIds.add(id)
    const contextWindowTokens = normalizeTokenLimit(profile.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS, 4096, 4_000_000)
    const maxOutputTokens = Math.min(
      normalizeTokenLimit(profile.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 256, 1_000_000),
      Math.floor(contextWindowTokens * 0.5)
    )
    const model = {
      baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : defaultModelConfig.baseUrl,
      apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : '',
      model: typeof profile.model === 'string' ? profile.model : '',
      timeoutMs: Math.max(Number.isFinite(profile.timeoutMs) ? profile.timeoutMs : defaultModelConfig.timeoutMs, defaultModelConfig.timeoutMs),
      maxRetries: Math.max(Number.isFinite(profile.maxRetries) ? profile.maxRetries : defaultModelConfig.maxRetries, 0),
      contextWindowTokens,
      maxOutputTokens
    }
    return { ...model, id, name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : model.model || '模型 ' + (index + 1), provider: typeof profile.provider === 'string' && profile.provider.trim() ? profile.provider.trim() : 'OpenAI 兼容' }
  })
  const defaultModelId = typeof settings?.defaultModelId === 'string' && profiles.some((profile) => profile.id === settings.defaultModelId)
    ? settings.defaultModelId
    : profiles[0].id
  const selected = profiles.find((profile) => profile.id === defaultModelId) ?? profiles[0]
  const normalized: AppSettings = {
    model: modelConfigFromProfile(selected),
    models: profiles,
    defaultModelId,
    skillsEnabled: settings?.skillsEnabled ?? defaults.skillsEnabled,
    permissionMode: normalizePermissionMode(settings?.permissionMode),
    navigation: {
      fileApplicationPath: typeof settings?.navigation?.fileApplicationPath === 'string' ? settings.navigation.fileApplicationPath : '',
      browserApplicationPath: typeof settings?.navigation?.browserApplicationPath === 'string' ? settings.navigation.browserApplicationPath : ''
    }
  }
  return normalized
}

function normalizePermissionMode(value: PermissionMode | undefined): PermissionMode {
  return value === 'full_access' || value === 'auto_approve' || value === 'request_approval'
    ? value
    : 'request_approval'
}

function modelConfigFromProfile(profile: ModelProfile): ModelConfig {
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    maxRetries: profile.maxRetries,
    contextWindowTokens: profile.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  }
}

function normalizeTokenLimit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback, minimum), maximum)
}
const legacySystemPrompt = '你是 Codext Agent。你在 Windows 桌面工作区中协助用户完成任务。优先使用可用工具读取、写入和检查文件；执行命令前说明目的；绝不访问工作区外的文件；遇到危险或破坏性命令必须拒绝。输出简洁、可验证的结果。'
const previousOfficeMcpSystemPrompt = [
  '你是 Codext Agent，一个运行在 Windows 桌面工作区内的工程代理。',
  '你必须遵循 ReAct 模式：先判断是否需要工具，再执行一个明确动作，读取 Observation 后继续下一轮，直到可以给出 Final。',
  '你可以读取文件、写入文件、创建目录、列举文件、解密文件、通过 MCP 解析 Office 文档和执行命令行，但所有文件操作必须限制在工作区内。',
  '执行命令前只选择必要且低风险的命令；遇到删除、格式化、关机、修改注册表等危险操作必须拒绝。',
  '最终答复要简洁、可验证，并说明实际完成了什么。'
].join('\n')
const previousLocalOfficeSystemPrompt = [
  '你是 Codext Agent，一个运行在 Windows 桌面工作区内的工程代理。',
  '你必须遵循 ReAct 模式：先判断是否需要工具，再执行一个明确动作，读取 Observation 后继续下一轮，直到可以给出 Final。',
  '你可以读取文件、写入文件、创建目录、列举文件、解密文件、在本地解析 Office 文档和执行命令行，但所有文件操作必须限制在工作区内。',
  '执行命令前只选择必要且低风险的命令；遇到删除、格式化、关机、修改注册表等危险操作必须拒绝。',
  '最终答复要简洁、可验证，并说明实际完成了什么。'
].join('\n')
const previousServiceSystemPrompt = [
  '你是 Codext Agent，一个运行在 Windows 桌面工作区内的工程代理。',
  '你必须遵循 ReAct 模式：先判断是否需要工具，再执行一个明确动作，读取 Observation 后继续下一轮，直到可以给出 Final。',
  '你可以读取文件、写入文件、创建目录、列举文件、解密文件、在本地解析 Word 和 Excel、通过需用户单次授权的 PPT MCP 解析 PowerPoint，以及执行命令行；所有文件操作必须限制在工作区内。',
  '执行命令前只选择必要且低风险的命令；遇到删除、格式化、关机、修改注册表等危险操作必须拒绝。',
  '最终答复要简洁、可验证，并说明实际完成了什么。'
].join('\n')
const previousPermissionSystemPrompt = [
  '你是 Codext Agent，一个运行在 Windows 桌面工作区内的工程代理。',
  '你必须遵循 ReAct 模式：先判断是否需要工具，再执行一个明确动作，读取 Observation 后继续下一轮，直到可以给出 Final。',
  '你可以读取、写入或局部编辑文件、创建目录、列举文件、解密文件、在本地解析 Word 和 Excel、通过需用户单次授权的 PPT MCP 解析 PowerPoint，以及执行命令行；所有文件操作必须限制在工作区内。',
  '执行命令前只选择必要且低风险的命令；遇到删除、格式化、关机、修改注册表等危险操作必须拒绝。',
  '最终答复要简洁、可验证，并说明实际完成了什么。'
].join('\n')
const previousFixedWindowsSystemPrompt = [
  '你是 Codext Agent，一个运行在 Windows 桌面工作区内的工程代理。',
  '你必须遵循 ReAct 模式：先判断是否需要工具，再执行一个明确动作，读取 Observation 后继续下一轮，直到可以给出 Final。',
  '你可以读取、写入或局部编辑文件、创建目录、列举文件、解密文件、在本地解析 Word 和 Excel、通过 PPT MCP 解析 PowerPoint，以及执行命令行；文件、网络和命令权限由宿主按照用户选择的权限模式统一裁决。',
  '需要操作时直接输出对应工具调用；不要自行声称没有权限，也不要在工具调用前用文字请求批准，宿主会在需要时显示交互确认。',
  '最终答复要简洁、可验证，并说明实际完成了什么。'
].join('\n')
const legacyEnabledTools = ['read_file', 'write_file', 'run_command']
const previousDefaultEnabledTools = ['read_file', 'write_file', 'create_directory', 'list_files', 'decrypt_file', 'run_command']
const previousOfficeDefaultEnabledTools = ['read_file', 'write_file', 'create_directory', 'list_files', 'decrypt_file', 'parse_word', 'parse_excel', 'parse_powerpoint', 'run_command']
const previousServiceDefaultEnabledTools = [...previousOfficeDefaultEnabledTools, 'start_service']
export const defaultPolicy: AgentPolicy = {
  systemPrompt: [
    '你是 Codext Agent，一个运行在当前宿主环境中的工程代理。宿主会在运行时提供真实的操作系统与桌面会话信息。',
    '你必须遵循 ReAct 模式：先判断是否需要工具，再执行一个明确动作，读取 Observation 后继续下一轮，直到可以给出 Final。',
    '你可以读取、写入或局部编辑文件、创建目录、列举文件、解密文件、在本地解析 Word 和 Excel、通过 PPT MCP 解析 PowerPoint，以及执行命令行；文件、网络和命令权限由宿主按照用户选择的权限模式统一裁决。',
    '需要操作时直接输出对应工具调用；不要自行声称没有权限，也不要在工具调用前用文字请求批准，宿主会在需要时显示交互确认。',
    '最终答复要简洁、可验证，并说明实际完成了什么。'
  ].join('\n'),
  workspacePath: process.cwd(),
  enabledTools: ['read_file', 'write_file', 'edit_file', 'create_directory', 'list_files', 'decrypt_file', 'parse_word', 'parse_excel', 'parse_powerpoint', 'run_command', 'start_service']
}

/** 返回当前时间的 ISO 8601 字符串，用于时间戳字段的统一格式。 */
export const now = (): string => new Date().toISOString()
const activeTaskStatuses = new Set(['pending', 'reasoning', 'acting', 'validating'])

function normalizePersistedMessage(message: ChatMessage): ChatMessage {
  const filteredSteps = message.steps?.filter((item) => item.title !== '等待模型响应')
  const normalized = filteredSteps?.length !== message.steps?.length ? { ...message, steps: filteredSteps } : message
  if (normalized.role !== 'assistant') return normalized
  const protocolError = '模型未按 ReAct 协议返回最终结果，原始思考内容已隐藏。'
  if (isInternalAgentPlaceholder(normalized.content)) {
    return {
      ...normalized,
      content: '模型响应中断，任务尚未完成。请重试或继续本次任务。',
      status: 'failed',
      completedAt: normalized.completedAt ?? now()
    }
  }
  try {
    const payload = JSON.parse(normalized.content.trim()) as { thought?: unknown; action?: unknown; tool_calls?: unknown; choice?: unknown; final?: unknown }
    const thoughtOnly = typeof payload.thought === 'string' && payload.action === undefined && payload.tool_calls === undefined && payload.choice === undefined && payload.final === undefined
    if (thoughtOnly) {
      return { ...normalized, content: '模型仅返回了思考摘要，未继续执行所需动作。请重试本次任务。', status: 'failed', completedAt: normalized.completedAt ?? now() }
    }
  } catch {
    /* 普通助手文本不是 JSON，继续原有的历史兼容处理。 */
  }
  if (normalized.content.trim() === '[REACT_PROTOCOL_DRIFT]') {
    return { ...normalized, content: protocolError, status: 'failed', completedAt: normalized.completedAt ?? now() }
  }

  if (normalized.status && activeTaskStatuses.has(normalized.status)) {
    const interruptionNotice = '[应用重启，未完成的任务已暂停]'
    return {
      ...normalized,
      content: interruptionNotice,
      status: 'paused',
      completedAt: normalized.completedAt ?? now()
    }
  }

  if (!/^\s*<(?:think|thought)>/i.test(normalized.content)) return normalized
  if (!/<\s*\/\s*(?:think|thought)\s*>/i.test(normalized.content)) {
    return { ...normalized, content: protocolError, status: 'failed', completedAt: normalized.completedAt ?? now() }
  }
  const withoutThought = normalized.content
    .replace(/<\s*(?:think|thought)\s*>[\s\S]*?<\s*\/\s*(?:think|thought)\s*>/gi, '')
    .trim()
  let finalContent = withoutThought
  if (withoutThought.startsWith('{')) {
    try {
      const parsed = JSON.parse(withoutThought) as { final?: unknown }
      if (typeof parsed.final === 'string') finalContent = parsed.final
    } catch {
      /* 旧消息可能包含非 JSON 的最终文本。 */
    }
  }
  if (finalContent) return { ...normalized, content: finalContent }

  return { ...normalized, content: protocolError, status: 'failed', completedAt: normalized.completedAt ?? now() }
}

const newConversation = (title = '新对话'): Conversation => {
  const createdAt = now()
  return { id: crypto.randomUUID(), title, createdAt, updatedAt: createdAt, messages: [] }
}

export class LocalStore {
  private readonly path = join(app.getPath('userData'), 'agent-state.json')
  private state: PersistedState = { settings: defaults, policy: defaultPolicy, conversations: [newConversation()] }

  async load(): Promise<void> {
    try {
      const draft = JSON.parse(await readFile(this.path, 'utf8')) as PersistedStateDraft
      const settings = normalizeSettings(draft.settings)
      this.state = {
        settings,
        policy: {
          ...defaultPolicy,
          ...draft.policy,
          workspacePath: process.platform !== 'win32' && draft.policy?.workspacePath === 'D:/work/codext'
            ? process.cwd()
            : draft.policy?.workspacePath ?? defaultPolicy.workspacePath,
          systemPrompt: draft.policy?.systemPrompt === legacySystemPrompt || draft.policy?.systemPrompt === previousOfficeMcpSystemPrompt || draft.policy?.systemPrompt === previousLocalOfficeSystemPrompt || draft.policy?.systemPrompt === previousServiceSystemPrompt || draft.policy?.systemPrompt === previousPermissionSystemPrompt || draft.policy?.systemPrompt === previousFixedWindowsSystemPrompt
            ? defaultPolicy.systemPrompt
            : draft.policy?.systemPrompt ?? defaultPolicy.systemPrompt,
          enabledTools: normalizeEnabledTools(draft.policy?.enabledTools)
        },
        conversations: this.normalizeConversations(draft)
      }
      await this.save()
    } catch {
      await this.save()
    }
  }

  getSettings(): AppSettings { return this.state.settings }
  getPolicy(): AgentPolicy { return this.state.policy ?? defaultPolicy }
  getConversations(): Conversation[] { return this.state.conversations }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    this.state.settings = normalizeSettings(settings)
    const validModelIds = new Set(getModelProfiles(this.state.settings).map((profile) => profile.id))
    for (const conversation of this.state.conversations) {
      if (conversation.modelId && !validModelIds.has(conversation.modelId)) delete conversation.modelId
    }
    await this.save()
    return this.state.settings
  }
  async savePolicy(policy: AgentPolicy): Promise<AgentPolicy> { this.state.policy = policy; await this.save(); return policy }

  async createConversation(): Promise<Conversation> {
    const conversation = newConversation()
    this.state.conversations = [conversation, ...this.state.conversations]
    await this.save()
    return conversation
  }

  async deleteConversation(conversationId: string): Promise<Conversation[]> {
    this.state.conversations = this.state.conversations.filter((conversation) => conversation.id !== conversationId)
    if (!this.state.conversations.length) this.state.conversations = [newConversation()]
    await this.save()
    return this.state.conversations
  }

  async setConversationWorkspace(conversationId: string, workspacePath?: string): Promise<Conversation> {
    const conversation = this.ensureConversation(conversationId)
    if (workspacePath?.trim()) conversation.workspacePath = workspacePath.trim()
    else delete conversation.workspacePath
    conversation.updatedAt = now()
    this.bumpConversation(conversation.id)
    await this.save()
    return conversation
  }

  async setConversationModel(conversationId: string, modelId?: string): Promise<Conversation> {
    const conversation = this.ensureConversation(conversationId)
    if (modelId && !getModelProfiles(this.state.settings).some((profile) => profile.id === modelId)) throw new Error('找不到指定的模型配置。')
    if (modelId) conversation.modelId = modelId
    else delete conversation.modelId
    conversation.updatedAt = now()
    this.bumpConversation(conversation.id)
    await this.save()
    return conversation
  }

  async addMessage(conversationId: string, message: ChatMessage): Promise<Conversation> {
    const conversation = this.ensureConversation(conversationId)
    conversation.messages.push(message)
    conversation.updatedAt = now()
    if (message.role === 'user' && conversation.title === '新对话') {
      conversation.title = message.content.slice(0, 28) || message.attachments?.[0]?.name.slice(0, 28) || '新对话'
    }
    this.bumpConversation(conversation.id)
    await this.save()
    return conversation
  }

  async updateMessage(conversationId: string, message: ChatMessage): Promise<Conversation> {
    const conversation = this.ensureConversation(conversationId)
    const index = conversation.messages.findIndex((item) => item.id === message.id)
    if (index >= 0) conversation.messages[index] = message
    else conversation.messages.push(message)
    conversation.updatedAt = now()
    this.bumpConversation(conversation.id)
    await this.save()
    return conversation
  }

  getConversation(conversationId: string): Conversation {
    return this.ensureConversation(conversationId)
  }

  private normalizeConversations(draft: PersistedStateDraft): Conversation[] {
    if (draft.conversations?.length) return draft.conversations.map((conversation) => {
      const messages = conversation.messages.map(normalizePersistedMessage)
      const normalized = { ...conversation, messages } as Conversation & { activeAttachments?: ChatMessage['attachments'] }
      delete normalized.activeAttachments
      return normalized
    })
    if (draft.tasks?.length) return [this.conversationFromTasks(draft.tasks)]
    return [newConversation()]
  }

  private conversationFromTasks(tasks: AgentTask[]): Conversation {
    const createdAt = tasks[tasks.length - 1]?.createdAt ?? now()
    const messages = tasks.flatMap((task): ChatMessage[] => [
      { id: crypto.randomUUID(), role: 'user', content: task.prompt, createdAt: task.createdAt },
      { id: crypto.randomUUID(), role: 'assistant', content: task.result ?? task.error ?? '', createdAt: task.createdAt, status: task.status, steps: task.steps, artifacts: task.artifacts, tokenUsage: task.tokenUsage }
    ])
    return { id: crypto.randomUUID(), title: '历史任务', createdAt, updatedAt: tasks[0]?.createdAt ?? createdAt, messages }
  }

  private ensureConversation(conversationId: string): Conversation {
    const conversation = this.state.conversations.find((item) => item.id === conversationId)
    if (conversation) return conversation
    const fallback = newConversation()
    this.state.conversations.unshift(fallback)
    return fallback
  }

  private bumpConversation(conversationId: string): void {
    const conversation = this.ensureConversation(conversationId)
    this.state.conversations = [conversation, ...this.state.conversations.filter((item) => item.id !== conversationId)]
  }

  private async save(): Promise<void> {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.state, null, 2), 'utf8')
  }
}

function normalizeEnabledTools(enabledTools?: string[]): string[] {
  if (!enabledTools) return defaultPolicy.enabledTools
  const isLegacyDefault = enabledTools.length === legacyEnabledTools.length && legacyEnabledTools.every((tool) => enabledTools.includes(tool))
  const isPreviousDefault = enabledTools.length === previousDefaultEnabledTools.length && previousDefaultEnabledTools.every((tool) => enabledTools.includes(tool))
  const isPreviousOfficeDefault = enabledTools.length === previousOfficeDefaultEnabledTools.length && previousOfficeDefaultEnabledTools.every((tool) => enabledTools.includes(tool))
  const isPreviousServiceDefault = enabledTools.length === previousServiceDefaultEnabledTools.length && previousServiceDefaultEnabledTools.every((tool) => enabledTools.includes(tool))
  return isLegacyDefault || isPreviousDefault || isPreviousOfficeDefault || isPreviousServiceDefault ? defaultPolicy.enabledTools : enabledTools
}
