import { contextBridge, ipcRenderer } from 'electron'
import type { AgentPolicy, AppSettings, DesktopApi } from '../shared/types'

const api: DesktopApi = {
  runTask: (conversationId, prompt, attachments) => ipcRenderer.invoke('agent:run', conversationId, prompt, attachments),
  cancelTask: (conversationId) => ipcRenderer.send('agent:cancel', conversationId),
  getConversations: () => ipcRenderer.invoke('conversations:list'),
  createConversation: () => ipcRenderer.invoke('conversations:create'),
  deleteConversation: (conversationId) => ipcRenderer.invoke('conversations:delete', conversationId),
  selectConversationWorkspace: (conversationId) => ipcRenderer.invoke('conversations:select-workspace', conversationId),
  resetConversationWorkspace: (conversationId) => ipcRenderer.invoke('conversations:reset-workspace', conversationId),
  removeConversationAttachment: (conversationId, attachmentId) => ipcRenderer.invoke('conversations:remove-attachment', conversationId, attachmentId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings),
  testConnection: (settings: AppSettings) => ipcRenderer.invoke('settings:test-connection', settings),
  getPolicy: () => ipcRenderer.invoke('policy:get'),
  savePolicy: (policy: AgentPolicy) => ipcRenderer.invoke('policy:save', policy),
  onAgentStep: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on('agent:step', listener)
    return () => ipcRenderer.off('agent:step', listener)
  },
  onAgentDelta: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on('agent:delta', listener)
    return () => ipcRenderer.off('agent:delta', listener)
  },
  onAgentDone: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on('agent:done', listener)
    return () => ipcRenderer.off('agent:done', listener)
  },
  onMcpApprovalRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on('mcp:approval-request', listener)
    return () => ipcRenderer.off('mcp:approval-request', listener)
  },
  respondMcpApproval: (requestId, approved) => {
    ipcRenderer.send('mcp:approval-response', requestId, approved)
  },
  onUserChoiceRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on('choice:request', listener)
    return () => ipcRenderer.off('choice:request', listener)
  },
  respondUserChoice: (requestId, optionId) => {
    ipcRenderer.send('choice:response', requestId, optionId)
  }
}
contextBridge.exposeInMainWorld('api', api)
