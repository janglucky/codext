import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { ReactAgent } from './agent/react-agent'
import type { AppSettings, ChatMessage } from '../shared/types'
import { LocalStore } from './persistence/store'

const store = new LocalStore()
const agent = new ReactAgent(() => store.getSettings(), () => store.getPolicy())

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
  ipcMain.handle('agent:run', async (event, conversationId: string, prompt: string) => {
    if (!prompt.trim()) throw new Error('请输入任务')
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt.trim(), createdAt: new Date().toISOString() }
    await store.addMessage(conversationId, userMessage)
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString(), status: 'acting', steps: [] }
    await store.addMessage(conversationId, assistantMessage)
    const conversationBeforeRun = store.getConversation(conversationId)
    const history = conversationBeforeRun.messages
      .filter((message) => message.id !== assistantMessage.id)
      .slice(0, -1)
      .map((message) => ({ role: message.role, content: message.content }))
    const task = await agent.run(prompt.trim(), history, (taskStep) => {
      assistantMessage.steps = upsertStep(assistantMessage.steps ?? [], taskStep)
      event.sender.send('agent:step', { conversationId, messageId: assistantMessage.id, step: taskStep })
    }, (delta) => {
      assistantMessage.content += delta
      event.sender.send('agent:delta', { conversationId, messageId: assistantMessage.id, delta })
    })
    assistantMessage.content = task.result ?? task.error ?? ''
    assistantMessage.status = task.status
    assistantMessage.steps = task.steps
    assistantMessage.completedAt = new Date().toISOString()
    event.sender.send('agent:done', { conversationId, messageId: assistantMessage.id, status: assistantMessage.status, content: assistantMessage.content, completedAt: assistantMessage.completedAt })
    const conversation = await store.updateMessage(conversationId, assistantMessage)
    return { conversation, task }
  })
  ipcMain.handle('conversations:list', () => store.getConversations())
  ipcMain.handle('conversations:create', () => store.createConversation())
  ipcMain.handle('conversations:delete', (_event, conversationId: string) => store.deleteConversation(conversationId))
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

function upsertStep<T extends { id: string }>(steps: T[], nextStep: T): T[] {
  const index = steps.findIndex((item) => item.id === nextStep.id)
  if (index < 0) return [...steps, nextStep]
  return steps.map((item) => item.id === nextStep.id ? nextStep : item)
}
