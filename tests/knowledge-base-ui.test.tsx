// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPolicy, AppSettings, Conversation, DesktopApi, KnowledgeBaseConfig } from '../src/shared/types'

Object.assign(globalThis, { React })
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { App } = await import('../src/renderer/src/App')

const knowledgeBase: KnowledgeBaseConfig = {
  name: '产品知识库',
  baseUrl: 'https://fastgpt.internal.example',
  apiKey: 'fastgpt-system-test',
  datasetId: 'dataset-123',
  apiMode: 'searchTest',
  limit: 5000,
  similarity: 0.5,
  searchMode: 'mixedRecall',
  usingReRank: false
}
const settings: AppSettings = {
  model: { baseUrl: 'https://api.example.com', apiKey: 'model-key', model: 'gpt-test', timeoutMs: 300000, maxRetries: 3 },
  skillsEnabled: true,
  navigation: { fileApplicationPath: '', browserApplicationPath: '' },
  knowledgeBase
}
const policy: AgentPolicy = { systemPrompt: 'test', workspacePath: 'C:/work', enabledTools: [] }
const conversation: Conversation = {
  id: 'conversation-1',
  title: '新对话',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messages: []
}

let container: HTMLDivElement
let root: Root
let setKnowledgeBaseEnabled: ReturnType<typeof vi.fn>
let saveSettings: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  setKnowledgeBaseEnabled = vi.fn(async (_conversationId: string, enabled: boolean) => ({ ...conversation, knowledgeBaseEnabled: enabled || undefined }))
  saveSettings = vi.fn(async (next: AppSettings) => next)
  const unsubscribe = (): void => undefined
  const api = {
    getConversations: vi.fn(async () => [conversation]),
    getSettings: vi.fn(async () => settings),
    saveSettings,
    getPolicy: vi.fn(async () => policy),
    setConversationKnowledgeBaseEnabled: setKnowledgeBaseEnabled,
    testKnowledgeBase: vi.fn(async () => ({ ok: true, message: '连接成功' })),
    onAgentStep: vi.fn(() => unsubscribe),
    onAgentDelta: vi.fn(() => unsubscribe),
    onAgentContextUsage: vi.fn(() => unsubscribe),
    onAgentDone: vi.fn(() => unsubscribe),
    onMcpApprovalRequest: vi.fn(() => unsubscribe),
    onCommandApprovalRequest: vi.fn(() => unsubscribe),
    onUserChoiceRequest: vi.fn(() => unsubscribe)
  } as unknown as DesktopApi
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0) })
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('knowledge-base settings and conversation plugin', () => {
  it('keeps attachment upload in the add menu and only toggles the knowledge-base plugin', async () => {
    await renderApp()

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="打开添加菜单"]')!
    await act(async () => trigger.click())
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const filePicker = vi.spyOn(fileInput, 'click')
    expect(fileInput.multiple).toBe(true)
    expect(fileInput.accept).toContain('image/')
    expect(fileInput.accept).toContain('.docx')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="添加照片和文件"]')!.click())
    expect(filePicker).toHaveBeenCalledOnce()

    await act(async () => trigger.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开插件列表"]')!.click())
    const enable = container.querySelector<HTMLButtonElement>('[aria-label="启用知识库插件"]')!
    expect(enable.getAttribute('aria-checked')).toBe('false')
    expect(enable.querySelector('.plugin-checkbox svg')).toBeNull()
    await act(async () => enable.click())
    await vi.waitFor(() => expect(setKnowledgeBaseEnabled).toHaveBeenCalledWith('conversation-1', true))

    const disable = container.querySelector<HTMLButtonElement>('[aria-label="停用知识库插件"]')!
    expect(disable.getAttribute('aria-checked')).toBe('true')
    expect(disable.querySelector('.plugin-checkbox svg')).not.toBeNull()
    await act(async () => disable.click())
    await vi.waitFor(() => expect(setKnowledgeBaseEnabled).toHaveBeenLastCalledWith('conversation-1', false))
    expect(container.querySelector('[aria-labelledby="knowledge-base-title"]')).toBeNull()
  })

  it('edits and saves the FastGPT connection from the settings page', async () => {
    await renderApp()
    await act(async () => container.querySelector<HTMLButtonElement>('.top-settings')!.click())
    const configTab = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav section button')].find((button) => button.textContent === '配置')!
    await act(async () => configTab.click())

    expect(container.querySelector('[aria-labelledby="knowledge-base-title"]')).not.toBeNull()
    expect(container.querySelector('#knowledge-base-title')?.textContent).toBe('知识库配置')
    expect(container.textContent).not.toContain('统一配置 FastGPT')
    const address = container.querySelector<HTMLInputElement>('input[placeholder="https://fastgpt.example.com"]')!
    const apiKey = container.querySelector<HTMLInputElement>('#knowledge-base-api-key')!
    expect(apiKey.type).toBe('password')
    await act(async () => setInputValue(address, 'https://fastgpt.new.example'))
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('保存知识库配置'))!
    await act(async () => save.click())

    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBase: expect.objectContaining({
        baseUrl: 'https://fastgpt.new.example',
        apiKey: 'fastgpt-system-test',
        datasetId: 'dataset-123'
      })
    })))
  })
})

async function renderApp(): Promise<void> {
  await act(async () => {
    root.render(<App />)
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(container.querySelector('[aria-label="打开添加菜单"]')).not.toBeNull())
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
