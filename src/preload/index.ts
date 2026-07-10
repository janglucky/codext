import { contextBridge, ipcRenderer } from 'electron'
import type { AgentPolicy, AppSettings, DesktopApi } from '../shared/types'

const api: DesktopApi = {
  runTask: (conversationId, prompt) => ipcRenderer.invoke('agent:run', conversationId, prompt),
  getConversations: () => ipcRenderer.invoke('conversations:list'),
  createConversation: () => ipcRenderer.invoke('conversations:create'),
  deleteConversation: (conversationId) => ipcRenderer.invoke('conversations:delete', conversationId),
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
  }
}
contextBridge.exposeInMainWorld('api', api)
