import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { join, resolve } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { ReactAgent } from './agent/react-agent'
import type { AppSettings, ChatAttachment, ChatMessage, Conversation } from '../shared/types'
import {
  isImageAttachmentType,
  isOfficeAttachmentType,
  isSupportedAttachmentType,
  isTextAttachmentType,
  MAX_ATTACHMENT_COUNT,
  MAX_IMAGE_ATTACHMENT_SIZE,
  MAX_OFFICE_ATTACHMENT_SIZE,
  MAX_TEXT_ATTACHMENT_SIZE,
  MAX_TOTAL_ATTACHMENT_SIZE
} from '../shared/attachments'
import { LocalStore } from './persistence/store'
import { copyConversationAttachments, materializeOfficeAttachments } from './attachment-storage'
import { McpApprovalManager } from './mcp-approval'
import { UserChoiceManager } from './user-choice'
import { startPptMcpServer, type RunningPptMcpServer } from './ppt/ppt-mcp-server'

const store = new LocalStore()
let pptMcpUrl = ''
const agent = new ReactAgent(() => store.getSettings(), () => store.getPolicy(), () => pptMcpUrl)
const mcpApprovalManager = new McpApprovalManager()
const userChoiceManager = new UserChoiceManager()
const runningTasks = new Map<string, AbortController>()
let pptMcpServer: RunningPptMcpServer | undefined

function createWindow(): void {
  const window = new BrowserWindow({ width: 1240, height: 820, minWidth: 960, minHeight: 640, show: false, autoHideMenuBar: true, webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false } })
  window.once('ready-to-show', () => window.show())
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => console.error('[renderer]', { level, message, line, sourceId }))
  window.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => console.error('[renderer load failed]', { code, description, validatedUrl }))
  if (is.dev && process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await store.load()
  pptMcpServer = await startPptMcpServer(resolveAllowedPptWorkspace)
  pptMcpUrl = pptMcpServer.url
  ipcMain.on('mcp:approval-response', (event, requestId: unknown, approved: unknown) => {
    if (typeof requestId !== 'string' || typeof approved !== 'boolean') return
    mcpApprovalManager.respond(event.sender.id, requestId, approved)
  })
  ipcMain.on('agent:cancel', (event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') return
    runningTasks.get(taskKey(event.sender.id, conversationId))?.abort()
    mcpApprovalManager.cancelTarget(event.sender.id)
    userChoiceManager.cancelTarget(event.sender.id)
  })
  ipcMain.on('choice:response', (event, requestId: unknown, optionId: unknown) => {
    if (typeof requestId !== 'string' || (optionId !== undefined && typeof optionId !== 'string')) return
    userChoiceManager.respond(event.sender.id, requestId, optionId)
  })
  ipcMain.handle('agent:run', async (event, conversationId: string, prompt: string, attachments: unknown = []) => {
    const key = taskKey(event.sender.id, conversationId)
    runningTasks.get(key)?.abort()
    const controller = new AbortController()
    runningTasks.set(key, controller)
    try {
    const conversationAtStart = store.getConversation(conversationId)
    const workspacePath = effectiveWorkspacePath(conversationAtStart)
    const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : ''
    const validatedAttachments = validateAttachments(attachments)
    const normalizedNewAttachments = await materializeOfficeAttachments(validatedAttachments, workspacePath)
    const normalizedAttachments = mergeConversationAttachments(conversationAtStart.activeAttachments ?? [], normalizedNewAttachments)
    if (!normalizedPrompt && !normalizedAttachments.length) throw new Error('请输入任务或添加附件')
    if (normalizedNewAttachments.length) await store.setConversationAttachments(conversationId, normalizedAttachments)
    const agentPrompt = normalizedPrompt || '请查看附件并根据附件内容提供帮助。'
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: normalizedPrompt,
      attachments: normalizedNewAttachments.length ? normalizedNewAttachments : undefined,
      createdAt: new Date().toISOString()
    }
    await store.addMessage(conversationId, userMessage)
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString(), status: 'acting', steps: [] }
    await store.addMessage(conversationId, assistantMessage)
    const conversationBeforeRun = store.getConversation(conversationId)
    const historyMessages = conversationBeforeRun.messages
      .filter((message) => message.id !== assistantMessage.id)
      .slice(0, -1)
    for (const message of historyMessages) {
      if (!message.attachments?.length) continue
      const materialized = await materializeOfficeAttachments(message.attachments, workspacePath)
      if (materialized === message.attachments) continue
      message.attachments = materialized
      await store.updateMessage(conversationId, message)
    }
    const history = historyMessages.map((message) => ({ role: message.role, content: historyContent(message), attachments: message.attachments }))
    const task = await agent.run(agentPrompt, history, (taskStep) => {
      assistantMessage.steps = upsertStep(assistantMessage.steps ?? [], taskStep)
      event.sender.send('agent:step', { conversationId, messageId: assistantMessage.id, step: taskStep })
    }, (delta) => {
      assistantMessage.content += delta
      event.sender.send('agent:delta', { conversationId, messageId: assistantMessage.id, delta })
    }, normalizedAttachments, (request) => mcpApprovalManager.request(event.sender, { ...request, conversationId }), controller.signal, workspacePath, (request) => userChoiceManager.request(event.sender, { ...request, conversationId }))
    assistantMessage.content = task.status === 'paused' && assistantMessage.content.trim()
      ? assistantMessage.content.trimEnd() + '\n\n[已暂停]'
      : task.result ?? task.error ?? ''
    assistantMessage.status = task.status
    assistantMessage.steps = task.steps
    assistantMessage.completedAt = new Date().toISOString()
    event.sender.send('agent:done', { conversationId, messageId: assistantMessage.id, status: assistantMessage.status, content: assistantMessage.content, completedAt: assistantMessage.completedAt })
    const conversation = await store.updateMessage(conversationId, assistantMessage)
    return { conversation, task }
    } finally {
      if (runningTasks.get(key) === controller) runningTasks.delete(key)
    }
  })
  ipcMain.handle('conversations:list', () => store.getConversations())
  ipcMain.handle('conversations:create', () => store.createConversation())
  ipcMain.handle('conversations:delete', (_event, conversationId: string) => store.deleteConversation(conversationId))
  ipcMain.handle('conversations:select-workspace', async (event, conversationId: string) => {
    const conversation = store.getConversation(conversationId)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择当前会话的工作区',
      defaultPath: effectiveWorkspacePath(conversation),
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return conversation
    const selectedPath = resolve(result.filePaths[0])
    const globalPath = resolve(store.getPolicy().workspacePath)
    await copyConversationAttachments(conversation, effectiveWorkspacePath(conversation), selectedPath)
    return store.setConversationWorkspace(conversationId, workspaceKey(selectedPath) === workspaceKey(globalPath) ? undefined : selectedPath)
  })
  ipcMain.handle('conversations:reset-workspace', async (_event, conversationId: string) => {
    const conversation = store.getConversation(conversationId)
    await copyConversationAttachments(conversation, effectiveWorkspacePath(conversation), resolve(store.getPolicy().workspacePath))
    return store.setConversationWorkspace(conversationId)
  })
  ipcMain.handle('conversations:remove-attachment', async (_event, conversationId: string, attachmentId: string) => {
    const conversation = store.getConversation(conversationId)
    return store.setConversationAttachments(conversationId, (conversation.activeAttachments ?? []).filter((attachment) => attachment.id !== attachmentId))
  })
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:save', (_event, settings: AppSettings) => store.saveSettings(settings))
  ipcMain.handle('policy:get', () => store.getPolicy())
  ipcMain.handle('policy:save', (_event, policy) => store.savePolicy(policy))
  ipcMain.handle('settings:test-connection', async (_event, settings: AppSettings) => {
    const { baseUrl, apiKey, model, timeoutMs } = settings.model
    if (!baseUrl.trim() || !model.trim()) return { ok: false, message: '请先填写接口地址和模型名称。' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const endpoint = baseUrl.replace(/\/$/, '') + '/chat/completions'
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey.trim()) headers.Authorization = 'Bearer ' + apiKey
      const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) })
      if (!response.ok) return { ok: false, message: '连接失败（HTTP ' + response.status + '）。请检查接口地址、模型和密钥。' }
      return { ok: true, message: '连接成功，模型服务可用。' }
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? '连接超时，请检查服务地址和网络。' : '无法连接到模型服务，请检查网络和接口配置。'
      return { ok: false, message }
    } finally { clearTimeout(timer) }
  })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  for (const controller of runningTasks.values()) controller.abort()
  runningTasks.clear()
  mcpApprovalManager.cancelAll()
  userChoiceManager.cancelAll()
  if (pptMcpServer) void pptMcpServer.close().catch((error) => console.error('[ppt mcp close failed]', error))
})

function taskKey(senderId: number, conversationId: string): string {
  return senderId + ':' + conversationId
}

function effectiveWorkspacePath(conversation: Conversation): string {
  return resolve(conversation.workspacePath?.trim() || store.getPolicy().workspacePath)
}

function resolveAllowedPptWorkspace(requestedWorkspacePath?: string): string {
  const globalWorkspacePath = resolve(store.getPolicy().workspacePath)
  if (!requestedWorkspacePath) return globalWorkspacePath
  const requested = resolve(requestedWorkspacePath)
  const requestedKey = workspaceKey(requested)
  const allowed = requestedKey === workspaceKey(globalWorkspacePath) || store.getConversations().some((conversation) => workspaceKey(effectiveWorkspacePath(conversation)) === requestedKey)
  if (!allowed) throw new Error('PPT MCP 拒绝访问未授权的会话工作区。')
  return requested
}

function workspaceKey(workspacePath: string): string {
  const normalized = resolve(workspacePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function mergeConversationAttachments(current: ChatAttachment[], added: ChatAttachment[]): ChatAttachment[] {
  if (!added.length) return current
  const merged = [...current]
  for (const attachment of added) {
    const duplicateIndex = merged.findIndex((item) => item.id === attachment.id || (item.name === attachment.name && item.size === attachment.size && item.mimeType === attachment.mimeType))
    if (duplicateIndex >= 0) merged[duplicateIndex] = attachment
    else merged.push(attachment)
  }
  if (merged.length > MAX_ATTACHMENT_COUNT) throw new Error('当前会话最多只能保留 ' + MAX_ATTACHMENT_COUNT + ' 个附件，请先移除不需要的附件。')
  if (merged.reduce((total, attachment) => total + attachment.size, 0) > MAX_TOTAL_ATTACHMENT_SIZE) throw new Error('当前会话附件总大小不能超过限制，请先移除不需要的附件。')
  return merged
}

function upsertStep<T extends { id: string }>(steps: T[], nextStep: T): T[] {
  const index = steps.findIndex((item) => item.id === nextStep.id)
  if (index < 0) return [...steps, nextStep]
  return steps.map((item) => item.id === nextStep.id ? nextStep : item)
}

function historyContent(message: ChatMessage): string {
  if (message.role !== 'assistant' || !message.steps?.length) return message.content
  const trace = message.steps
    .filter((item) => item.phase === 'act')
    .map((item) => item.title + ': ' + item.detail)
    .join('\n')
  return [message.content, trace ? 'Previous execution trace:\n' + trace : ''].filter(Boolean).join('\n\n')
}

function validateAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return []
  if (value.length > MAX_ATTACHMENT_COUNT) throw new Error('附件最多只能添加 ' + MAX_ATTACHMENT_COUNT + ' 个')

  let totalSize = 0
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('第 ' + (index + 1) + ' 个附件无效')
    const candidate = item as Partial<ChatAttachment>
    const name = typeof candidate.name === 'string' ? sanitizeAttachmentName(candidate.name) : ''
    const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType.toLowerCase() : ''
    const dataUrl = typeof candidate.dataUrl === 'string' ? candidate.dataUrl : ''
    if (!name || !isSupportedAttachmentType(mimeType, name)) throw new Error('不支持的附件类型：' + (name || '未知文件'))

    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
    if (!match || match[1].toLowerCase() !== mimeType) throw new Error('附件数据无效：' + name)
    const size = Buffer.byteLength(match[2], 'base64')
    const maxSize = isImageAttachmentType(mimeType)
      ? MAX_IMAGE_ATTACHMENT_SIZE
      : isOfficeAttachmentType(mimeType, name)
        ? MAX_OFFICE_ATTACHMENT_SIZE
        : MAX_TEXT_ATTACHMENT_SIZE
    if (!isImageAttachmentType(mimeType) && !isTextAttachmentType(mimeType, name) && !isOfficeAttachmentType(mimeType, name)) throw new Error('不支持的附件类型：' + name)
    if (size <= 0 || size > maxSize) throw new Error('附件大小超出限制：' + name)
    totalSize += size
    if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) throw new Error('附件总大小超出限制')

    return {
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id.slice(0, 100) : crypto.randomUUID(),
      name,
      mimeType,
      size,
      dataUrl
    }
  })
}

function sanitizeAttachmentName(name: string): string {
  const forbidden = '<>:"/\\|?*'
  return Array.from(name, (character) => character.charCodeAt(0) < 32 || forbidden.includes(character) ? '_' : character).join('').trim().slice(0, 180)
}
