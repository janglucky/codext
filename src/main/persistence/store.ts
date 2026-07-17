import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentPolicy, AgentTask, AppSettings, ChatMessage, Conversation } from '../../shared/types'

interface PersistedState { settings: AppSettings; policy: AgentPolicy; conversations: Conversation[] }
type PersistedStateDraft = Partial<PersistedState> & {
  settings?: Partial<AppSettings> & { model?: Partial<AppSettings['model']> }
  policy?: Partial<AgentPolicy>
  tasks?: AgentTask[]
}

export const defaults: AppSettings = { model: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4.1-mini', timeoutMs: 300000, maxRetries: 3 }, skillsEnabled: true }
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
const legacyEnabledTools = ['read_file', 'write_file', 'run_command']
const previousDefaultEnabledTools = ['read_file', 'write_file', 'create_directory', 'list_files', 'decrypt_file', 'run_command']
export const defaultPolicy: AgentPolicy = {
  systemPrompt: [
    '你是 Codext Agent，一个运行在 Windows 桌面工作区内的工程代理。',
    '你必须遵循 ReAct 模式：先判断是否需要工具，再执行一个明确动作，读取 Observation 后继续下一轮，直到可以给出 Final。',
    '你可以读取文件、写入文件、创建目录、列举文件、解密文件、在本地解析 Word 和 Excel、通过需用户单次授权的 PPT MCP 解析 PowerPoint，以及执行命令行；所有文件操作必须限制在工作区内。',
    '执行命令前只选择必要且低风险的命令；遇到删除、格式化、关机、修改注册表等危险操作必须拒绝。',
    '最终答复要简洁、可验证，并说明实际完成了什么。'
  ].join('\n'),
  workspacePath: 'D:/work/codext',
  enabledTools: ['read_file', 'write_file', 'create_directory', 'list_files', 'decrypt_file', 'parse_word', 'parse_excel', 'parse_powerpoint', 'run_command']
}

/** 返回当前时间的 ISO 8601 字符串，用于时间戳字段的统一格式。 */
export const now = (): string => new Date().toISOString()
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
      const settings: AppSettings = {
        model: { ...defaults.model, ...draft.settings?.model },
        skillsEnabled: draft.settings?.skillsEnabled ?? defaults.skillsEnabled
      }
      settings.model.timeoutMs = Math.max(settings.model.timeoutMs, defaults.model.timeoutMs)
      this.state = {
        settings,
        policy: {
          ...defaultPolicy,
          ...draft.policy,
          systemPrompt: draft.policy?.systemPrompt === legacySystemPrompt || draft.policy?.systemPrompt === previousOfficeMcpSystemPrompt || draft.policy?.systemPrompt === previousLocalOfficeSystemPrompt
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

  async saveSettings(settings: AppSettings): Promise<AppSettings> { this.state.settings = settings; await this.save(); return settings }
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

  async setConversationAttachments(conversationId: string, attachments: ChatMessage['attachments']): Promise<Conversation> {
    const conversation = this.ensureConversation(conversationId)
    if (attachments?.length) conversation.activeAttachments = attachments
    else delete conversation.activeAttachments
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
    if (draft.conversations?.length) return draft.conversations.map((conversation) => ({
      ...conversation,
      activeAttachments: conversation.activeAttachments?.length
        ? conversation.activeAttachments
        : [...conversation.messages].reverse().find((message) => message.role === 'user' && message.attachments?.length)?.attachments
    }))
    if (draft.tasks?.length) return [this.conversationFromTasks(draft.tasks)]
    return [newConversation()]
  }

  private conversationFromTasks(tasks: AgentTask[]): Conversation {
    const createdAt = tasks[tasks.length - 1]?.createdAt ?? now()
    const messages = tasks.flatMap((task): ChatMessage[] => [
      { id: crypto.randomUUID(), role: 'user', content: task.prompt, createdAt: task.createdAt },
      { id: crypto.randomUUID(), role: 'assistant', content: task.result ?? task.error ?? '', createdAt: task.createdAt, status: task.status, steps: task.steps }
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
  return isLegacyDefault || isPreviousDefault ? defaultPolicy.enabledTools : enabledTools
}
