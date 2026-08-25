import { cloneElement, FormEvent, isValidElement, memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode, type SVGProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, CodeXml, Copy, Database, ExternalLink, Eye, EyeOff, FileCode2, FileCog, FileJson2, FileText, FolderOpen, Globe2, LoaderCircle, Moon, Palette, Paperclip, Plus, Puzzle, RotateCcw, Settings as SettingsIcon, Square, SquareTerminal, Star, Sun, Trash2 } from 'lucide-react'
import type { AgentArtifact, AgentPolicy, AgentTone, AppearanceSettings, AppSettings, ChatAttachment, ChatMessage, CommandApprovalRequest, ContextUsage, Conversation, FontFamilyPreference, KnowledgeBaseApiMode, KnowledgeBaseConfig, KnowledgeBaseSearchMode, McpApprovalRequest, ModelConnectionType, ModelProfile, PermissionMode, TaskStatus, TaskStep, ThemePreference, TokenUsage, UserChoiceRequest } from '../../shared/types'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, getDefaultModelProfile, getModelProfiles, modelConfig, modelDisplayName, resolveModelProfile } from '../../shared/models'
import { hideReactObservationReferences, normalizeTechnicalPunctuation } from '../../shared/text'
import { parseUnifiedDiff, type UnifiedDiffLine } from '../../shared/unified-diff'
import { isHiddenInternalAgentStep } from '../../shared/agent-steps'
import { searchConversationHistory, type ConversationSearchResult } from '../../shared/conversation-search'
import {
  ATTACHMENT_ACCEPT,
  inferAttachmentMimeType,
  isImageAttachmentType,
  isOfficeAttachmentType,
  isSupportedAttachmentType,
  MAX_IMAGE_ATTACHMENT_SIZE,
  MAX_OFFICE_ATTACHMENT_SIZE,
  MAX_TEXT_ATTACHMENT_SIZE,
  MAX_TOTAL_ATTACHMENT_SIZE
} from '../../shared/attachments'

type IconName = 'panel' | 'chevron-left' | 'chevron-right' | 'message' | 'search' | 'skills' | 'clock' | 'folder' | 'plus' | 'shield' | 'chevron-down' | 'send' | 'monitor' | 'branch' | 'search-small' | 'check' | 'trash' | 'file' | 'close'
type IconProps = SVGProps<SVGSVGElement> & { name: IconName }

const paths: Record<IconName, ReactElement> = {
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  message: <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.8 8.8 0 0 1-3.5-.7L4 20l1.4-3.7A7.2 7.2 0 0 1 4 12a7.5 7.5 0 0 1 8-7.5 7.5 7.5 0 0 1 8 7Z" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
  skills: <><path d="M8 3h8v5h5v8h-5v5H8v-5H3V8h5z" /><path d="M8 8h8v8H8z" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  shield: <path d="M12 3 19 6v5c0 4.3-2.7 7.7-7 10-4.3-2.3-7-5.7-7-10V6z" />,
  'chevron-down': <path d="m7 10 5 5 5-5" />,
  send: <path d="m5 12 14-7-4 14-3-5zM12 12l3-3" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  branch: <><path d="M6 3v12" /><circle cx="6" cy="3" r="2" /><circle cx="6" cy="15" r="2" /><circle cx="18" cy="7" r="2" /><path d="M8 15c6 0 2-8 8-8" /></>,
  'search-small': <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 14h10l1-14" /><path d="M9 7V4h6v3" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
  close: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>
}

const initialSettings: AppSettings = {
  model: { baseUrl: '', apiKey: '', model: '', timeoutMs: 300000, maxRetries: 3, contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
  models: [],
  skillsEnabled: true,
  permissionMode: 'request_approval',
  appearance: { theme: 'system', chatFontFamily: 'system', uiFontFamily: 'system', fontSize: 14 },
  personalization: { tone: 'balanced', customInstructions: '' },
  navigation: { fileApplicationPath: '', browserApplicationPath: '' }
}
const statusText: Record<TaskStatus, string> = { pending: '等待中', reasoning: '分析中', acting: '执行中', validating: '校验中', succeeded: '已完成', failed: '失败', paused: '已暂停' }
const THINKING_TITLE = '思考过程'
const THINKING_PLACEHOLDER = '思考中…'
const SCROLL_BOTTOM_THRESHOLD = 96
const SHOW_SCROLL_BUTTON_THRESHOLD = 220
const LOCAL_ASSISTANT_PREFIX = 'local-agent-'
const LOCAL_STEP_PREFIX = 'local-step-'
type View = 'chat' | 'settings'
type SettingTab = '常规' | '外观' | '配置' | '个性化' | 'Git' | '环境'

function Icon({ name, ...props }: IconProps): ReactElement {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
}

const permissionModes: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: 'full_access', label: '完全访问', description: '可不受限制地访问互联网和您电脑上的任何文件。' },
  { value: 'auto_approve', label: '替我审批', description: '仅对检测到的风险操作请求批准。' },
  { value: 'request_approval', label: '请求批准', description: '编辑外部文件和使用互联网时始终询问。' }
]

const defaultAppearance: AppearanceSettings = { theme: 'system', chatFontFamily: 'system', uiFontFamily: 'system', fontSize: 14 }
const fontStacks: Record<FontFamilyPreference, string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif',
  inter: 'Inter, "Noto Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif',
  'noto-sans': '"Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC", sans-serif',
  yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif',
  sarasa: '"Sarasa UI SC", "Sarasa Gothic SC", "Noto Sans CJK SC", sans-serif',
  'noto-serif': '"Noto Serif CJK SC", "Source Han Serif SC", "Noto Serif SC", serif',
  songti: '"Songti SC", SimSun, "Noto Serif CJK SC", serif',
  kaiti: 'KaiTi, "Kaiti SC", STKaiti, "Noto Serif CJK SC", serif',
  wenkai: '"LXGW WenKai", "霞鹜文楷", KaiTi, "Noto Serif CJK SC", serif',
  mono: '"SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace'
}

const fontOptions: Array<{ value: FontFamilyPreference; label: string }> = [
  { value: 'system', label: '系统默认' },
  { value: 'inter', label: 'Inter / 现代无衬线' },
  { value: 'noto-sans', label: '思源黑体 / Noto Sans' },
  { value: 'yahei', label: '微软雅黑' },
  { value: 'pingfang', label: '苹方' },
  { value: 'sarasa', label: '更纱黑体' },
  { value: 'noto-serif', label: '思源宋体 / Noto Serif' },
  { value: 'songti', label: '宋体' },
  { value: 'kaiti', label: '楷体' },
  { value: 'wenkai', label: '霞鹜文楷' },
  { value: 'mono', label: '等宽字体' }
]

function appearanceSettings(settings: AppSettings): AppearanceSettings {
  const appearance = settings.appearance
  if (!appearance) return defaultAppearance
  return {
    theme: appearance.theme,
    chatFontFamily: appearance.chatFontFamily ?? appearance.fontFamily ?? 'system',
    uiFontFamily: appearance.uiFontFamily ?? 'system',
    fontSize: appearance.fontSize
  }
}

function permissionModeLabel(mode?: PermissionMode): string {
  return permissionModes.find((item) => item.value === mode)?.label ?? '请求批准'
}

function PermissionMenu({ value, onChange }: { value: PermissionMode; onChange: (value: PermissionMode) => void }): ReactElement {
  return <div className="permission-menu" role="menu"><p>Agent 权限</p>{permissionModes.map((mode) => <button type="button" role="menuitemradio" aria-checked={value === mode.value} className={value === mode.value ? 'selected' : ''} key={mode.value} onClick={() => onChange(mode.value)}><span><strong>{mode.label}</strong><small>{mode.description}</small></span>{value === mode.value ? <Check /> : null}</button>)}</div>
}

export function App(): ReactElement {
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | undefined>()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState('')
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [policy, setPolicy] = useState<AgentPolicy | undefined>()
  const [running, setRunning] = useState(false)
  const [pauseRequested, setPauseRequested] = useState(false)
  const [mcpApproval, setMcpApproval] = useState<McpApprovalRequest | undefined>()
  const [commandApproval, setCommandApproval] = useState<CommandApprovalRequest | undefined>()
  const [userChoice, setUserChoice] = useState<UserChoiceRequest | undefined>()
  const [selectedChoiceId, setSelectedChoiceId] = useState('')
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [pluginMenuOpen, setPluginMenuOpen] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [view, setView] = useState<View>('chat')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchJumpTarget, setSearchJumpTarget] = useState<{ conversationId: string; messageId: string } | undefined>()
  const [highlightedMessageId, setHighlightedMessageId] = useState('')
  const [highlightedSearchQuery, setHighlightedSearchQuery] = useState('')
  const [tab, setTab] = useState<SettingTab>('常规')
  const messageListRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentsRef = useRef<ChatAttachment[]>([])
  const pendingAttachmentReadsRef = useRef<Promise<void> | null>(null)
  const runningConversationIdRef = useRef('')
  const workspaceControlRef = useRef<HTMLDivElement | null>(null)
  const modelControlRef = useRef<HTMLDivElement | null>(null)
  const permissionControlRef = useRef<HTMLDivElement | null>(null)
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  const pendingAgentDeltasRef = useRef(new Map<string, { conversationId: string; messageId: string; delta: string }>())
  const agentDeltaTimerRef = useRef<number | undefined>(undefined)
  const stickToBottomRef = useRef(true)
  const pendingSearchJumpRef = useRef<{ conversationId: string; messageId: string } | undefined>(undefined)

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) ?? conversations[0], [activeId, conversations])
  const visibleConversations = useMemo(() => conversations.filter((item) => item.messages.length > 0), [conversations])
  const activeWorkspacePath = activeConversation?.workspacePath || policy?.workspacePath || ''
  const modelProfiles = useMemo(() => getModelProfiles(settings), [settings])
  const defaultModel = useMemo(() => getDefaultModelProfile(settings), [settings])
  const activeModel = useMemo(() => resolveModelProfile(settings, activeConversation?.modelId), [settings, activeConversation?.modelId])
  const latestContextUsage = useMemo(() => [...(activeConversation?.messages ?? [])].reverse().find((message) => message.role === 'assistant' && message.contextUsage)?.contextUsage, [activeConversation?.messages])
  const searchResults = useMemo(() => searchConversationHistory(conversations, searchQuery), [conversations, searchQuery])
  const scrollKey = useMemo(() => activeConversation?.messages.map((message) => [message.id, message.status ?? '', message.content.length, message.attachments?.length ?? 0, message.steps?.length ?? 0, message.steps?.reduce((total, step) => total + step.detail.length, 0) ?? 0, message.tokenUsage?.outputTokens ?? 0].join(':')).join('|') ?? '', [activeConversation])
  const appearance = appearanceSettings(settings)

  useEffect(() => {
    const root = document.documentElement
    const darkMode = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = (): void => {
      const theme = appearance.theme === 'system' ? darkMode.matches ? 'dark' : 'light' : appearance.theme
      root.dataset.theme = theme
      root.style.colorScheme = theme
    }
    applyTheme()
    root.style.setProperty('--app-font-family', fontStacks[appearance.uiFontFamily])
    root.style.setProperty('--chat-font-family', fontStacks[appearance.chatFontFamily])
    root.style.setProperty('--app-content-font-size', Math.min(18, Math.max(12, appearance.fontSize)) + 'px')
    if (appearance.theme === 'system') darkMode.addEventListener('change', applyTheme)
    return () => darkMode.removeEventListener('change', applyTheme)
  }, [appearance.chatFontFamily, appearance.fontSize, appearance.theme, appearance.uiFontFamily])

  useEffect(() => {
    void Promise.all([window.api.getConversations(), window.api.getSettings(), window.api.getPolicy()]).then(([savedConversations, savedSettings, savedPolicy]) => {
      setConversations(savedConversations)
      setActiveId(savedConversations[0]?.id ?? '')
      setSettings(savedSettings)
      setPolicy(savedPolicy)
    })
  }, [])

  useEffect(() => {
    return window.api.onAgentStep(({ conversationId, messageId, step }) => {
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation
        return {
          ...conversation,
          messages: updateAssistantMessage(conversation.messages, messageId, (message) => ({
            ...message,
            status: 'acting',
            steps: mergeLiveStep(message.steps ?? [], step)
          }))
        }
      }))
    })
  }, [])

  useEffect(() => {
    if (!workspaceMenuOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!workspaceControlRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setWorkspaceMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [workspaceMenuOpen])

  useEffect(() => {
    if (!modelMenuOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!modelControlRef.current?.contains(event.target as Node)) setModelMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModelMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [modelMenuOpen])

  useEffect(() => {
    if (!permissionMenuOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!permissionControlRef.current?.contains(event.target as Node)) setPermissionMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPermissionMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [permissionMenuOpen])

  useEffect(() => {
    if (!addMenuOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!addMenuRef.current?.contains(event.target as Node)) {
        setAddMenuOpen(false)
        setPluginMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAddMenuOpen(false)
        setPluginMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [addMenuOpen])

  useEffect(() => {
    const flushAgentDeltas = (): void => {
      agentDeltaTimerRef.current = undefined
      const pending = [...pendingAgentDeltasRef.current.values()]
      pendingAgentDeltasRef.current.clear()
      if (!pending.length) return
      setConversations((current) => pending.reduce((conversations, item) => conversations.map((conversation) => {
        if (conversation.id !== item.conversationId) return conversation
        return {
          ...conversation,
          messages: updateAssistantMessage(conversation.messages, item.messageId, (message) => ({
            ...message,
            content: message.content + item.delta,
            status: 'acting'
          }))
        }
      }), current))
    }
    const unsubscribe = window.api.onAgentDelta(({ conversationId, messageId, delta }) => {
      const key = conversationId + ':' + messageId
      const previous = pendingAgentDeltasRef.current.get(key)
      pendingAgentDeltasRef.current.set(key, {
        conversationId,
        messageId,
        delta: (previous?.delta ?? '') + delta
      })
      if (agentDeltaTimerRef.current === undefined) {
        agentDeltaTimerRef.current = window.setTimeout(flushAgentDeltas, 32)
      }
    })
    return () => {
      if (agentDeltaTimerRef.current !== undefined) window.clearTimeout(agentDeltaTimerRef.current)
      agentDeltaTimerRef.current = undefined
      pendingAgentDeltasRef.current.clear()
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (typeof window.api.onAgentContextUsage !== 'function') return
    return window.api.onAgentContextUsage(({ conversationId, messageId, contextUsage }) => {
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation
        return {
          ...conversation,
          messages: updateAssistantMessage(conversation.messages, messageId, (message) => ({ ...message, contextUsage }))
        }
      }))
    })
  }, [])

  useEffect(() => {
    return window.api.onAgentDone(({ conversationId, messageId, status, content, completedAt, tokenUsage, contextUsage }) => {
      for (const key of pendingAgentDeltasRef.current.keys()) {
        if (key === conversationId + ':' + messageId) pendingAgentDeltasRef.current.delete(key)
      }
      setMcpApproval(undefined)
      setCommandApproval(undefined)
      setUserChoice(undefined)
      setSelectedChoiceId('')
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation
        return {
          ...conversation,
          messages: updateAssistantMessage(conversation.messages, messageId, (message) => ({ ...message, content, completedAt, status, tokenUsage, contextUsage }))
        }
      }))
    })
  }, [])

  useEffect(() => window.api.onMcpApprovalRequest((request) => {
    setMcpApproval(request)
    if (request.conversationId) setActiveId(request.conversationId)
    setView('chat')
  }), [])

  useEffect(() => window.api.onCommandApprovalRequest((request) => {
    setCommandApproval(request)
    if (request.conversationId) setActiveId(request.conversationId)
    setView('chat')
  }), [])

  useEffect(() => window.api.onUserChoiceRequest((request) => {
    setUserChoice(request)
    setSelectedChoiceId('')
    if (request.conversationId) setActiveId(request.conversationId)
    setView('chat')
  }), [])

  useEffect(() => {
    if (!mcpApproval) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') respondToMcpApproval(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mcpApproval])

  useEffect(() => {
    if (!commandApproval) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') respondToCommandApproval(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [commandApproval])

  useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list || view !== 'chat') return
    if (pendingSearchJumpRef.current?.conversationId === activeConversation?.id) return
    const jumpToBottom = (): void => {
      list.scrollTop = list.scrollHeight
      stickToBottomRef.current = true
      setShowScrollToBottom(false)
    }
    jumpToBottom()
    const frame = requestAnimationFrame(jumpToBottom)
    return () => cancelAnimationFrame(frame)
  }, [activeConversation?.id, view])

  useLayoutEffect(() => {
    const list = messageListRef.current
    if (!list || view !== 'chat' || !searchJumpTarget || searchJumpTarget.conversationId !== activeConversation?.id) return
    const frame = requestAnimationFrame(() => {
      const target = Array.from(list.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((element) => element.dataset.messageId === searchJumpTarget.messageId)
      pendingSearchJumpRef.current = undefined
      setSearchJumpTarget(undefined)
      if (!target) return
      const listRect = list.getBoundingClientRect()
      const focusTarget = target.querySelector<HTMLElement>('[data-message-content]') ?? target
      const targetRect = focusTarget.getBoundingClientRect()
      const composerRect = list.parentElement?.querySelector<HTMLElement>('.chat-composer')?.getBoundingClientRect()
      const visibleBottom = composerRect ? Math.min(listRect.bottom, composerRect.top) : listRect.bottom
      const visibleCenter = listRect.top + Math.max(1, visibleBottom - listRect.top) / 2
      const targetCenter = targetRect.top + targetRect.height / 2
      list.scrollTo({ top: list.scrollTop + targetCenter - visibleCenter, behavior: 'auto' })
      const distance = Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop)
      stickToBottomRef.current = distance <= SCROLL_BOTTOM_THRESHOLD
      setShowScrollToBottom(distance > SHOW_SCROLL_BUTTON_THRESHOLD)
      setHighlightedMessageId(searchJumpTarget.messageId)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeConversation?.id, searchJumpTarget, view])

  useEffect(() => {
    if (!highlightedMessageId) return
    const timer = window.setTimeout(() => {
      setHighlightedMessageId('')
      setHighlightedSearchQuery('')
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [highlightedMessageId])

  useEffect(() => {
    if (!searchOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [searchOpen])

  useEffect(() => {
    const list = messageListRef.current
    if (!list || view !== 'chat') return
    if (stickToBottomRef.current) {
      list.scrollTop = list.scrollHeight
      setShowScrollToBottom(false)
      return
    }
    const distance = Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop)
    setShowScrollToBottom(distance > SHOW_SCROLL_BUTTON_THRESHOLD)
  }, [scrollKey, mcpApproval?.id, commandApproval?.id, userChoice?.id, view])

  useEffect(() => {
    const list = messageListRef.current
    if (!list || view !== 'chat') return
    const updateScrollState = (): void => {
      const distance = Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop)
      stickToBottomRef.current = distance <= SCROLL_BOTTOM_THRESHOLD
      setShowScrollToBottom(distance > SHOW_SCROLL_BUTTON_THRESHOLD)
    }
    updateScrollState()
    list.addEventListener('scroll', updateScrollState, { passive: true })
    return () => list.removeEventListener('scroll', updateScrollState)
  }, [activeConversation?.id, view])

  useEffect(() => {
    if (!previewAttachment) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreviewAttachment(undefined)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [previewAttachment])

  useEffect(() => {
    attachmentsRef.current = []
    setAttachments([])
    setAttachmentError('')
    setWorkspaceMenuOpen(false)
    setModelMenuOpen(false)
    setAddMenuOpen(false)
    setPluginMenuOpen(false)
  }, [activeId])

  function queueFiles(files: File[]): void {
    if (!files.length) return
    setAttachmentsLoading(true)
    const previous = pendingAttachmentReadsRef.current ?? Promise.resolve()
    const operation = previous.then(() => addFiles(files))
    pendingAttachmentReadsRef.current = operation
    void operation.then(() => {
      if (pendingAttachmentReadsRef.current !== operation) return
      pendingAttachmentReadsRef.current = null
      setAttachmentsLoading(false)
    }, () => {
      if (pendingAttachmentReadsRef.current !== operation) return
      pendingAttachmentReadsRef.current = null
      setAttachmentsLoading(false)
    })
  }

  async function addFiles(files: File[]): Promise<void> {
    if (!files.length) return
    const errors: string[] = []

    let totalSize = attachmentsRef.current.reduce((sum, attachment) => sum + attachment.size, 0)
    const readableFiles = files.filter((file) => {
      const mimeType = inferAttachmentMimeType(file.type, file.name)
      if (!isSupportedAttachmentType(mimeType, file.name)) {
        errors.push('不支持的文件类型：' + file.name)
        return false
      }
      const maxSize = isImageAttachmentType(mimeType)
        ? MAX_IMAGE_ATTACHMENT_SIZE
        : isOfficeAttachmentType(mimeType, file.name)
          ? MAX_OFFICE_ATTACHMENT_SIZE
          : MAX_TEXT_ATTACHMENT_SIZE
      if (file.size <= 0 || file.size > maxSize) {
        errors.push(file.name + ' 超出 ' + formatBytes(maxSize) + ' 限制')
        return false
      }
      if (totalSize + file.size > MAX_TOTAL_ATTACHMENT_SIZE) {
        errors.push('附件总大小不能超过 ' + formatBytes(MAX_TOTAL_ATTACHMENT_SIZE))
        return false
      }
      totalSize += file.size
      return true
    })

    const results = await Promise.allSettled(readableFiles.map((file) => readAttachment(file)))
    const nextAttachments: ChatAttachment[] = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') nextAttachments.push(result.value)
      else errors.push('无法读取文件：' + readableFiles[index].name)
    })
    if (nextAttachments.length) {
      const mergedAttachments = [...attachmentsRef.current, ...nextAttachments]
      attachmentsRef.current = mergedAttachments
      setAttachments(mergedAttachments)
    }
    setAttachmentError(errors.join('；'))
  }

  function removeAttachment(id: string): void {
    const remainingAttachments = attachmentsRef.current.filter((attachment) => attachment.id !== id)
    attachmentsRef.current = remainingAttachments
    setAttachments(remainingAttachments)
    setAttachmentError('')
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (running || !activeConversation) return
    if (pendingAttachmentReadsRef.current) await pendingAttachmentReadsRef.current
    const currentAttachments = attachmentsRef.current
    if (!prompt.trim() && !currentAttachments.length) return
    const submittedPrompt = prompt.trim()
    const submittedAttachments = currentAttachments
    const conversationId = activeConversation.id
    const createdAt = new Date().toISOString()
    const optimisticMessage: ChatMessage = {
      id: 'local-' + crypto.randomUUID(),
      role: 'user',
      content: submittedPrompt,
      attachments: submittedAttachments.length ? submittedAttachments : undefined,
      createdAt
    }
    const pendingAssistant: ChatMessage = {
      id: LOCAL_ASSISTANT_PREFIX + crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt,
      status: 'acting',
      steps: [createThinkingStep()]
    }
    setPrompt('')
    attachmentsRef.current = []
    setAttachments([])
    setAttachmentError('')
    setActiveId(conversationId)
    setConversations((current) => current.map((conversation) => {
      if (conversation.id !== conversationId) return conversation
      return {
        ...conversation,
        title: conversation.title === '新对话' ? submittedPrompt.slice(0, 28) || currentAttachments[0]?.name.slice(0, 28) || '新对话' : conversation.title,
        updatedAt: createdAt,
        messages: [...conversation.messages, optimisticMessage, pendingAssistant]
      }
    }))
    setRunning(true)
    setPauseRequested(false)
    runningConversationIdRef.current = conversationId
    try {
      const result = await window.api.runTask(conversationId, submittedPrompt, submittedAttachments)
      setConversations((current) => [result.conversation, ...current.filter((item) => item.id !== result.conversation.id)])
      setActiveId(result.conversation.id)
    } finally {
      setRunning(false)
      setPauseRequested(false)
      runningConversationIdRef.current = ''
    }
  }

  function pauseTask(): void {
    if (!running || pauseRequested || !runningConversationIdRef.current) return
    setPauseRequested(true)
    window.api.cancelTask(runningConversationIdRef.current)
  }

  async function createConversation(): Promise<void> {
    const conversation = await window.api.createConversation()
    setConversations((current) => [conversation, ...current])
    setActiveId(conversation.id)
    setSearchOpen(false)
    setView('chat')
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    const next = await window.api.deleteConversation(conversationId)
    setConversations(next)
    if (conversationId === activeId) setActiveId(next[0]?.id ?? '')
  }

  async function selectWorkspace(): Promise<void> {
    if (!activeConversation || running) return
    const conversation = await window.api.selectConversationWorkspace(activeConversation.id)
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
    setWorkspaceMenuOpen(false)
  }

  async function resetWorkspace(): Promise<void> {
    if (!activeConversation || running) return
    const conversation = await window.api.resetConversationWorkspace(activeConversation.id)
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
    setWorkspaceMenuOpen(false)
  }

  async function selectConversationModel(modelId?: string): Promise<void> {
    if (!activeConversation || running) return
    try {
      const conversation = await window.api.setConversationModel(activeConversation.id, modelId)
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
    } catch {
      setSettings(await window.api.getSettings())
    } finally {
      setModelMenuOpen(false)
    }
  }

  async function toggleConversationKnowledgeBase(): Promise<void> {
    if (!activeConversation || running) return
    try {
      const conversation = await window.api.setConversationKnowledgeBaseEnabled(activeConversation.id, !activeConversation.knowledgeBaseEnabled)
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
      setAttachmentError('')
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '切换知识库插件失败，请重试。')
    }
  }

  async function selectPermissionMode(permissionMode: PermissionMode): Promise<void> {
    if (running) return
    const nextSettings = { ...settings, permissionMode }
    setSettings(nextSettings)
    setPermissionMenuOpen(false)
    const savedSettings = await window.api.saveSettings(nextSettings)
    // Keep the user's explicit choice when talking to a main process from an
    // older hot-reload session that does not return the new field yet.
    setSettings({ ...savedSettings, permissionMode: savedSettings.permissionMode ?? permissionMode })
  }

  async function saveSettings(settingsOverride?: AppSettings): Promise<void> {
    const savedSettings = await window.api.saveSettings(settingsOverride ?? settings)
    const validModelIds = new Set(getModelProfiles(savedSettings).map((profile) => profile.id))
    setSettings(savedSettings)
    setConversations((current) => current.map((conversation) => ({
      ...conversation,
      ...(conversation.modelId && !validModelIds.has(conversation.modelId) ? { modelId: undefined } : {}),
      ...(!savedSettings.knowledgeBase ? { knowledgeBaseEnabled: undefined } : {})
    })))
    if (policy && !settingsOverride) await window.api.savePolicy(policy)
  }

  async function closeSettings(): Promise<void> {
    const [savedSettings, savedPolicy] = await Promise.all([window.api.getSettings(), window.api.getPolicy()])
    setSettings(savedSettings)
    setPolicy(savedPolicy)
    setView('chat')
  }

  function respondToMcpApproval(approved: boolean): void {
    if (!mcpApproval) return
    window.api.respondMcpApproval(mcpApproval.id, approved)
    setMcpApproval(undefined)
  }

  function respondToCommandApproval(approved: boolean): void {
    if (!commandApproval) return
    window.api.respondCommandApproval(commandApproval.id, approved)
    setCommandApproval(undefined)
  }

  function confirmUserChoice(): void {
    if (!userChoice || !selectedChoiceId) return
    window.api.respondUserChoice(userChoice.id, selectedChoiceId)
    setUserChoice(undefined)
    setSelectedChoiceId('')
  }

  function scrollToLatest(): void {
    const list = messageListRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
    stickToBottomRef.current = true
    setShowScrollToBottom(false)
  }

  function openConversation(conversationId: string): void {
    pendingSearchJumpRef.current = undefined
    setSearchJumpTarget(undefined)
    setHighlightedMessageId('')
    setHighlightedSearchQuery('')
    setActiveId(conversationId)
    setSearchOpen(false)
    setView('chat')
  }

  function openSearchResult(result: ConversationSearchResult): void {
    const target = { conversationId: result.conversationId, messageId: result.messageId }
    pendingSearchJumpRef.current = target
    setSearchJumpTarget(target)
    setHighlightedMessageId('')
    setHighlightedSearchQuery(searchQuery)
    stickToBottomRef.current = false
    setActiveId(result.conversationId)
    setSearchOpen(false)
    setView('chat')
  }

  if (view === 'settings' && policy) return <>
    <SettingsPage settings={settings} setSettings={setSettings} policy={policy} setPolicy={setPolicy} tab={tab} setTab={setTab} onBack={() => void closeSettings()} onSave={saveSettings} />
  </>

  return <div className="chat-app">
    <header className="window-bar"><Icon name="panel" className="bar-icon" /><button className="bar-icon-button"><Icon name="chevron-left" /></button><button className="bar-icon-button"><Icon name="chevron-right" /></button><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span><div className="bar-spacer" /><button className="top-settings" onClick={() => setView('settings')}><SettingsIcon />设置</button></header>
    <aside className="sidebar">
      <nav className="quick-nav"><button type="button" className={view === 'chat' && !searchOpen ? 'quick-nav-active' : ''} onClick={() => { setSearchOpen(false); setView('chat') }}><Icon name="message" /><span>快速对话</span></button><button type="button" className={searchOpen ? 'quick-nav-active' : ''} aria-expanded={searchOpen} onClick={() => setSearchOpen(true)}><Icon name="search" /><span>搜索</span></button><button type="button"><Icon name="skills" /><span>技能</span></button><button type="button"><Icon name="clock" /><span>自动化</span></button></nav>
      <section className="project-list"><p>会话</p><button className="new-chat" onClick={() => void createConversation()}><Icon name="plus" />新对话</button><div className="task-list">{visibleConversations.map((conversation) => <div className={'conversation-row ' + (view === 'chat' && conversation.id === activeConversation?.id ? 'selected' : '')} key={conversation.id}><button onClick={() => openConversation(conversation.id)}><span>{conversation.title}</span><small>{conversation.messages.length}</small></button><button className="delete-chat" onClick={() => void deleteConversation(conversation.id)} title="删除会话"><Icon name="trash" /></button></div>)}</div></section>
      <button className="sidebar-settings" onClick={() => setView('settings')}><SettingsIcon /><span>设置</span></button>
    </aside>
    <main className="chat-main">
      <section className="message-list" ref={messageListRef}><MessageItems conversation={activeConversation} highlightedMessageId={highlightedMessageId} highlightedSearchQuery={highlightedSearchQuery} onPreview={setPreviewAttachment} />{mcpApproval ? <McpApprovalMessage request={mcpApproval} onRespond={respondToMcpApproval} /> : null}{commandApproval ? <CommandApprovalMessage request={commandApproval} onRespond={respondToCommandApproval} /> : null}{userChoice ? <UserChoiceMessage request={userChoice} selectedId={selectedChoiceId} onSelect={setSelectedChoiceId} onConfirm={confirmUserChoice} /> : null}</section>
      {showScrollToBottom ? <button type="button" className="scroll-to-bottom" title="回到底部" aria-label="回到底部" onClick={scrollToLatest}><ArrowDown /></button> : null}
      <form className="chat-composer" onSubmit={submit}>
        <input ref={fileInputRef} className="attachment-input" type="file" accept={ATTACHMENT_ACCEPT} multiple onChange={(event) => { queueFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} />
        {attachments.length ? <div className="composer-attachments">{attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} onRemove={() => removeAttachment(attachment.id)} onPreview={() => setPreviewAttachment(attachment)} />)}</div> : null}
        <textarea aria-label="向 Agent 描述任务" value={prompt} onChange={(event) => setPrompt(event.target.value)} onPaste={(event) => { const files = getClipboardFiles(event.clipboardData); if (files.length) { event.preventDefault(); queueFiles(files) } }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="输入任务，或直接粘贴截图；Enter 发送，Shift+Enter 换行" />
        {attachmentsLoading ? <p className="attachment-loading" role="status">正在读取附件...</p> : null}
        {attachmentError ? <p className="attachment-error" role="alert">{attachmentError}</p> : null}
        <div className="composer-controls"><div className="composer-left"><div className="add-menu-control" ref={addMenuRef}><button type="button" className={'icon-control add-menu-trigger ' + (addMenuOpen ? 'open' : '')} title="添加附件或插件" aria-label="打开添加菜单" aria-expanded={addMenuOpen} onClick={() => { setPermissionMenuOpen(false); setModelMenuOpen(false); setWorkspaceMenuOpen(false); setPluginMenuOpen(false); setAddMenuOpen((open) => !open) }}><Icon name="plus" /></button>{addMenuOpen ? <div className="add-menu" role="menu"><button type="button" role="menuitem" aria-label="添加照片和文件" className="add-menu-upload" onClick={() => { fileInputRef.current?.click(); setAddMenuOpen(false) }}><Paperclip /><span><strong>添加照片和文件</strong><small>支持图片、文档和文本文件</small></span></button><div className="add-menu-separator" /><button type="button" role="menuitem" aria-label="打开插件列表" className={'add-menu-plugin-trigger ' + (pluginMenuOpen ? 'selected' : '')} aria-expanded={pluginMenuOpen} onClick={() => setPluginMenuOpen((open) => !open)}><Puzzle /><span><strong>插件</strong><small>为当前对话添加能力</small></span><Icon name="chevron-right" /></button>{pluginMenuOpen ? <div className="plugin-menu" role="menu" aria-label="插件列表"><p>当前对话插件</p><button type="button" role="menuitemcheckbox" aria-label={activeConversation?.knowledgeBaseEnabled ? '停用知识库插件' : '启用知识库插件'} aria-checked={activeConversation?.knowledgeBaseEnabled === true} className={activeConversation?.knowledgeBaseEnabled ? 'active' : ''} disabled={running || !activeConversation || !settings.knowledgeBase} onClick={() => void toggleConversationKnowledgeBase()}><Database /><span><strong>知识库</strong><small>{settings.knowledgeBase ? settings.knowledgeBase.name + (activeConversation?.knowledgeBaseEnabled ? ' · 已启用' : ' · 未启用') : '请先在设置中完成配置'}</small></span><i className="plugin-checkbox">{activeConversation?.knowledgeBaseEnabled ? <Check /> : null}</i></button></div> : null}</div> : null}</div><div className="permission-control" ref={permissionControlRef}><button type="button" className={'permission mode-' + (settings.permissionMode ?? 'request_approval')} disabled={running} aria-expanded={permissionMenuOpen} onClick={() => { setAddMenuOpen(false); setPluginMenuOpen(false); setModelMenuOpen(false); setWorkspaceMenuOpen(false); setPermissionMenuOpen((open) => !open) }}><Icon name="shield" />{permissionModeLabel(settings.permissionMode)}<Icon name="chevron-down" /></button>{permissionMenuOpen ? <PermissionMenu value={settings.permissionMode ?? 'request_approval'} onChange={(mode) => void selectPermissionMode(mode)} /> : null}</div></div><button type={running ? 'button' : 'submit'} className={'send ' + (running ? 'pause' : '') + (pauseRequested ? ' pausing' : '')} disabled={running ? pauseRequested : attachmentsLoading || (!prompt.trim() && !attachments.length)} aria-label={running ? pauseRequested ? '正在暂停任务' : '暂停任务' : '发送任务'} title={running ? pauseRequested ? '正在暂停…' : '暂停任务' : '发送任务'} onClick={running ? pauseTask : undefined}>{running ? <Square fill="currentColor" /> : <Icon name="send" />}</button></div>
        <footer><div className="workspace-control" ref={workspaceControlRef}><button type="button" className={'workspace-trigger ' + (activeConversation?.workspacePath ? 'overridden' : '')} disabled={running} title={activeWorkspacePath} aria-expanded={workspaceMenuOpen} onClick={() => { setModelMenuOpen(false); setPermissionMenuOpen(false); setWorkspaceMenuOpen((open) => !open) }}><Icon name="folder" /><span>{workspaceLabel(activeWorkspacePath)}</span><Icon name="chevron-down" /></button>{workspaceMenuOpen ? <div className="workspace-menu"><p>当前会话工作区</p><code>{activeWorkspacePath}</code><button type="button" onClick={() => void selectWorkspace()}><Icon name="folder" />选择目录</button>{activeConversation?.workspacePath ? <button type="button" onClick={() => void resetWorkspace()}><Icon name="monitor" />恢复全局目录</button> : null}</div> : null}</div><div className="model-control" ref={modelControlRef}><button type="button" className={'model-trigger ' + (activeConversation?.modelId ? 'overridden' : '')} disabled={running} title={'当前模型：' + modelDisplayName(activeModel)} aria-expanded={modelMenuOpen} onClick={() => { setWorkspaceMenuOpen(false); setPermissionMenuOpen(false); setModelMenuOpen((open) => !open) }}><Bot /><span>{modelDisplayName(activeModel)}</span><ChevronDown /></button>{modelMenuOpen ? <div className="model-menu"><p>当前会话模型</p><button type="button" className={!activeConversation?.modelId ? 'selected' : ''} onClick={() => void selectConversationModel()}><span><strong>跟随默认模型</strong><small>{defaultModel.provider || 'OpenAI 兼容'} · {modelDisplayName(defaultModel)}</small></span>{!activeConversation?.modelId ? <Check /> : null}</button>{modelProfiles.map((profile) => <button type="button" key={profile.id} className={activeConversation?.modelId === profile.id ? 'selected' : ''} onClick={() => void selectConversationModel(profile.id)}><span><strong>{modelDisplayName(profile)}</strong><small>{profile.name && profile.name !== modelDisplayName(profile) ? profile.name + ' · ' : ''}{profile.provider || 'OpenAI 兼容'}</small></span>{activeConversation?.modelId === profile.id ? <Check /> : null}</button>)}</div> : null}</div><span><Icon name="branch" />main<Icon name="chevron-down" /></span><ContextUsageMeter usage={latestContextUsage} configuredLimit={activeModel.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS} /></footer>
      </form>
      {previewAttachment ? <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={previewAttachment.name} onClick={(event) => { if (event.target === event.currentTarget) setPreviewAttachment(undefined) }}><button type="button" className="attachment-lightbox-close" title="关闭预览" aria-label="关闭预览" onClick={() => setPreviewAttachment(undefined)}><Icon name="close" /></button><img className="attachment-lightbox-image" src={previewAttachment.dataUrl} alt={previewAttachment.name} /></div> : null}
    </main>
    {searchOpen ? <ConversationSearchOverlay query={searchQuery} onQueryChange={setSearchQuery} results={searchResults} conversationCount={visibleConversations.length} onOpenResult={openSearchResult} onClose={() => setSearchOpen(false)} /> : null}
  </div>
}

function KnowledgeBaseSettings({ settings, setSettings, onSave }: {
  settings: AppSettings
  setSettings: (value: AppSettings) => void
  onSave: (settingsOverride?: AppSettings) => Promise<void>
}): ReactElement {
  const config = settings.knowledgeBase
  const [draft, setDraft] = useState<KnowledgeBaseConfig>(() => config ? { ...config } : {
    name: 'FastGPT 知识库',
    baseUrl: '',
    apiKey: '',
    datasetId: '',
    apiMode: 'searchTest',
    limit: 5000,
    similarity: 0.5,
    searchMode: 'mixedRecall',
    usingReRank: false
  })
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [testQuery, setTestQuery] = useState('知识库中有哪些相关资料？')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | undefined>()

  function update(patch: Partial<KnowledgeBaseConfig>): void {
    setNotice(undefined)
    setDraft((current) => ({ ...current, ...patch }))
  }

  function validatedDraft(): KnowledgeBaseConfig | undefined {
    const next = {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: draft.apiKey.trim(),
      datasetId: draft.datasetId.trim(),
      limit: Math.floor(draft.limit),
      similarity: draft.similarity
    }
    if (!next.name) {
      setNotice({ type: 'error', text: '请填写知识库名称。' })
      return undefined
    }
    if (!next.baseUrl || !next.apiKey) {
      setNotice({ type: 'error', text: '请填写 FastGPT 地址和 API Key。' })
      return undefined
    }
    if (next.apiMode === 'searchTest' && !next.datasetId) {
      setNotice({ type: 'error', text: '当前接口需要填写知识库 ID（datasetId）。' })
      return undefined
    }
    try {
      const url = new URL(next.baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    } catch {
      setNotice({ type: 'error', text: 'FastGPT 地址必须是有效的 HTTP 或 HTTPS 地址。' })
      return undefined
    }
    if (!Number.isFinite(next.limit) || next.limit < 100 || next.limit > 20_000) {
      setNotice({ type: 'error', text: '召回内容上限必须在 100 到 20,000 之间。' })
      return undefined
    }
    if (!Number.isFinite(next.similarity) || next.similarity < 0 || next.similarity > 1) {
      setNotice({ type: 'error', text: '相似度阈值必须在 0 到 1 之间。' })
      return undefined
    }
    return next
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const next = validatedDraft()
    if (!next) return
    setSaving(true)
    try {
      const nextSettings = { ...settings, knowledgeBase: next }
      setSettings(nextSettings)
      await onSave(nextSettings)
      setNotice({ type: 'success', text: '知识库配置已保存。可在对话的加号菜单中按会话启用。' })
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '保存知识库配置失败。' })
    } finally {
      setSaving(false)
    }
  }

  async function testConnection(): Promise<void> {
    const next = validatedDraft()
    if (!next) return
    setTesting(true)
    setNotice(undefined)
    try {
      const result = await window.api.testKnowledgeBase(next, testQuery.trim())
      setNotice({ type: result.ok ? 'success' : 'error', text: result.message })
    } catch {
      setNotice({ type: 'error', text: '无法测试知识库连接，请检查配置。' })
    } finally {
      setTesting(false)
    }
  }

  async function remove(): Promise<void> {
    setSaving(true)
    setNotice(undefined)
    const nextSettings = { ...settings }
    delete nextSettings.knowledgeBase
    try {
      setSettings(nextSettings)
      await onSave(nextSettings)
      setDraft((current) => ({ ...current, baseUrl: '', apiKey: '', datasetId: '' }))
      setNotice({ type: 'success', text: '知识库配置已移除，所有会话中的知识库插件已停用。' })
    } catch {
      setSettings(settings)
      setNotice({ type: 'error', text: '移除知识库配置失败，请重试。' })
    } finally {
      setSaving(false)
    }
  }

  return <section className="settings-section compact knowledge-base-settings" aria-labelledby="knowledge-base-title">
    <form onSubmit={(event) => void submit(event)}>
      <header className="knowledge-base-settings-heading"><h2 id="knowledge-base-title">知识库配置</h2></header>
      <div className="knowledge-base-settings-body">
        <section className="model-dialog-section model-dialog-fields"><h3>连接信息</h3>
          <div className="model-dialog-grid">
            <label>知识库名称<input value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：产品文档库" /></label>
            <label>FastGPT 地址<input value={draft.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} placeholder="https://fastgpt.example.com" spellCheck={false} /></label>
            <label>接口类型<select value={draft.apiMode} onChange={(event) => update({ apiMode: event.target.value as KnowledgeBaseApiMode })}><option value="searchTest">searchTest（系统 API Key）</option><option value="datasetSearch">Dataset Search（Dataset API Key）</option></select></label>
            {draft.apiMode === 'searchTest' ? <label>知识库 ID（datasetId）<input value={draft.datasetId} onChange={(event) => update({ datasetId: event.target.value })} placeholder="例如：685xxxxxxxxxxxx" spellCheck={false} /></label> : null}
          </div>
          <div className="model-dialog-api-key"><label htmlFor="knowledge-base-api-key"><span>{draft.apiMode === 'searchTest' ? '系统 API Key' : 'Dataset API Key'}</span></label><div><input id="knowledge-base-api-key" type={apiKeyVisible ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => update({ apiKey: event.target.value })} placeholder={draft.apiMode === 'searchTest' ? '输入 FastGPT 系统 API Key' : 'fastgpt-dataset-xxx'} autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setApiKeyVisible((visible) => !visible)} aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} title={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'}>{apiKeyVisible ? <EyeOff /> : <Eye />}</button></div></div>
          <div className="model-dialog-protocol"><Database /><span><strong>FastGPT Dataset Search API</strong><small>{draft.apiMode === 'searchTest' ? 'POST /api/core/dataset/searchTest · datasetId + text' : 'POST /api/v1/dataset/search · query'} · 查询文本仅在模型决定检索时发送</small></span></div>
        </section>
        <section className="model-dialog-section model-dialog-fields"><h3>检索参数</h3>
          <div className="model-dialog-grid knowledge-base-parameter-grid">
            <label>召回内容上限<input type="number" min="100" max="100000" step="100" value={draft.limit} onChange={(event) => update({ limit: Number(event.target.value) })} /></label>
            <label>相似度阈值<input type="number" min="0" max="1" step="0.05" value={draft.similarity} onChange={(event) => update({ similarity: Number(event.target.value) })} /></label>
            <label>召回模式<select value={draft.searchMode} onChange={(event) => update({ searchMode: event.target.value as KnowledgeBaseSearchMode })}><option value="mixedRecall">混合召回</option><option value="embedding">向量召回</option><option value="fullTextRecall">全文召回</option></select></label>
            <label className="knowledge-base-rerank-label">结果重排<button type="button" role="switch" aria-checked={draft.usingReRank} className={'knowledge-base-switch ' + (draft.usingReRank ? 'on' : '')} onClick={() => update({ usingReRank: !draft.usingReRank })}><i /><span>{draft.usingReRank ? '已启用' : '未启用'}</span></button></label>
          </div>
        </section>
        <section className="model-dialog-section model-dialog-fields knowledge-base-test"><h3>连接测试</h3><label>测试问题<input value={testQuery} onChange={(event) => setTestQuery(event.target.value)} placeholder="输入一个适合在知识库中检索的问题" /></label><button type="button" className="connection-test" disabled={testing || saving} onClick={() => void testConnection()}>{testing ? <><LoaderCircle />正在检索…</> : '测试检索'}</button></section>
        {notice ? <div className={'config-notice ' + notice.type} role="status">{notice.type === 'success' ? <Check /> : <SettingsIcon />}{notice.text}</div> : null}
        <p className="knowledge-base-privacy-note">配置保存在本机应用数据中。Dataset API Key 不会进入模型上下文；模型调用检索工具时，查询文本会发送到上述 FastGPT 服务。</p>
      </div>
      <footer className="knowledge-base-settings-actions">{config ? <button type="button" className="knowledge-base-remove" disabled={saving || testing} onClick={() => void remove()}>移除配置</button> : <span />}<button type="submit" className="settings-save" disabled={saving || testing}>{saving ? <><LoaderCircle />保存中…</> : '保存知识库配置'}</button></footer>
    </form>
  </section>
}

function ConversationSearchOverlay({ query, onQueryChange, results, conversationCount, onOpenResult, onClose }: {
  query: string
  onQueryChange: (query: string) => void
  results: ConversationSearchResult[]
  conversationCount: number
  onOpenResult: (result: ConversationSearchResult) => void
  onClose: () => void
}): ReactElement {
  const hasQuery = Boolean(query.trim())
  return <div className="conversation-search-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="conversation-search-dialog" role="dialog" aria-modal="true" aria-label="搜索对话历史">
    <header className="conversation-search-header">
      <div><h1>搜索对话</h1><p>在全部 {conversationCount} 个会话中查找消息</p></div>
      <button type="button" className="conversation-search-close" onClick={onClose} title="关闭搜索" aria-label="关闭搜索"><Icon name="close" /></button>
    </header>
    <label className="conversation-search-input"><Icon name="search" /><input autoFocus type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索消息或附件名称…" aria-label="搜索全部对话" />{query ? <button type="button" onClick={() => onQueryChange('')} title="清空搜索" aria-label="清空搜索"><Icon name="close" /></button> : null}</label>
    <div className="conversation-search-summary">{hasQuery ? <><strong>{results.length}</strong> 条结果</> : '输入关键词开始搜索'}</div>
    <div className="conversation-search-results">
      {!hasQuery ? <div className="conversation-search-empty"><Icon name="search" /><strong>搜索全部对话历史</strong><p>可搜索你与 Agent 的消息正文和附件名称，多个关键词用空格分隔。</p></div> : null}
      {hasQuery && !results.length ? <div className="conversation-search-empty"><Icon name="search" /><strong>没有找到相关消息</strong><p>换一个关键词，或减少关键词后再试。</p></div> : null}
      {results.map((result) => <button type="button" className="conversation-search-result" key={result.conversationId + ':' + result.messageId} onClick={() => onOpenResult(result)}>
        <span className={'conversation-search-role ' + result.role}>{result.role === 'user' ? '你' : 'Agent'}</span>
        <span className="conversation-search-result-body"><span className="conversation-search-result-meta"><strong>{result.conversationTitle}</strong><time dateTime={result.createdAt}>{formatSearchTimestamp(result.createdAt)}</time></span><span className="conversation-search-snippet"><HighlightedSearchText text={result.snippet} query={query} /></span></span>
        <Icon name="chevron-right" />
      </button>)}
    </div>
  </section></div>
}

function HighlightedSearchText({ text, query }: { text: string; query: string }): ReactElement {
  return <>{highlightSearchText(text, query, 'conversation-search-match')}</>
}

function highlightSearchText(text: string, query: string, className: string): ReactNode {
  const terms = searchHighlightTerms(query)
  if (!terms.length) return text
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const matcher = new RegExp('(' + pattern + ')', 'giu')
  return text.split(matcher).map((part, index) => terms.some((term) => normalizeHighlightTerm(part) === normalizeHighlightTerm(term))
    ? <mark className={className} key={index} data-search-match>{part}</mark>
    : part)
}

function highlightSearchNode(node: ReactNode, query: string): ReactNode {
  if (typeof node === 'string') return highlightSearchText(node, query, 'message-search-match')
  if (Array.isArray(node)) return node.map((child) => highlightSearchNode(child, query))
  if (!isValidElement<{ children?: ReactNode }>(node) || node.props.children === undefined) return node
  if (node.type === 'mark') return node
  return cloneElement(node, undefined, highlightSearchNode(node.props.children, query))
}

function searchHighlightTerms(query: string): string[] {
  return [...new Set(query.normalize('NFKC').trim().split(/\s+/).filter(Boolean))].sort((left, right) => right.length - left.length)
}

function normalizeHighlightTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function markdownComponentsWithSearchHighlight(query: string): Components {
  if (!query.trim()) return defaultMarkdownComponents
  const components: Components = { a: MarkdownExternalLink }
  const highlight = (children: ReactNode): ReactNode => highlightSearchNode(children, query)
  components.p = ({ children }) => <p>{highlight(children)}</p>
  components.li = ({ children }) => <li>{highlight(children)}</li>
  components.h1 = ({ children }) => <h1>{highlight(children)}</h1>
  components.h2 = ({ children }) => <h2>{highlight(children)}</h2>
  components.h3 = ({ children }) => <h3>{highlight(children)}</h3>
  components.h4 = ({ children }) => <h4>{highlight(children)}</h4>
  components.h5 = ({ children }) => <h5>{highlight(children)}</h5>
  components.h6 = ({ children }) => <h6>{highlight(children)}</h6>
  components.td = ({ children, style }) => <td style={style}>{highlight(children)}</td>
  components.th = ({ children, style }) => <th style={style}>{highlight(children)}</th>
  return components
}

const defaultMarkdownComponents: Components = { a: MarkdownExternalLink }
const markdownRemarkPlugins = [remarkGfm]

function formatSearchTimestamp(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function McpApprovalMessage({ request, onRespond }: { request: McpApprovalRequest; onRespond: (approved: boolean) => void }): ReactElement {
  return <article className="message-item assistant mcp-approval-message" role="group" aria-labelledby="mcp-approval-title">
    <div className="message-meta"><span>Codext Agent</span><b className="run-status mcp-waiting">等待授权</b></div>
    <section className="mcp-approval-inline">
      <div className="mcp-approval-heading"><span className="mcp-approval-icon"><Icon name="shield" /></span><div><h2 id="mcp-approval-title">PPT MCP 请求授权</h2><p>Agent 准备通过本地 PPT 处理服务读取演示文稿。</p></div></div>
      <dl className="mcp-approval-details"><div><dt>工具</dt><dd>{toolDisplayName(request.toolName)}</dd></div>{request.workspacePath ? <div><dt>工作区</dt><dd>{request.workspacePath}</dd></div> : null}{request.path ? <div><dt>文件</dt><dd>{request.path}</dd></div> : null}<div><dt>服务</dt><dd>{request.serverUrl}</dd></div></dl>
      <div className="mcp-approval-footer"><span>仅授权本次调用</span><div className="mcp-approval-actions"><button type="button" className="mcp-cancel" onClick={() => onRespond(false)}>取消</button><button type="button" className="mcp-allow" autoFocus onClick={() => onRespond(true)}>允许一次</button></div></div>
    </section>
  </article>
}

function CommandApprovalMessage({ request, onRespond }: { request: CommandApprovalRequest; onRespond: (approved: boolean) => void }): ReactElement {
  const highRisk = request.riskLevel === 'blocked'
  const isNetwork = request.approvalKind === 'network'
  const isExternalFile = request.approvalKind === 'external-file'
  const title = isNetwork ? '联网访问确认' : isExternalFile ? '外部文件编辑确认' : '执行命令确认'
  const label = isNetwork ? '操作' : isExternalFile ? '文件' : '命令'
  return <article className={'message-item assistant mcp-approval-message ' + (highRisk ? 'high-risk-command' : '')} role="group" aria-labelledby="command-approval-title">
    <div className="message-meta"><span>Codext Agent</span><b className="run-status command-waiting">{highRisk ? '等待高风险确认' : '等待确认'}</b></div>
    <section className={'mcp-approval-inline command-approval-inline ' + (highRisk ? 'high-risk' : '')}>
      <div className="mcp-approval-heading"><span className="mcp-approval-icon command">{isNetwork ? <Globe2 /> : isExternalFile ? <FileCog /> : <SquareTerminal />}</span><div><h2 id="command-approval-title">{title}</h2><p>{request.reason}</p></div></div>
      <dl className="mcp-approval-details"><div><dt>{label}</dt><dd>{isExternalFile ? request.path ?? request.displayCommand : request.displayCommand}</dd></div>{request.background ? <div><dt>模式</dt><dd>后台启动，成功创建进程后返回</dd></div> : null}{request.workspacePath ? <div><dt>工作区</dt><dd>{request.workspacePath}</dd></div> : null}</dl>
      <div className="mcp-approval-footer"><span>{highRisk ? '高风险操作，仅确认本次' : '仅批准本次操作'}</span><div className="mcp-approval-actions"><button type="button" className="mcp-cancel" onClick={() => onRespond(false)}>拒绝</button><button type="button" className={'mcp-allow ' + (highRisk ? 'danger' : '')} autoFocus={!highRisk} onClick={() => onRespond(true)}>{highRisk ? '仍然执行' : '允许一次'}</button></div></div>
    </section>
  </article>
}

function UserChoiceMessage({ request, selectedId, onSelect, onConfirm }: { request: UserChoiceRequest; selectedId: string; onSelect: (id: string) => void; onConfirm: () => void }): ReactElement {
  return <article className="message-item assistant user-choice-message" role="group" aria-labelledby="user-choice-title">
    <div className="message-meta"><span>Codext Agent</span><b className="run-status choice-waiting">等待选择</b></div>
    <section className="user-choice-inline">
      <h2 id="user-choice-title">{request.title}</h2>
      {request.description ? <p>{request.description}</p> : null}
      <div className="user-choice-options">{request.options.map((option) => <label key={option.id} className={selectedId === option.id ? 'selected' : ''}><input type="radio" name={'choice-' + request.id} value={option.id} checked={selectedId === option.id} onChange={() => onSelect(option.id)} /><span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span></label>)}</div>
      <div className="user-choice-actions"><button type="button" disabled={!selectedId} onClick={onConfirm}>确认选择</button></div>
    </section>
  </article>
}

function upsertStep<T extends { id: string }>(steps: T[], nextStep: T): T[] {
  const index = steps.findIndex((item) => item.id === nextStep.id)
  if (index < 0) return [...steps, nextStep]
  return steps.map((item) => item.id === nextStep.id ? nextStep : item)
}

function createThinkingStep(): TaskStep {
  return {
    id: LOCAL_STEP_PREFIX + crypto.randomUUID(),
    phase: 'reason',
    title: THINKING_TITLE,
    detail: THINKING_PLACEHOLDER,
    timestamp: new Date().toISOString()
  }
}

function updateAssistantMessage(messages: ChatMessage[], messageId: string, update: (message: ChatMessage) => ChatMessage): ChatMessage[] {
  const existingIndex = messages.findIndex((item) => item.id === messageId)
  const pendingIndex = existingIndex < 0 ? messages.findIndex((item) => item.id.startsWith(LOCAL_ASSISTANT_PREFIX)) : -1

  if (existingIndex >= 0) {
    return messages.map((item, index) => index === existingIndex ? update(item) : item)
  }

  const baseMessage: ChatMessage = pendingIndex >= 0
    ? { ...messages[pendingIndex], id: messageId }
    : { id: messageId, role: 'assistant', content: '', createdAt: new Date().toISOString(), status: 'acting', steps: [] }
  const nextMessage = update(baseMessage)

  if (pendingIndex >= 0) return messages.map((item, index) => index === pendingIndex ? nextMessage : item)
  return [...messages, nextMessage]
}

function mergeLiveStep(steps: TaskStep[], nextStep: TaskStep): TaskStep[] {
  const currentSteps = nextStep.title === THINKING_TITLE
    ? steps.filter((item) => !(item.id.startsWith(LOCAL_STEP_PREFIX) && item.title === THINKING_TITLE))
    : steps

  return upsertStep(currentSteps, nextStep)
}

const MessageView = memo(function MessageView({ conversationId, message, highlighted, highlightQuery, onPreview }: { conversationId: string; message: ChatMessage; highlighted: boolean; highlightQuery: string; onPreview: (attachment: ChatAttachment) => void }): ReactElement {
  const shouldShowProcess = message.role === 'assistant' && (message.status === 'acting' || Boolean(message.steps?.length))
  const activeHighlightQuery = highlighted ? highlightQuery : ''
  const deferredContent = useDeferredValue(message.content)
  const renderedContent = message.status === 'acting' ? deferredContent : message.content
  return <article data-message-id={message.id} className={'message-item ' + message.role + (highlighted ? ' search-highlight' : '')}>
    <div className="message-meta"><span>{message.role === 'user' ? '你' : 'Codext Agent'}</span>{message.status && <b className={'run-status ' + message.status}>{statusText[message.status]}</b>}</div>
    {shouldShowProcess ? <AgentProcess message={message} /> : null}
    <div className="message-content-group" data-message-content>
      {renderedContent ? message.role === 'assistant'
        ? message.status === 'acting'
          ? <div className="message-bubble message-streaming-text">{renderedContent}</div>
          : <div className="message-bubble message-markdown"><ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={markdownComponentsWithSearchHighlight(activeHighlightQuery)}>{renderedContent}</ReactMarkdown></div>
        : <div className="message-bubble">{highlightSearchNode(renderedContent, activeHighlightQuery)}</div> : null}
      {message.role === 'assistant' && message.artifacts?.length ? <ResultArtifacts conversationId={conversationId} artifacts={message.artifacts} /> : null}
      {message.attachments?.length ? <div className="message-attachments">{message.attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} highlightQuery={activeHighlightQuery} onPreview={() => onPreview(attachment)} />)}</div> : null}
      {message.role === 'assistant' && message.tokenUsage ? <TokenUsageView usage={message.tokenUsage} /> : null}
    </div>
  </article>
})

const MessageItems = memo(function MessageItems({ conversation, highlightedMessageId, highlightedSearchQuery, onPreview }: {
  conversation?: Conversation
  highlightedMessageId: string
  highlightedSearchQuery: string
  onPreview: (attachment: ChatAttachment) => void
}): ReactElement {
  if (!conversation?.messages.length) {
    return <section className="welcome"><h1>今天想让 Agent 完成什么？</h1><p>同一会话里可以持续追问，Agent 会带着上下文继续执行。</p></section>
  }
  return <>{conversation.messages.map((message) => <MessageView key={message.id} conversationId={conversation.id} message={message} highlighted={highlightedMessageId === message.id} highlightQuery={highlightedSearchQuery} onPreview={onPreview} />)}</>
})

function MarkdownExternalLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'>): ReactElement {
  const isWebUrl = typeof href === 'string' && /^https?:\/\//i.test(href)
  return <a {...props} href={href} title={isWebUrl ? '在默认浏览器中打开 ' + href : props.title} onClick={(event) => {
    if (!isWebUrl || !href) return
    event.preventDefault()
    void window.api.openExternalUrl(href)
  }}>{children}{isWebUrl ? <ExternalLink aria-hidden="true" /> : null}</a>
}

function ContextUsageMeter({ usage, configuredLimit }: { usage?: ContextUsage; configuredLimit: number }): ReactElement {
  const limit = Math.max(1, usage?.contextWindowTokens ?? configuredLimit)
  const used = Math.max(0, usage?.usedTokens ?? 0)
  const percentage = Math.min(100, used / limit * 100)
  const level = percentage >= 95 ? 'danger' : percentage >= 80 ? 'warning' : ''
  const prefix = usage?.estimated ? '≈' : ''
  const label = usage ? prefix + formatTokenCount(used) + ' / ' + formatTokenCount(limit) : '-- / ' + formatTokenCount(limit)
  const title = usage
    ? '最近一轮模型请求的' + (usage.estimated ? '估算' : '实际') + '上下文用量：' + used.toLocaleString('zh-CN') + ' / ' + limit.toLocaleString('zh-CN') + ' tokens（' + percentage.toFixed(1) + '%）。每轮模型响应结束后更新，不是整个任务的累计用量。'
    : '尚无模型请求；上下文窗口 ' + limit.toLocaleString('zh-CN') + ' tokens'
  return <div className={'composer-context-usage ' + level} title={title} aria-label={title}>
    <span>当前上下文</span><i aria-hidden="true"><b style={{ width: percentage + '%' }} /></i><strong>{label}</strong>
  </div>
}

function TokenUsageView({ usage }: { usage: TokenUsage }): ReactElement {
  const prefix = usage.estimated ? '≈' : ''
  const speed = usage.durationMs > 0 ? usage.outputTokens / (usage.durationMs / 1000) : 0
  const inputTitle = '本次 Agent 任务所有模型请求的' + (usage.estimated ? '估算累计输入' : '累计输入') + '：' + usage.inputTokens.toLocaleString('zh-CN') + ' tokens'
  const outputTitle = '本次 Agent 任务所有模型请求的' + (usage.estimated ? '估算累计输出' : '累计输出') + '：' + usage.outputTokens.toLocaleString('zh-CN') + ' tokens，平均 ' + formatTokenRate(speed)
  return <div className={'token-usage ' + (usage.estimated ? 'estimated' : '')} aria-label={inputTitle + '；' + outputTitle}>
    <em title="本次 Agent 任务所有模型请求的累计用量">任务累计</em>
    <span title={inputTitle}><ArrowUp />{prefix}{formatTokenCount(usage.inputTokens)}</span>
    <span title={outputTitle}><ArrowDown />{prefix}{formatTokenCount(usage.outputTokens)}<small>{formatTokenRate(speed)}</small></span>
  </div>
}

function ResultArtifacts({ conversationId, artifacts }: { conversationId: string; artifacts: AgentArtifact[] }): ReactElement {
  const files = artifacts.filter((artifact): artifact is Extract<AgentArtifact, { type: 'file' }> => artifact.type === 'file')
  const services = [...new Set(artifacts
    .filter((artifact): artifact is Extract<AgentArtifact, { type: 'service' }> => artifact.type === 'service' && artifact.createdByAgent === true)
    .map((artifact) => normalizeServiceArtifactUrl(artifact.url))
    .filter((url): url is string => Boolean(url)))]
  const [opening, setOpening] = useState('')
  const [error, setError] = useState('')
  const [filesExpanded, setFilesExpanded] = useState(false)
  const [serviceMenu, setServiceMenu] = useState('')
  const [copiedUrl, setCopiedUrl] = useState('')
  const menuRef = useRef<HTMLDivElement | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const visibleFiles = filesExpanded ? files : files.slice(0, 3)
  useEffect(() => {
    if (!serviceMenu) return
    const closeMenu = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setServiceMenu('')
    }
    document.addEventListener('pointerdown', closeMenu)
    return () => document.removeEventListener('pointerdown', closeMenu)
  }, [serviceMenu])
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  if (!files.length && !services.length) return <></>

  async function openFile(path: string): Promise<void> {
    const key = 'file:' + path
    setOpening(key)
    setError('')
    try {
      const result = await window.api.openWorkspaceFile(conversationId, path)
      if (!result.ok) setError(result.message || '无法打开文件。')
    } catch {
      setError('无法打开文件。')
    } finally {
      setOpening('')
    }
  }

  async function openService(url: string): Promise<void> {
    const key = 'service:' + url
    setServiceMenu('')
    setOpening(key)
    setError('')
    try {
      const result = await window.api.openExternalUrl(url)
      if (!result.ok) setError(result.message || '无法打开 Web 服务。')
    } catch {
      setError('无法打开 Web 服务。')
    } finally {
      setOpening('')
    }
  }

  function copyServiceUrl(url: string): void {
    window.api.copyText(url)
    setCopiedUrl(url)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopiedUrl(''), 1600)
  }

  return <section className="result-artifacts" aria-label="任务产物">
    {files.length ? <div className="file-result-card">
      <div className="file-result-heading"><span className="result-card-icon file"><FileCode2 /></span><div><strong>已创建或编辑 {files.length} 个文件</strong><small>工作区文件</small></div></div>
      <div className="file-result-list">{visibleFiles.map((file) => {
        const key = 'file:' + file.path
        return <button type="button" key={key} className="file-result-row" disabled={Boolean(opening)} title={'使用本地应用打开 ' + file.path} onClick={() => void openFile(file.path)}><ArtifactFileIcon path={file.path} /><span><strong>{artifactFileName(file.path)}</strong><small>{file.path}</small></span>{opening === key ? <LoaderCircle className="artifact-spinner" /> : <ExternalLink />}</button>
      })}</div>
      {files.length > 3 ? <button type="button" className={'file-result-expand ' + (filesExpanded ? 'expanded' : '')} onClick={() => setFilesExpanded((expanded) => !expanded)}>{filesExpanded ? '收起文件' : '显示另外 ' + (files.length - 3) + ' 个文件'}<ChevronDown /></button> : null}
    </div> : null}
    {services.map((url) => {
      const key = 'service:' + url
      const menuOpen = serviceMenu === url
      return <div className="service-preview-card" key={key}>
        <span className="result-card-icon service"><Globe2 /></span>
        <div className="service-preview-details"><strong>网页预览</strong><small title={url}>{serviceDisplayName(url)} · 网站</small></div>
        <div className="service-open-control" ref={menuOpen ? menuRef : undefined}>
          <button type="button" className={'service-open-trigger ' + (menuOpen ? 'open' : '')} disabled={Boolean(opening)} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setServiceMenu(menuOpen ? '' : url)}>{opening === key ? <LoaderCircle className="artifact-spinner" /> : null}<span>{opening === key ? '打开中…' : '打开方式'}</span><ChevronDown /></button>
          {menuOpen ? <div className="service-open-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => void openService(url)}><ExternalLink /><span><strong>打开网页</strong><small>默认浏览器</small></span></button>
            <button type="button" role="menuitem" onClick={() => copyServiceUrl(url)}>{copiedUrl === url ? <Check /> : <Copy />}<span><strong>{copiedUrl === url ? '已复制' : '复制链接'}</strong><small>{url}</small></span></button>
          </div> : null}
        </div>
      </div>
    })}
    {error ? <p className="artifact-error" role="alert">{error}</p> : null}
  </section>
}

function ArtifactFileIcon({ path }: { path: string }): ReactElement {
  const normalized = path.toLowerCase().replaceAll('\\', '/')
  const extension = normalized.split('/').at(-1)?.split('.').at(-1) ?? ''
  if (extension === 'json' || extension === 'jsonc') return <FileJson2 />
  if (['html', 'htm', 'xml', 'vue', 'svelte'].includes(extension)) return <CodeXml />
  if (['css', 'scss', 'sass', 'less', 'styl'].includes(extension)) return <Palette />
  if (['md', 'mdx', 'txt', 'log'].includes(extension)) return <FileText />
  if (['sql', 'db', 'sqlite', 'sqlite3'].includes(extension)) return <Database />
  if (['yaml', 'yml', 'toml', 'ini', 'env', 'config'].includes(extension) || normalized.endsWith('/.gitignore')) return <FileCog />
  return <FileCode2 />
}

function artifactFileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || path
}

function serviceDisplayName(value: string): string {
  try {
    const url = new URL(value)
    return url.host || value
  } catch {
    return value
  }
}

function normalizeServiceArtifactUrl(value: string): string | undefined {
  const markdownTarget = /\]\((https?:\/\/[^\s)]+)\)?$/i.exec(value)?.[1]
  const candidate = (markdownTarget ?? value).replace(/[),.;\]，。；]+$/, '')
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') url.hostname = 'localhost'
    return url.toString()
  } catch {
    return undefined
  }
}

function AttachmentCard({ attachment, highlightQuery = '', onRemove, onPreview }: { attachment: ChatAttachment; highlightQuery?: string; onRemove?: () => void; onPreview?: () => void }): ReactElement {
  const isImage = isImageAttachmentType(attachment.mimeType)
  return <div className={'attachment-card ' + (isImage ? 'image' : 'file')} title={attachment.name}>
    {isImage ? <button type="button" className="attachment-image-button" aria-label={'查看原图 ' + attachment.name} onClick={onPreview}><img src={attachment.dataUrl} alt={attachment.name} /></button> : <div className="attachment-file-icon"><Icon name="file" /></div>}
    {!isImage ? <div className="attachment-file-meta"><strong>{highlightSearchNode(attachment.name, highlightQuery)}</strong><small>{formatBytes(attachment.size)}</small></div> : <span className="attachment-image-name">{highlightSearchNode(attachment.name, highlightQuery)}</span>}
    {onRemove ? <button type="button" className="attachment-remove" aria-label={'移除附件 ' + attachment.name} onClick={onRemove}><Icon name="close" /></button> : null}
  </div>
}

function readAttachment(file: File): Promise<ChatAttachment> {
  const mimeType = inferAttachmentMimeType(file.type, file.name)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('无法读取附件'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('无法读取附件'))
        return
      }
      resolve({ id: crypto.randomUUID(), name: file.name || 'clipboard-image.png', mimeType, size: file.size, dataUrl: reader.result })
    }
    reader.readAsDataURL(new Blob([file], { type: mimeType }))
  })
}

function getClipboardFiles(clipboardData: DataTransfer): File[] {
  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  return itemFiles.length ? itemFiles : Array.from(clipboardData.files)
}

function formatBytes(size: number): string {
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return Math.ceil(size / 1024) + ' KB'
  return (size / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatTokenCount(value: number): string {
  if (value < 1000) return value.toLocaleString('zh-CN')
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatTokenRate(value: number): string {
  const precision = value >= 100 ? 0 : 1
  return value.toFixed(precision) + ' tok/s'
}

function workspaceLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).at(-1) || '工作区'
}

function AgentProcess({ message }: { message: ChatMessage }): ReactElement {
  const steps = message.steps ?? []
  const flowItems = buildAgentFlowItems(steps)
  const isRunning = message.status === 'acting'
  // Keep the execution trace visible after the task finishes. The previous
  // status-controlled open prop remounted/collapsed the whole trace as soon
  // as the final response arrived, making Action and Observation appear to be
  // missing even though they had already been emitted.
  const [open, setOpen] = useState(true)
  const actionCount = steps.filter((item) => item.phase === 'act' && isToolActionStepTitle(item.title)).length
  const now = useNow(isRunning)
  const elapsed = formatElapsed(getElapsedMs(message, now))

  useEffect(() => {
    if (isRunning) setOpen(true)
  }, [isRunning])

  return <details className="agent-process agent-process-flow" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span>{isRunning ? '正在处理 ' + elapsed : '已处理 ' + elapsed}</span><small>{flowItems.length || 1} 个步骤 · {actionCount} 个工具</small></summary>
    <div className="agent-flow">
      {flowItems.length ? flowItems.map((item) => item.kind === 'tool'
        ? <AgentToolCallView key={item.action.id} action={item.action} liveOutput={item.liveOutput} observation={item.observation} />
        : <AgentStepView key={item.step.id} step={item.step} />
      ) : <AgentStatusLine status="thinking" text={isRunning ? THINKING_PLACEHOLDER : '本次没有返回执行过程。'} />}
    </div>
  </details>
}

type AgentFlowItem =
  | { kind: 'step'; step: TaskStep }
  | { kind: 'tool'; action: TaskStep; liveOutput?: TaskStep; observation?: TaskStep }

function buildAgentFlowItems(steps: TaskStep[]): AgentFlowItem[] {
  const items: AgentFlowItem[] = []
  const pendingTools: Array<Extract<AgentFlowItem, { kind: 'tool' }>> = []

  for (const taskStep of steps) {
    if (isHiddenInternalAgentStep(taskStep)) continue
    if (taskStep.phase === 'act' && isToolActionStepTitle(taskStep.title)) {
      const item: Extract<AgentFlowItem, { kind: 'tool' }> = { kind: 'tool', action: taskStep }
      items.push(item)
      pendingTools.push(item)
      continue
    }
    if (taskStep.phase === 'act' && taskStep.title.startsWith('命令实时输出：')) {
      const actionId = taskStep.title.replace(/^命令实时输出：/, '').trim()
      const item = pendingTools.find((candidate) => candidate.action.id === actionId)
      if (item) {
        item.liveOutput = taskStep
        continue
      }
    }
    if (taskStep.phase === 'act' && isObservationStepTitle(taskStep.title)) {
      const observationTool = observationToolName(taskStep.title)
      const pendingIndex = pendingTools.findIndex((item) => !item.observation && (!observationTool || normalizeToolLabel(getToolName(item.action)) === normalizeToolLabel(observationTool)))
      const item = pendingIndex >= 0 ? pendingTools.splice(pendingIndex, 1)[0] : undefined
      if (item) {
        item.observation = taskStep
        continue
      }
      // Deferred/skipped calls can produce internal observations without a
      // corresponding execution row. They are model context, not useful UI.
      continue
    }
    items.push({ kind: 'step', step: taskStep })
  }
  return items
}

function isObservationStepTitle(title: string): boolean {
  return title.startsWith('Observation #') || title.startsWith('工具结果')
}

function observationToolName(title: string): string {
  return title.replace(/^Observation\s+#\d+[：:]\s*/i, '').replace(/^工具结果[：:]\s*/, '').trim()
}

function normalizeToolLabel(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_')
}

function isToolActionStepTitle(title: string): boolean {
  return /^(?:正在执行工具|工具调用已延后|工具调用已跳过)[：:]/.test(title)
}

function toolActionState(title: string): 'running' | 'deferred' | 'skipped' {
  if (title.startsWith('工具调用已延后：') || title.startsWith('工具调用已延后:')) return 'deferred'
  if (title.startsWith('工具调用已跳过：') || title.startsWith('工具调用已跳过:')) return 'skipped'
  return 'running'
}

function AgentToolCallView({ action, liveOutput, observation }: { action: TaskStep; liveOutput?: TaskStep; observation?: TaskStep }): ReactElement {
  const actionState = toolActionState(action.title)
  const completed = Boolean(observation)
  const toolName = normalizeToolLabel(getToolName(action))
  const showLiveOutput = actionState === 'running' && !completed && Boolean(liveOutput)
  const commandRunning = actionState === 'running' && !completed && (toolName === 'run_command' || toolName === 'start_service')
  const summaryPrefix = actionState === 'deferred' ? '已延后：' : actionState === 'skipped' ? '已跳过：' : completed ? '已执行：' : '正在执行：'
  const summary = summaryPrefix + toolDisplayName(getToolName(action)) + (action.detail ? ' ' + action.detail : ' 无参数')
  const fileResult = observation && (toolName === 'edit_file' || toolName === 'write_file')
    ? parseFileChangeResult(observation.detail, toolName)
    : undefined
  const flowStatus = actionState === 'deferred' || actionState === 'skipped' ? 'info' : completed ? 'done' : 'running'
  return <CollapsibleFlowBlock className={'agent-flow-action agent-flow-tool-call ' + (completed ? 'done' : 'running') + (commandRunning ? ' command-running' : '')} forceOpen={showLiveOutput}>
    <summary><AgentStatusLine status={flowStatus} text={summary} /></summary>
    {showLiveOutput && liveOutput ? <CommandLiveOutput output={liveOutput.detail} /> : null}
    {observation ? <div className={'agent-flow-tool-result' + (fileResult?.diff ? ' has-edit-diff' : '')}>
      <span>执行结果</span>
      <pre>{fileResult?.summary ?? observation.detail}</pre>
      {fileResult?.diff ? <EditFileDiff path={fileResult.path} diff={fileResult.diff} /> : null}
    </div> : null}
  </CollapsibleFlowBlock>
}

function CommandLiveOutput({ output }: { output: string }): ReactElement {
  const outputRef = useRef<HTMLPreElement | null>(null)
  const startedAtRef = useRef(Date.now())
  const lastOutputAtRef = useRef(Date.now())
  const previousOutputRef = useRef(output)
  const now = useNow(true)
  if (previousOutputRef.current !== output) {
    previousOutputRef.current = output
    lastOutputAtRef.current = Date.now()
  }
  const runningFor = formatElapsed(now - startedAtRef.current)
  const idleFor = Math.max(0, now - lastOutputAtRef.current)
  const status = output
    ? idleFor < 2000 ? '刚刚更新' : formatElapsed(idleFor) + '无新内容'
    : '等待输出 · 已运行 ' + runningFor
  useLayoutEffect(() => {
    const element = outputRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [output])
  return <div className="agent-flow-command-live" role="log" aria-live="polite">
    <header><i /><span>实时输出</span><small>{status}</small></header>
    <pre ref={outputRef} className={output ? '' : 'empty'}>{output || '命令尚未产生 stdout/stderr…'}</pre>
  </div>
}

function EditFileDiff({ path, diff }: { path: string; diff: string }): ReactElement {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff])
  return <section className="edit-diff-view" aria-label={'文件修改：' + path}>
    <header className="edit-diff-header">
      <div className="edit-diff-file"><FileCode2 /><span>{path}</span></div>
      <div className="edit-diff-stats" aria-label="修改统计">
        <span className="added">新增 {parsed.added}</span>
        <span className="deleted">删除 {parsed.deleted}</span>
        <span className="modified">修改 {parsed.modified}</span>
      </div>
    </header>
    <div className="edit-diff-code" role="table" aria-label="代码差异">
      <div className="edit-diff-lines">
        {parsed.lines.map((line, index) => <EditDiffLine key={index} line={line} />)}
      </div>
    </div>
  </section>
}

function EditDiffLine({ line }: { line: UnifiedDiffLine }): ReactElement {
  if (line.kind === 'hunk' || line.kind === 'note') {
    return <div className={'edit-diff-line ' + line.kind} role="row"><span className="diff-meta">{line.content}</span></div>
  }
  const marker = line.kind === 'add' || line.kind === 'modify-new' ? '+' : line.kind === 'delete' || line.kind === 'modify-old' ? '−' : ' '
  return <div className={'edit-diff-line ' + line.kind} role="row">
    <span className="diff-line-number old" aria-label={line.oldLine ? '原第 ' + line.oldLine + ' 行' : undefined}>{line.oldLine ?? ''}</span>
    <span className="diff-line-number new" aria-label={line.newLine ? '新第 ' + line.newLine + ' 行' : undefined}>{line.newLine ?? ''}</span>
    <span className="diff-marker" aria-hidden="true">{marker}</span>
    <code>{line.content || ' '}</code>
  </div>
}

interface FileChangeResult {
  path: string
  summary: string
  diff?: string
}

function parseFileChangeResult(detail: string, toolName: string): FileChangeResult | undefined {
  try {
    const value = JSON.parse(detail) as { ok?: unknown; path?: unknown; replacements?: unknown; created?: unknown; diff?: unknown }
    if (value.ok !== true || typeof value.path !== 'string') return undefined
    if (toolName === 'edit_file' && typeof value.replacements !== 'number') return undefined
    if (toolName === 'write_file' && typeof value.created !== 'boolean') return undefined
    const summary = toolName === 'edit_file'
      ? '已编辑 ' + value.path + '，替换 ' + value.replacements + ' 处。'
      : (value.created ? '已创建并写入 ' : '已写入 ') + value.path + '。'
    return {
      path: value.path,
      summary,
      diff: typeof value.diff === 'string' && value.diff.trim() ? value.diff : undefined
    }
  } catch {
    return undefined
  }
}

function AgentStepView({ step: taskStep }: { step: TaskStep }): ReactElement {
  if (taskStep.phase === 'reason' && taskStep.title === THINKING_TITLE) {
    if (taskStep.detail === THINKING_PLACEHOLDER) return <AgentStatusLine status="thinking" text={THINKING_PLACEHOLDER} />
    return <p className="agent-flow-text">{conciseThought(taskStep.detail)}</p>
  }

  if (taskStep.phase === 'act' && isObservationStepTitle(taskStep.title)) {
    return <CollapsibleFlowBlock className="agent-flow-observation">
      <summary><AgentStatusLine status="observe" text="执行结果" /></summary>
      <pre>{taskStep.detail}</pre>
    </CollapsibleFlowBlock>
  }

  return <AgentStatusLine status={taskStep.phase === 'validate' ? 'done' : 'info'} text={taskStep.title + (taskStep.detail ? ' ' + taskStep.detail : '')} />
}

function conciseThought(detail: string): string {
  const withoutReasoning = hideReactObservationReferences(normalizeTechnicalPunctuation(detail))
    .replace(/<\s*(?:think|thought)\s*>[\s\S]*?<\s*\/\s*(?:think|thought)\s*>/gi, '')
    .replace(/<\s*(?:think|thought)\s*>[\s\S]*$/gi, '')
    .replace(/<\s*\/?\s*(?:think|thought)\s*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!withoutReasoning) return '已完成本轮思考。'
  return withoutReasoning.length <= 240 ? withoutReasoning : withoutReasoning.slice(0, 239).trimEnd() + '…'
}

function AgentStatusLine({ status, text }: { status: 'thinking' | 'running' | 'done' | 'observe' | 'info'; text: string }): ReactElement {
  return <div className={'agent-flow-status ' + status}><Icon name={status === 'thinking' ? 'clock' : status === 'observe' ? 'search-small' : 'monitor'} /><span>{text}</span></div>
}

function CollapsibleFlowBlock({ className, initialOpen = false, forceOpen = false, children }: { className: string; initialOpen?: boolean; forceOpen?: boolean; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(initialOpen)
  return <details className={className} open={forceOpen || open} onToggle={(event) => { if (!forceOpen) setOpen(event.currentTarget.open) }}>{children}</details>
}

function getToolName(taskStep: TaskStep): string {
  return taskStep.title.replace(/^(?:正在执行工具|工具调用已延后|工具调用已跳过)[：:]/, '').trim()
}

function toolDisplayName(name: string): string {
  return name === 'parse_powerpoint' ? '解析 PowerPoint' : name
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [enabled])

  return now
}

function getElapsedMs(message: ChatMessage, now: number): number {
  const start = Date.parse(message.steps?.[0]?.timestamp ?? message.createdAt)
  const end = message.status === 'acting' ? now : Date.parse(message.completedAt ?? message.steps?.at(-1)?.timestamp ?? message.createdAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0
  return end - start
}

function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return seconds + 's'
  return minutes + 'm ' + seconds + 's'
}

function SettingsPage({ settings, setSettings, policy, setPolicy, tab, setTab, onBack, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; policy: AgentPolicy; setPolicy: (value: AgentPolicy) => void; tab: SettingTab; setTab: (value: SettingTab) => void; onBack: () => void; onSave: (settingsOverride?: AppSettings) => Promise<void> }): ReactElement {
  const groups: Array<{ title: string; tabs: SettingTab[] }> = [{ title: '个人', tabs: ['常规', '外观', '配置', '个性化'] }, { title: '编码', tabs: ['Git', '环境'] }]
  const content = tab === '常规'
    ? <GeneralSettings settings={settings} setSettings={setSettings} onSave={onSave} />
    : tab === '外观'
      ? <AppearanceSettingsPage settings={settings} setSettings={setSettings} onSave={onSave} />
      : tab === '个性化'
        ? <PersonalizationSettingsPage settings={settings} setSettings={setSettings} onSave={onSave} />
        : tab === '配置'
          ? <ConfigSettings title={tab} settings={settings} setSettings={setSettings} policy={policy} setPolicy={setPolicy} onSave={onSave} />
          : <SettingsPlaceholder title={tab} />
  const tabIcon = (item: SettingTab): ReactElement => item === '常规'
    ? <SettingsIcon />
    : item === '外观'
      ? <Palette />
      : item === '个性化'
        ? <Bot />
        : <Icon name={item === 'Git' ? 'branch' : item === '环境' ? 'monitor' : 'shield'} />
  return <div className="settings-app">
    <header className="window-bar"><Icon name="panel" className="bar-icon" /><button className="bar-icon-button"><Icon name="chevron-left" /></button><button className="bar-icon-button"><Icon name="chevron-right" /></button><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span></header>
    <aside className="settings-nav"><button className="back-to-app" onClick={onBack}><Icon name="chevron-left" />返回应用</button><div className="settings-search"><Icon name="search-small" /><input placeholder="搜索设置…" /></div>{groups.map((group) => <section key={group.title}><p>{group.title}</p>{group.tabs.map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{tabIcon(item)}{item}</button>)}</section>)}</aside>
    <main className="settings-content">{content}</main>
  </div>
}

function NavigationSettingsSection({ settings, setSettings }: { settings: AppSettings; setSettings: (value: AppSettings) => void }): ReactElement {
  const [selecting, setSelecting] = useState<'file' | 'browser' | undefined>()
  async function selectApplication(kind: 'file' | 'browser'): Promise<void> {
    setSelecting(kind)
    try {
      const selectedPath = await window.api.selectApplication(kind)
      if (!selectedPath) return
      setSettings({
        ...settings,
        navigation: {
          ...settings.navigation,
          [kind === 'file' ? 'fileApplicationPath' : 'browserApplicationPath']: selectedPath
        }
      })
    } finally {
      setSelecting(undefined)
    }
  }
  function resetApplication(kind: 'file' | 'browser'): void {
    setSettings({
      ...settings,
      navigation: {
        ...settings.navigation,
        [kind === 'file' ? 'fileApplicationPath' : 'browserApplicationPath']: ''
      }
    })
  }
  const rows = [
    { kind: 'file' as const, title: '代码和文本文件', description: '用于打开代码、Markdown、配置和其他文本文件。', path: settings.navigation.fileApplicationPath, icon: <FileCode2 /> },
    { kind: 'browser' as const, title: 'Web 浏览器', description: '用于打开任务产生的 HTTP 和 HTTPS 服务地址。', path: settings.navigation.browserApplicationPath, icon: <Globe2 /> }
  ]
  return <section className="settings-section navigation-settings">
      <h2>打开方式</h2>
      <p>配置代码文件和网页服务的默认打开应用；未指定时使用操作系统默认设置。</p>
      <div className="application-list">{rows.map((row) => <div className="application-row" key={row.kind}>
        <span className="application-type-icon">{row.icon}</span>
        <div className="application-details"><strong>{row.title}</strong><p>{row.description}</p><code title={row.path || '使用系统默认'}>{row.path || '使用系统默认'}</code></div>
        <div className="application-actions">
          <button type="button" className="application-select" disabled={Boolean(selecting)} onClick={() => void selectApplication(row.kind)}><FolderOpen />{selecting === row.kind ? '选择中…' : '选择应用'}</button>
          <button type="button" className="application-reset" disabled={!row.path || Boolean(selecting)} aria-label={'恢复' + row.title + '的系统默认应用'} title="恢复系统默认" onClick={() => resetApplication(row.kind)}><RotateCcw /></button>
        </div>
      </div>)}</div>
    </section>
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): ReactElement { return <button type="button" className={'toggle-switch ' + (checked ? 'on' : '')} onClick={() => onChange(!checked)}><i /></button> }
function GeneralSettings({ settings, setSettings, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; onSave: (settingsOverride?: AppSettings) => Promise<void> }): ReactElement {
  const selectedMode = settings.permissionMode ?? 'request_approval'
  const [saved, setSaved] = useState(false)
  async function save(): Promise<void> { await onSave(); setSaved(true) }
  return <div className="settings-inner"><h1>常规</h1><section className="settings-section"><h2>工作模式</h2><p>选择 Agent 展示和执行任务的方式。</p><div className="mode-cards"><button className="mode-card selected"><Icon name="monitor" /><span><strong>适用于编程</strong><small>更具技术性的回复和控制</small></span><b><Icon name="check" /></b></button><button className="mode-card"><Icon name="message" /><span><strong>适用于日常工作</strong><small>同样强大，技术细节更少</small></span><b /></button></div></section><section className="settings-section"><h2>权限</h2><p>选择 Agent 何时可自动执行，以及哪些操作需要您的批准。</p><div className="permission-option-list">{permissionModes.map((mode) => <button type="button" className={'permission-option ' + (selectedMode === mode.value ? 'selected' : '')} key={mode.value} onClick={() => { setSaved(false); setSettings({ ...settings, permissionMode: mode.value }) }}><span className="permission-option-icon"><Icon name="shield" /></span><span><strong>{mode.label}</strong><small>{mode.description}</small></span><b>{selectedMode === mode.value ? <Check /> : null}</b></button>)}</div></section><NavigationSettingsSection settings={settings} setSettings={(value) => { setSaved(false); setSettings(value) }} /><button className="settings-save" onClick={() => void save()}>保存更改</button>{saved ? <div className="config-notice success"><Check />常规设置已保存。</div> : null}</div>
}

function AppearanceSettingsPage({ settings, setSettings, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; onSave: (settingsOverride?: AppSettings) => Promise<void> }): ReactElement {
  const appearance = appearanceSettings(settings)
  const [saved, setSaved] = useState(false)
  const themes: Array<{ value: ThemePreference; label: string; description: string; icon: ReactElement }> = [
    { value: 'system', label: '跟随系统', description: '自动匹配操作系统外观', icon: <Icon name="monitor" /> },
    { value: 'light', label: '浅色', description: '始终使用明亮界面', icon: <Sun /> },
    { value: 'dark', label: '深色', description: '始终使用深色界面', icon: <Moon /> }
  ]
  function update(patch: Partial<AppearanceSettings>): void { setSaved(false); setSettings({ ...settings, appearance: { ...appearance, ...patch } }) }
  async function save(): Promise<void> { await onSave(); setSaved(true) }
  return <div className="settings-inner appearance-settings"><h1>外观</h1>
    <section className="settings-section"><h2>主题</h2><p>主题会立即预览，保存后在下次启动时继续使用。</p><div className="preference-cards theme-cards">{themes.map((theme) => <button type="button" key={theme.value} className={'preference-card ' + (appearance.theme === theme.value ? 'selected' : '')} onClick={() => update({ theme: theme.value })}>{theme.icon}<span><strong>{theme.label}</strong><small>{theme.description}</small></span><b>{appearance.theme === theme.value ? <Check /> : null}</b></button>)}</div></section>
    <section className="settings-section"><h2>字体</h2><p>分别设置对话内容和客户端界面的字体；对话字号不会缩放侧栏与菜单。</p><div className="appearance-fields"><label>对话字体<select value={appearance.chatFontFamily} onChange={(event) => update({ chatFontFamily: event.target.value as FontFamilyPreference })}>{fontOptions.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label><label>客户端字体<select value={appearance.uiFontFamily} onChange={(event) => update({ uiFontFamily: event.target.value as FontFamilyPreference })}>{fontOptions.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label><label className="chat-font-size">对话字号 <output>{appearance.fontSize}px</output><input type="range" min="12" max="18" step="1" value={appearance.fontSize} onChange={(event) => update({ fontSize: Number(event.target.value) })} /></label></div><div className="font-preview"><span>对话字体预览</span><p style={{ fontFamily: fontStacks[appearance.chatFontFamily], fontSize: appearance.fontSize }}>Agent 会使用清晰舒适的文字陪你完成任务。Aa 123</p></div></section>
    <button className="settings-save" onClick={() => void save()}>保存更改</button>{saved ? <div className="config-notice success"><Check />外观设置已保存。</div> : null}
  </div>
}

function PersonalizationSettingsPage({ settings, setSettings, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; onSave: (settingsOverride?: AppSettings) => Promise<void> }): ReactElement {
  const personalization = settings.personalization ?? { tone: 'balanced' as AgentTone, customInstructions: '' }
  const [saved, setSaved] = useState(false)
  const tones: Array<{ value: AgentTone; label: string; description: string }> = [
    { value: 'balanced', label: '自然平衡', description: '根据任务自动调整表达深度' },
    { value: 'concise', label: '简洁直接', description: '优先结论，减少重复说明' },
    { value: 'professional', label: '专业严谨', description: '表达准确、克制且结构清晰' },
    { value: 'friendly', label: '友好自然', description: '像可靠的协作伙伴一样沟通' }
  ]
  function update(patch: Partial<typeof personalization>): void { setSaved(false); setSettings({ ...settings, personalization: { ...personalization, ...patch } }) }
  async function save(): Promise<void> { await onSave(); setSaved(true) }
  return <div className="settings-inner personalization-settings"><h1>个性化</h1>
    <section className="settings-section"><h2>Agent 语气</h2><p>控制最终回复的表达风格，不影响工具能力和安全规则。</p><div className="tone-grid">{tones.map((tone) => <button type="button" key={tone.value} className={'tone-card ' + (personalization.tone === tone.value ? 'selected' : '')} onClick={() => update({ tone: tone.value })}><span><strong>{tone.label}</strong><small>{tone.description}</small></span><b>{personalization.tone === tone.value ? <Check /> : null}</b></button>)}</div></section>
    <section className="settings-section"><h2>自定义指令</h2><p>告诉 Agent 长期需要遵循的偏好。当前任务、安全策略和工具协议始终优先。</p><textarea className="custom-instructions" maxLength={4000} value={personalization.customInstructions} onChange={(event) => update({ customInstructions: event.target.value })} placeholder="例如：默认使用中文回答；修改代码后说明验证结果；不要在结论中重复问题。" /><div className="instruction-count">{personalization.customInstructions.length.toLocaleString('zh-CN')} / 4,000</div></section>
    <button className="settings-save" onClick={() => void save()}>保存更改</button>{saved ? <div className="config-notice success"><Check />个性化设置已保存。</div> : null}
  </div>
}

function SettingsPlaceholder({ title }: { title: string }): ReactElement {
  return <div className="settings-inner"><h1>{title}</h1><section className="settings-section"><h2>即将支持</h2><p>此区域将在后续版本中提供更多配置。</p></section></div>
}
function ConfigSettings({ title, settings, setSettings, policy, setPolicy, onSave }: { title: string; settings: AppSettings; setSettings: (value: AppSettings) => void; policy: AgentPolicy; setPolicy: (value: AgentPolicy) => void; onSave: (settingsOverride?: AppSettings) => Promise<void> }): ReactElement {
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [apiKeyCopied, setApiKeyCopied] = useState(false)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | undefined>()
  const profiles = getModelProfiles(settings)
  const defaultProfile = getDefaultModelProfile(settings)
  const [selectedModelId, setSelectedModelId] = useState(defaultProfile?.id ?? '')
  const selectedProfile = profiles.find((profile) => profile.id === selectedModelId) ?? defaultProfile
  useEffect(() => {
    if (!profiles.some((profile) => profile.id === selectedModelId)) setSelectedModelId(defaultProfile?.id ?? '')
  }, [defaultProfile?.id, profiles, selectedModelId])
  useEffect(() => () => { if (copyResetTimer.current) clearTimeout(copyResetTimer.current) }, [])
  function settingsWithProfiles(nextProfiles: ModelProfile[], requestedDefaultId = settings.defaultModelId ?? profiles[0]?.id): AppSettings | undefined {
    const nextDefault = nextProfiles.find((profile) => profile.id === requestedDefaultId) ?? nextProfiles[0]
    if (!nextDefault) return undefined
    return { ...settings, models: nextProfiles, defaultModelId: nextDefault.id, model: modelConfig(nextDefault) }
  }
  function commitProfiles(nextProfiles: ModelProfile[], requestedDefaultId = settings.defaultModelId ?? profiles[0]?.id): void {
    const nextSettings = settingsWithProfiles(nextProfiles, requestedDefaultId)
    if (nextSettings) setSettings(nextSettings)
  }
  function updateSelectedProfile(patch: Partial<ModelProfile>): void {
    if (!selectedProfile) return
    commitProfiles(profiles.map((profile) => profile.id === selectedProfile.id ? { ...profile, ...patch } : profile))
  }
  async function addModel(profile: ModelProfile): Promise<void> {
    const nextSettings = settingsWithProfiles([...profiles, profile], settings.defaultModelId ?? profiles[0]?.id)
    if (!nextSettings) throw new Error('无法创建模型配置。')
    setSettings(nextSettings)
    try {
      await onSave(nextSettings)
      setSelectedModelId(profile.id)
      setApiKeyVisible(false)
      setApiKeyCopied(false)
      setNotice({ type: 'success', text: '模型配置已保存并添加到列表。' })
    } catch (error) {
      setSettings(settings)
      throw error
    }
  }
  function removeSelectedModel(): void {
    if (!selectedProfile || profiles.length <= 1) {
      setNotice({ type: 'error', text: '至少保留一个模型配置。' })
      return
    }
    const nextProfiles = profiles.filter((profile) => profile.id !== selectedProfile.id)
    const nextDefaultId = selectedProfile.id === defaultProfile.id ? nextProfiles[0].id : settings.defaultModelId
    commitProfiles(nextProfiles, nextDefaultId)
    setSelectedModelId(nextDefaultId === selectedProfile.id ? nextProfiles[0].id : nextDefaultId ?? nextProfiles[0].id)
  }
  function setDefaultModel(): void {
    if (selectedProfile) commitProfiles(profiles, selectedProfile.id)
  }
  async function save(): Promise<void> { setSaving(true); setNotice(undefined); try { await onSave(); setNotice({ type: 'success', text: '配置已保存到本地。' }) } catch { setNotice({ type: 'error', text: '保存失败，请重试。' }) } finally { setSaving(false) } }
  async function test(): Promise<void> { setTesting(true); setNotice(undefined); try { const result = await window.api.testConnection(settings, selectedProfile?.id); setNotice({ type: result.ok ? 'success' : 'error', text: result.message }) } finally { setTesting(false) } }
  function copyApiKey(): void {
    if (!selectedProfile?.apiKey) return
    window.api.copyText(selectedProfile.apiKey)
    setApiKeyCopied(true)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => setApiKeyCopied(false), 1600)
  }
  const toolLabels: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    edit_file: '编辑文件',
    create_directory: '创建目录',
    list_files: '列举文件',
    decrypt_file: '文件解密',
    parse_word: '解析 Word',
    parse_excel: '解析 Excel',
    parse_powerpoint: '解析 PowerPoint',
    run_command: '执行命令行',
    start_service: '启动 Web 服务'
  }
  function toggleTool(name: string): void { setPolicy({ ...policy, enabledTools: policy.enabledTools.includes(name) ? policy.enabledTools.filter((item) => item !== name) : [...policy.enabledTools, name] }) }

  return <div className="settings-inner">
    <h1>{title}</h1>
    <section className="settings-section compact">
      <div className="model-settings-heading"><div><h2>模型配置</h2><p>管理厂商模型、OpenAI 兼容服务和 API 中转站，并在每个会话中独立选择。</p></div><button type="button" className="model-add-button" onClick={() => setAddModelOpen(true)}><Plus />添加模型</button></div>
      <div className="model-profile-list">{profiles.map((profile) => <div className={'model-profile-row ' + (profile.id === selectedProfile?.id ? 'selected' : '')} key={profile.id}><button type="button" className="model-profile-select" onClick={() => { setSelectedModelId(profile.id); setApiKeyVisible(false); setApiKeyCopied(false) }}><Bot /><span><strong>{profile.name}</strong><small>{modelConnectionTypeLabel(profile.connectionType)} · {profile.provider || 'OpenAI 兼容'} · {profile.model || '未填写模型名称'}</small></span></button><button type="button" className={'model-default-button ' + (profile.id === defaultProfile?.id ? 'active' : '')} onClick={() => { setSelectedModelId(profile.id); commitProfiles(profiles, profile.id) }} title={profile.id === defaultProfile?.id ? '默认模型' : '设为默认模型'} aria-label={profile.id === defaultProfile?.id ? '默认模型' : '设为默认模型'}>{profile.id === defaultProfile?.id ? <Star fill="currentColor" /> : <Star />}</button></div>)}</div>
      {selectedProfile ? <>
        <div className="model-profile-toolbar"><span>编辑模型</span><button type="button" className="model-delete-button" onClick={removeSelectedModel} title="删除当前模型" aria-label="删除当前模型"><Trash2 />删除</button></div>
        <label>显示名称（配置标签）<input value={selectedProfile.name} onChange={(event) => updateSelectedProfile({ name: event.target.value })} placeholder="例如：生产 GPT" /></label>
        <label>模型厂商 / 提供方<input list="model-provider-options" value={selectedProfile.provider || ''} onChange={(event) => updateSelectedProfile({ provider: event.target.value })} placeholder="例如：OpenAI、DeepSeek、内部网关" /></label>
        <datalist id="model-provider-options"><option value="OpenAI" /><option value="Azure OpenAI" /><option value="DeepSeek" /><option value="通义千问" /><option value="OpenRouter" /><option value="OpenAI 兼容" /></datalist>
        <label>接口地址<input value={selectedProfile.baseUrl} onChange={(event) => updateSelectedProfile({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
        <label>模型名称<input value={selectedProfile.model} onChange={(event) => { const model = event.target.value; updateSelectedProfile({ model, ...(selectedProfile.name.trim() === selectedProfile.model.trim() || !selectedProfile.name.trim() ? { name: model } : {}) }) }} placeholder="gpt-4.1-mini" /></label>
        <div className="model-context-grid">
          <label>上下文窗口（tokens）<input type="number" min="4096" max="4000000" step="1024" value={selectedProfile.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS} onChange={(event) => updateSelectedProfile({ contextWindowTokens: Number(event.target.value) || DEFAULT_CONTEXT_WINDOW_TOKENS })} /></label>
          <label>最大输出（tokens）<input type="number" min="256" max="1000000" step="256" value={selectedProfile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS} onChange={(event) => updateSelectedProfile({ maxOutputTokens: Number(event.target.value) || DEFAULT_MAX_OUTPUT_TOKENS })} /></label>
        </div>
      <div className="api-key-field">
        <label htmlFor="model-api-key">API Key <small className="optional-field">（可选）</small></label>
        <div className="api-key-input">
          <input id="model-api-key" type={apiKeyVisible ? 'text' : 'password'} value={selectedProfile.apiKey} onChange={(event) => { setApiKeyCopied(false); updateSelectedProfile({ apiKey: event.target.value }) }} placeholder="无需鉴权的自定义接口可留空" autoComplete="off" spellCheck={false} />
          <div className="api-key-actions">
            <button type="button" className="api-key-action" disabled={!selectedProfile.apiKey} aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} aria-pressed={apiKeyVisible} title={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} onClick={() => setApiKeyVisible((visible) => !visible)}>{apiKeyVisible ? <EyeOff /> : <Eye />}</button>
            <button type="button" className={'api-key-action ' + (apiKeyCopied ? 'copied' : '')} disabled={!selectedProfile.apiKey} aria-label={apiKeyCopied ? 'API Key 已复制' : '复制 API Key'} title={apiKeyCopied ? '已复制' : '复制 API Key'} onClick={copyApiKey}>{apiKeyCopied ? <Check /> : <Copy />}</button>
          </div>
        </div>
      </div>
      <div className="model-protocol-note"><Bot /><span><strong>接口协议</strong><small>OpenAI 兼容 · POST /chat/completions</small></span></div>
      </> : null}
    </section>
    <div className="config-actions model-config-actions"><button className="connection-test" onClick={() => void test()} disabled={testing || saving || !selectedProfile}>{testing ? '正在测试…' : '测试当前模型'}</button>{selectedProfile && selectedProfile.id !== defaultProfile?.id ? <button type="button" className="set-default-button" onClick={setDefaultModel}><Star />设为默认</button> : null}<button className={'settings-save ' + (saving ? 'is-loading' : '')} onClick={() => void save()} disabled={saving || testing}>{saving ? '保存中…' : '保存更改'}</button></div>
    {notice && <div className="model-config-notice"><div className={'config-notice ' + notice.type}>{notice.type === 'success' ? <Icon name="check" /> : <SettingsIcon />}{notice.text}</div></div>}
    <KnowledgeBaseSettings settings={settings} setSettings={setSettings} onSave={onSave} />
    <section className="settings-section compact">
      <h2>系统提示词</h2>
      <p>每次请求模型时都会携带这段系统级约束。</p>
      <textarea className="system-prompt" value={policy.systemPrompt} onChange={(event) => setPolicy({ ...policy, systemPrompt: event.target.value })} />
    </section>
    <section className="settings-section compact">
      <h2>内置工具</h2>
      <p>工具默认使用工作区 <code>{policy.workspacePath}</code>；外部路径和风险操作由当前权限模式控制。</p>
      <div className="tool-list">{Object.entries(toolLabels).map(([name, label]) => <label key={name} className="tool-toggle"><span><strong>{label}</strong><small>{name}</small></span><Toggle checked={policy.enabledTools.includes(name)} onChange={() => toggleTool(name)} /></label>)}</div>
    </section>
    {addModelOpen ? <AddModelDialog onClose={() => setAddModelOpen(false)} onSave={addModel} /> : null}
  </div>
}

interface ModelAccessOption { id: string; connectionType: ModelConnectionType; label: string; description: string; provider: string; baseUrl: string }

const modelAccessOptions: ModelAccessOption[] = [
  { id: 'openai', connectionType: 'provider', label: 'OpenAI', description: 'OpenAI 官方 API', provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', connectionType: 'provider', label: 'DeepSeek', description: 'DeepSeek 官方 API', provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'qwen', connectionType: 'provider', label: '通义千问', description: '阿里云百炼 OpenAI 兼容接口', provider: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'zhipu', connectionType: 'provider', label: '智谱 AI', description: '智谱开放平台 OpenAI 兼容接口', provider: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'moonshot', connectionType: 'provider', label: 'Moonshot', description: 'Moonshot AI 官方 API', provider: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'gemini', connectionType: 'provider', label: 'Google Gemini', description: 'Gemini API 的 OpenAI 兼容接口', provider: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'xai', connectionType: 'provider', label: 'xAI', description: 'xAI 官方 API', provider: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  { id: 'openai-compatible', connectionType: 'openai_compatible', label: 'OpenAI 兼容', description: 'Ollama、vLLM、LM Studio 或其他兼容服务', provider: 'OpenAI 兼容', baseUrl: '' },
  { id: 'relay', connectionType: 'relay', label: '中转站 / 企业网关', description: 'API 中转、聚合平台或企业内部网关', provider: '中转站', baseUrl: '' }
]

function modelConnectionTypeLabel(type?: ModelConnectionType): string {
  return type === 'openai_compatible' ? 'OpenAI 兼容' : type === 'relay' ? '中转站' : '模型厂商'
}

function createModelDraft(accessOption: ModelAccessOption = modelAccessOptions[0]): ModelProfile {
  return {
    id: crypto.randomUUID(),
    name: '',
    provider: accessOption.provider,
    connectionType: accessOption.connectionType,
    baseUrl: accessOption.baseUrl,
    apiKey: '',
    model: '',
    timeoutMs: 300000,
    maxRetries: 3,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS
  }
}

function AddModelDialog({ onClose, onSave }: { onClose: () => void; onSave: (profile: ModelProfile) => Promise<void> }): ReactElement {
  const [draft, setDraft] = useState<ModelProfile>(() => createModelDraft())
  const [accessOptionId, setAccessOptionId] = useState(modelAccessOptions[0].id)
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const selectedAccess = modelAccessOptions.find((option) => option.id === accessOptionId) ?? modelAccessOptions[0]
  const connectionType = selectedAccess.connectionType
  const providerAddressLocked = connectionType === 'provider'

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, saving])

  function update(patch: Partial<ModelProfile>): void {
    setError('')
    setDraft((current) => ({ ...current, ...patch }))
  }

  function selectAccessOption(optionId: string): void {
    const option = modelAccessOptions.find((item) => item.id === optionId) ?? modelAccessOptions[0]
    setError('')
    setApiKeyVisible(false)
    setAccessOptionId(option.id)
    setDraft((current) => ({ ...current, connectionType: option.connectionType, provider: option.provider, baseUrl: option.baseUrl }))
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    const provider = draft.provider?.trim() || selectedAccess.provider
    const baseUrl = draft.baseUrl.trim().replace(/\/+$/, '')
    const model = draft.model.trim()
    const contextWindowTokens = Math.floor(draft.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS)
    const maxOutputTokens = Math.floor(draft.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)
    if (!baseUrl) {
      setError('请填写 API 基础地址。')
      return
    }
    try {
      const parsedUrl = new URL(baseUrl)
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('unsupported protocol')
    } catch {
      setError('API 基础地址必须是有效的 HTTP 或 HTTPS 地址。')
      return
    }
    if (!model) {
      setError('请填写请求使用的模型名称。')
      return
    }
    if (contextWindowTokens < 4096 || contextWindowTokens > 4_000_000) {
      setError('上下文窗口需要在 4,096 到 4,000,000 tokens 之间。')
      return
    }
    if (maxOutputTokens < 256 || maxOutputTokens > Math.min(1_000_000, Math.floor(contextWindowTokens * 0.5))) {
      setError('最大输出需要在 256 tokens 到上下文窗口一半之间。')
      return
    }
    const profile: ModelProfile = {
      ...draft,
      name: draft.name.trim() || model,
      provider,
      baseUrl,
      model,
      apiKey: draft.apiKey.trim(),
      contextWindowTokens,
      maxOutputTokens
    }
    setSaving(true)
    setError('')
    try {
      await onSave(profile)
      onClose()
    } catch {
      setError('保存模型失败，请检查配置后重试。')
    } finally {
      setSaving(false)
    }
  }

  const addressPlaceholder = connectionType === 'relay'
      ? 'https://中转站或企业网关地址/v1'
      : 'http://127.0.0.1:8000/v1'

  return <div className="model-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <form className="model-dialog" role="dialog" aria-modal="true" aria-labelledby="add-model-title" onSubmit={(event) => void submit(event)}>
      <header className="model-dialog-header"><div><h2 id="add-model-title">添加模型</h2><p>选择接入方式并填写模型连接信息。</p></div><button type="button" disabled={saving} onClick={onClose} aria-label="关闭添加模型窗口" title="关闭"><Icon name="close" /></button></header>
      <div className="model-dialog-body">
        <section className="model-dialog-section"><h3>接入方式</h3><div className="model-access-select"><select value={accessOptionId} onChange={(event) => selectAccessOption(event.target.value)} autoFocus><optgroup label="模型厂商">{modelAccessOptions.filter((option) => option.connectionType === 'provider').map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup><optgroup label="自定义服务">{modelAccessOptions.filter((option) => option.connectionType !== 'provider').map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup></select><p>{selectedAccess.description}</p></div></section>
        <section className="model-dialog-section model-dialog-fields"><h3>连接信息</h3>
          <div className="model-dialog-grid">
            <label><span>显示名称 <small>（可选）</small></span><input value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：生产环境 GPT" /></label>
            <label>{connectionType === 'provider' ? '模型厂商' : '服务提供方'}<input list={providerAddressLocked ? undefined : 'add-model-provider-options'} value={draft.provider || ''} readOnly={providerAddressLocked} onChange={(event) => update({ provider: event.target.value })} placeholder={selectedAccess.provider} /></label>
          </div>
          <datalist id="add-model-provider-options"><option value="OpenAI" /><option value="Azure OpenAI" /><option value="DeepSeek" /><option value="通义千问" /><option value="智谱 AI" /><option value="Moonshot" /><option value="OpenRouter" /><option value="硅基流动" /><option value="OpenAI 兼容" /><option value="企业网关" /></datalist>
          <label><span>API 基础地址 {providerAddressLocked ? <small>（厂商默认，不可修改）</small> : null}</span><input value={draft.baseUrl} readOnly={providerAddressLocked} onChange={(event) => update({ baseUrl: event.target.value })} placeholder={addressPlaceholder} spellCheck={false} /></label>
          <label>模型名称<input value={draft.model} onChange={(event) => { const model = event.target.value; update({ model, ...(!draft.name.trim() || draft.name.trim() === draft.model.trim() ? { name: model } : {}) }) }} placeholder="模型接口使用的 model 标识" spellCheck={false} /></label>
          <div className="model-dialog-grid model-dialog-token-grid">
            <label>上下文窗口（tokens）<input type="number" min="4096" max="4000000" step="1024" value={draft.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS} onChange={(event) => update({ contextWindowTokens: Number(event.target.value) || DEFAULT_CONTEXT_WINDOW_TOKENS })} /></label>
            <label>最大输出（tokens）<input type="number" min="256" max="1000000" step="256" value={draft.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS} onChange={(event) => update({ maxOutputTokens: Number(event.target.value) || DEFAULT_MAX_OUTPUT_TOKENS })} /></label>
          </div>
          <div className="model-dialog-api-key"><label htmlFor="new-model-api-key"><span>API Key <small>（可选）</small></span></label><div><input id="new-model-api-key" type={apiKeyVisible ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => update({ apiKey: event.target.value })} placeholder="无需鉴权时可留空" autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setApiKeyVisible((visible) => !visible)} aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} title={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'}>{apiKeyVisible ? <EyeOff /> : <Eye />}</button></div></div>
          <div className="model-dialog-protocol"><CodeXml /><span><strong>OpenAI 兼容协议</strong><small>请求将发送到 POST /chat/completions</small></span></div>
        </section>
        {error ? <div className="model-dialog-error" role="alert"><SettingsIcon />{error}</div> : null}
      </div>
      <footer className="model-dialog-footer"><button type="button" className="model-dialog-cancel" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="model-dialog-save" disabled={saving}>{saving ? <><LoaderCircle />保存中…</> : '保存模型'}</button></footer>
    </form>
  </div>
}
