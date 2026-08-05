import { FormEvent, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type SVGProps } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, CodeXml, Copy, Database, ExternalLink, Eye, EyeOff, FileCode2, FileCog, FileJson2, FileText, FolderOpen, Globe2, LoaderCircle, Palette, RotateCcw, SquareTerminal } from 'lucide-react'
import type { AgentArtifact, AgentPolicy, AppSettings, ChatAttachment, ChatMessage, CommandApprovalRequest, Conversation, McpApprovalRequest, TaskStatus, TaskStep, UserChoiceRequest } from '../../shared/types'
import {
  ATTACHMENT_ACCEPT,
  inferAttachmentMimeType,
  isImageAttachmentType,
  isOfficeAttachmentType,
  isSupportedAttachmentType,
  MAX_ATTACHMENT_COUNT,
  MAX_IMAGE_ATTACHMENT_SIZE,
  MAX_OFFICE_ATTACHMENT_SIZE,
  MAX_TEXT_ATTACHMENT_SIZE,
  MAX_TOTAL_ATTACHMENT_SIZE
} from '../../shared/attachments'

type IconName = 'panel' | 'chevron-left' | 'chevron-right' | 'message' | 'search' | 'skills' | 'clock' | 'folder' | 'settings' | 'plus' | 'shield' | 'chevron-down' | 'send' | 'pause' | 'monitor' | 'branch' | 'search-small' | 'check' | 'trash' | 'file' | 'close'
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
  settings: <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="1.8" /><circle cx="15" cy="12" r="1.8" /><circle cx="11" cy="17" r="1.8" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  shield: <path d="M12 3 19 6v5c0 4.3-2.7 7.7-7 10-4.3-2.3-7-5.7-7-10V6z" />,
  'chevron-down': <path d="m7 10 5 5 5-5" />,
  send: <path d="m5 12 14-7-4 14-3-5zM12 12l3-3" />,
  pause: <><rect x="7" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  branch: <><path d="M6 3v12" /><circle cx="6" cy="3" r="2" /><circle cx="6" cy="15" r="2" /><circle cx="18" cy="7" r="2" /><path d="M8 15c6 0 2-8 8-8" /></>,
  'search-small': <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 14h10l1-14" /><path d="M9 7V4h6v3" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
  close: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>
}

const initialSettings: AppSettings = {
  model: { baseUrl: '', apiKey: '', model: '', timeoutMs: 300000, maxRetries: 3 },
  skillsEnabled: true,
  navigation: { fileApplicationPath: '', browserApplicationPath: '' }
}
const statusText: Record<TaskStatus, string> = { pending: '等待中', reasoning: '分析中', acting: '执行中', validating: '校验中', succeeded: '已完成', failed: '失败', paused: '已暂停' }
const THINKING_TITLE = '思考过程'
const THINKING_PLACEHOLDER = '思考中…'
const LOCAL_ASSISTANT_PREFIX = 'local-agent-'
const LOCAL_STEP_PREFIX = 'local-step-'
type View = 'chat' | 'settings'
type SettingTab = '常规' | '外观' | '配置' | '个性化' | '打开方式' | 'Git' | '环境'

function Icon({ name, ...props }: IconProps): ReactElement {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
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
  const [view, setView] = useState<View>('chat')
  const [tab, setTab] = useState<SettingTab>('常规')
  const messageListRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentsRef = useRef<ChatAttachment[]>([])
  const activeAttachmentsRef = useRef<ChatAttachment[]>([])
  const pendingAttachmentReadsRef = useRef<Promise<void> | null>(null)
  const runningConversationIdRef = useRef('')

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) ?? conversations[0], [activeId, conversations])
  const visibleConversations = useMemo(() => conversations.filter((item) => item.messages.length > 0), [conversations])
  const activeWorkspacePath = activeConversation?.workspacePath || policy?.workspacePath || ''
  const activeAttachments = activeConversation?.activeAttachments ?? []
  const scrollKey = useMemo(() => activeConversation?.messages.map((message) => [message.id, message.status ?? '', message.content.length, message.attachments?.length ?? 0, message.steps?.length ?? 0].join(':')).join('|') ?? '', [activeConversation])

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
    return window.api.onAgentDelta(({ conversationId, messageId, delta }) => {
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation
        return {
          ...conversation,
          messages: updateAssistantMessage(conversation.messages, messageId, (message) => ({
            ...message,
            content: message.content + delta,
            status: 'acting'
          }))
        }
      }))
    })
  }, [])

  useEffect(() => {
    return window.api.onAgentDone(({ conversationId, messageId, status, content, completedAt }) => {
      setMcpApproval(undefined)
      setCommandApproval(undefined)
      setUserChoice(undefined)
      setSelectedChoiceId('')
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation
        return {
          ...conversation,
          messages: updateAssistantMessage(conversation.messages, messageId, (message) => ({ ...message, content, completedAt, status }))
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

  useEffect(() => {
    const list = messageListRef.current
    if (!list) return
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }, [activeConversation?.id, scrollKey, mcpApproval?.id, commandApproval?.id, userChoice?.id])

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
  }, [activeId])

  useEffect(() => {
    activeAttachmentsRef.current = activeAttachments
  }, [activeAttachments])

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
    const remainingCount = MAX_ATTACHMENT_COUNT - activeAttachmentsRef.current.length - attachmentsRef.current.length
    const selectedFiles = files.slice(0, Math.max(0, remainingCount))
    if (files.length > remainingCount) errors.push('附件最多只能添加 ' + MAX_ATTACHMENT_COUNT + ' 个')

    let totalSize = [...activeAttachmentsRef.current, ...attachmentsRef.current].reduce((sum, attachment) => sum + attachment.size, 0)
    const readableFiles = selectedFiles.filter((file) => {
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
      const mergedAttachments = [...attachmentsRef.current, ...nextAttachments].slice(0, MAX_ATTACHMENT_COUNT)
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
    const retainedAttachments = activeAttachmentsRef.current
    const effectiveAttachments = [...retainedAttachments, ...currentAttachments.filter((attachment) => !retainedAttachments.some((active) => active.id === attachment.id))]
    if (!prompt.trim() && !effectiveAttachments.length) return
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
        title: conversation.title === '新对话' ? submittedPrompt.slice(0, 28) || effectiveAttachments[0]?.name.slice(0, 28) || '新对话' : conversation.title,
        updatedAt: createdAt,
        activeAttachments: effectiveAttachments.length ? effectiveAttachments : undefined,
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

  async function saveSettings(): Promise<void> {
    await window.api.saveSettings(settings)
    if (policy) await window.api.savePolicy(policy)
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

  if (view === 'settings' && policy) return <>
    <SettingsPage settings={settings} setSettings={setSettings} policy={policy} setPolicy={setPolicy} tab={tab} setTab={setTab} onBack={() => setView('chat')} onSave={() => void saveSettings()} />
  </>

  return <div className="chat-app">
    <header className="window-bar"><Icon name="panel" className="bar-icon" /><button className="bar-icon-button"><Icon name="chevron-left" /></button><button className="bar-icon-button"><Icon name="chevron-right" /></button><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span><div className="bar-spacer" /><button className="top-settings" onClick={() => setView('settings')}><Icon name="settings" />设置</button></header>
    <aside className="sidebar">
      <nav className="quick-nav"><button className="quick-nav-active"><Icon name="message" /><span>快速对话</span></button><button><Icon name="search" /><span>搜索</span></button><button><Icon name="skills" /><span>技能</span></button><button><Icon name="clock" /><span>自动化</span></button></nav>
      <section className="project-list"><p>会话</p><button className="new-chat" onClick={() => void createConversation()}><Icon name="plus" />新对话</button><div className="task-list">{visibleConversations.map((conversation) => <div className={'conversation-row ' + (conversation.id === activeConversation?.id ? 'selected' : '')} key={conversation.id}><button onClick={() => setActiveId(conversation.id)}><span>{conversation.title}</span><small>{conversation.messages.length}</small></button><button className="delete-chat" onClick={() => void deleteConversation(conversation.id)} title="删除会话"><Icon name="trash" /></button></div>)}</div></section>
      <button className="sidebar-settings" onClick={() => setView('settings')}><Icon name="settings" /><span>设置</span></button>
    </aside>
    <main className="chat-main">
      <section className="message-list" ref={messageListRef}>{activeConversation?.messages.length ? activeConversation.messages.map((message) => <MessageView key={message.id} conversationId={activeConversation.id} message={message} onPreview={setPreviewAttachment} />) : <section className="welcome"><h1>今天想让 Agent 完成什么？</h1><p>同一会话里可以持续追问，Agent 会带着上下文继续执行。</p></section>}{mcpApproval ? <McpApprovalMessage request={mcpApproval} onRespond={respondToMcpApproval} /> : null}{commandApproval ? <CommandApprovalMessage request={commandApproval} onRespond={respondToCommandApproval} /> : null}{userChoice ? <UserChoiceMessage request={userChoice} selectedId={selectedChoiceId} onSelect={setSelectedChoiceId} onConfirm={confirmUserChoice} /> : null}</section>
      <form className="chat-composer" onSubmit={submit}>
        <input ref={fileInputRef} className="attachment-input" type="file" accept={ATTACHMENT_ACCEPT} multiple onChange={(event) => { queueFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} />
        {attachments.length ? <div className="composer-attachments">{attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} onRemove={() => removeAttachment(attachment.id)} onPreview={() => setPreviewAttachment(attachment)} />)}</div> : null}
        <textarea aria-label="向 Agent 描述任务" value={prompt} onChange={(event) => setPrompt(event.target.value)} onPaste={(event) => { const files = getClipboardFiles(event.clipboardData); if (files.length) { event.preventDefault(); queueFiles(files) } }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="输入任务，或直接粘贴截图；Enter 发送，Shift+Enter 换行" />
        {attachmentsLoading ? <p className="attachment-loading" role="status">正在读取附件...</p> : null}
        {attachmentError ? <p className="attachment-error" role="alert">{attachmentError}</p> : null}
        <div className="composer-controls"><div className="composer-left"><button type="button" className="icon-control" title="添加附件" aria-label="添加附件" onClick={() => fileInputRef.current?.click()}><Icon name="plus" /></button><button type="button" className="permission"><Icon name="shield" />完全访问<Icon name="chevron-down" /></button></div><button type={running ? 'button' : 'submit'} className={'send ' + (running ? 'pause' : '') + (pauseRequested ? ' pausing' : '')} disabled={running ? pauseRequested : attachmentsLoading || (!prompt.trim() && !attachments.length)} aria-label={running ? pauseRequested ? '正在暂停任务' : '暂停任务' : '发送任务'} title={running ? pauseRequested ? '正在暂停…' : '暂停任务' : '发送任务'} onClick={running ? pauseTask : undefined}><Icon name={running ? 'pause' : 'send'} /></button></div>
        <footer><div className="workspace-control"><button type="button" className={'workspace-trigger ' + (activeConversation?.workspacePath ? 'overridden' : '')} disabled={running} title={activeWorkspacePath} aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}><Icon name="folder" /><span>{workspaceLabel(activeWorkspacePath)}</span><Icon name="chevron-down" /></button>{workspaceMenuOpen ? <div className="workspace-menu"><p>当前会话工作区</p><code>{activeWorkspacePath}</code><button type="button" onClick={() => void selectWorkspace()}><Icon name="folder" />选择目录</button>{activeConversation?.workspacePath ? <button type="button" onClick={() => void resetWorkspace()}><Icon name="monitor" />恢复全局目录</button> : null}</div> : null}</div><span><Icon name="monitor" />本地模式<Icon name="chevron-down" /></span><span><Icon name="branch" />main<Icon name="chevron-down" /></span></footer>
      </form>
      {previewAttachment ? <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={previewAttachment.name} onClick={(event) => { if (event.target === event.currentTarget) setPreviewAttachment(undefined) }}><button type="button" className="attachment-lightbox-close" title="关闭预览" aria-label="关闭预览" onClick={() => setPreviewAttachment(undefined)}><Icon name="close" /></button><img className="attachment-lightbox-image" src={previewAttachment.dataUrl} alt={previewAttachment.name} /></div> : null}
    </main>
  </div>
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
  return <article className="message-item assistant mcp-approval-message" role="group" aria-labelledby="command-approval-title">
    <div className="message-meta"><span>Codext Agent</span><b className="run-status command-waiting">等待命令授权</b></div>
    <section className="mcp-approval-inline command-approval-inline">
      <div className="mcp-approval-heading"><span className="mcp-approval-icon command"><SquareTerminal /></span><div><h2 id="command-approval-title">命令可能修改状态</h2><p>{request.reason}</p></div></div>
      <dl className="mcp-approval-details"><div><dt>命令</dt><dd>{request.displayCommand}</dd></div>{request.workspacePath ? <div><dt>目录</dt><dd>{request.workspacePath}</dd></div> : null}</dl>
      <div className="mcp-approval-footer"><span>仅授权本次命令</span><div className="mcp-approval-actions"><button type="button" className="mcp-cancel" onClick={() => onRespond(false)}>拒绝</button><button type="button" className="mcp-allow" autoFocus onClick={() => onRespond(true)}>允许一次</button></div></div>
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

function MessageView({ conversationId, message, onPreview }: { conversationId: string; message: ChatMessage; onPreview: (attachment: ChatAttachment) => void }): ReactElement {
  const shouldShowProcess = message.role === 'assistant' && (message.status === 'acting' || Boolean(message.steps?.length))
  return <article className={'message-item ' + message.role}>
    <div className="message-meta"><span>{message.role === 'user' ? '你' : 'Codext Agent'}</span>{message.status && <b className={'run-status ' + message.status}>{statusText[message.status]}</b>}</div>
    {shouldShowProcess ? <AgentProcess key={message.status === 'acting' ? 'open' : 'closed'} message={message} /> : null}
    <div className="message-content-group">
      {message.content ? message.role === 'assistant'
        ? <div className="message-bubble message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
        : <div className="message-bubble">{message.content}</div> : null}
      {message.role === 'assistant' && message.artifacts?.length ? <ResultArtifacts conversationId={conversationId} artifacts={message.artifacts} /> : null}
      {message.attachments?.length ? <div className="message-attachments">{message.attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} onPreview={() => onPreview(attachment)} />)}</div> : null}
    </div>
  </article>
}

function ResultArtifacts({ conversationId, artifacts }: { conversationId: string; artifacts: AgentArtifact[] }): ReactElement {
  const files = artifacts.filter((artifact): artifact is Extract<AgentArtifact, { type: 'file' }> => artifact.type === 'file')
  const services = [...new Set(artifacts
    .filter((artifact): artifact is Extract<AgentArtifact, { type: 'service' }> => artifact.type === 'service')
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

function AttachmentCard({ attachment, onRemove, onPreview }: { attachment: ChatAttachment; onRemove?: () => void; onPreview?: () => void }): ReactElement {
  const isImage = isImageAttachmentType(attachment.mimeType)
  return <div className={'attachment-card ' + (isImage ? 'image' : 'file')} title={attachment.name}>
    {isImage ? <button type="button" className="attachment-image-button" aria-label={'查看原图 ' + attachment.name} onClick={onPreview}><img src={attachment.dataUrl} alt={attachment.name} /></button> : <div className="attachment-file-icon"><Icon name="file" /></div>}
    {!isImage ? <div className="attachment-file-meta"><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></div> : <span className="attachment-image-name">{attachment.name}</span>}
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

function workspaceLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).at(-1) || '工作区'
}

function AgentProcess({ message }: { message: ChatMessage }): ReactElement {
  const steps = message.steps ?? []
  const observations = steps.filter((item) => item.phase === 'act' && (item.title.startsWith('Observation #') || item.title.startsWith('工具结果')))
  const isRunning = message.status === 'acting'
  const actionCount = steps.filter((item) => item.phase === 'act' && item.title.startsWith('正在执行工具')).length
  const now = useNow(isRunning)
  const elapsed = formatElapsed(getElapsedMs(message, now))

  return <details className="agent-process agent-process-flow" open={isRunning}>
    <summary><span>{isRunning ? '正在处理 ' + elapsed : '已处理 ' + elapsed}</span><small>{steps.length || 1} 个步骤 · {observations.length} 次观察 · {actionCount} 条命令</small></summary>
    <div className="agent-flow">
      {steps.length ? steps.map((item, index) => <AgentStepView key={item.id} step={item} steps={steps} index={index} />) : <AgentStatusLine status="thinking" text={isRunning ? THINKING_PLACEHOLDER : '本次没有返回执行过程。'} />}
    </div>
  </details>
}

function AgentStepView({ step: taskStep, steps, index }: { step: TaskStep; steps: TaskStep[]; index: number }): ReactElement {
  if (taskStep.phase === 'reason' && taskStep.title === THINKING_TITLE) {
    if (taskStep.detail === THINKING_PLACEHOLDER) return <AgentStatusLine status="thinking" text={THINKING_PLACEHOLDER} />
    return <p className="agent-flow-text">{taskStep.detail}</p>
  }

  if (taskStep.phase === 'act' && taskStep.title.startsWith('正在执行工具')) {
    const hasObservation = steps.slice(index + 1).some((item) => item.phase === 'act' && (item.title.startsWith('Observation #') || item.title.startsWith('工具结果')))
    return <CollapsibleFlowBlock className={'agent-flow-action ' + (hasObservation ? 'done' : 'running')} initialOpen={!hasObservation}>
      <summary><AgentStatusLine status={hasObservation ? 'done' : 'running'} text={(hasObservation ? '已运行 Action：' : '正在运行 Action：') + getToolName(taskStep)} /></summary>
      <pre>{taskStep.detail || '无参数'}</pre>
    </CollapsibleFlowBlock>
  }

  if (taskStep.phase === 'act' && (taskStep.title.startsWith('Observation #') || taskStep.title.startsWith('工具结果'))) {
    return <CollapsibleFlowBlock className="agent-flow-observation">
      <summary><AgentStatusLine status="observe" text={taskStep.title} /></summary>
      <pre>{taskStep.detail}</pre>
    </CollapsibleFlowBlock>
  }

  return <AgentStatusLine status={taskStep.phase === 'validate' ? 'done' : 'info'} text={taskStep.title + (taskStep.detail ? ' ' + taskStep.detail : '')} />
}

function AgentStatusLine({ status, text }: { status: 'thinking' | 'running' | 'done' | 'observe' | 'info'; text: string }): ReactElement {
  return <div className={'agent-flow-status ' + status}><Icon name={status === 'thinking' ? 'clock' : status === 'observe' ? 'search-small' : 'monitor'} /><span>{text}</span></div>
}

function CollapsibleFlowBlock({ className, initialOpen = false, children }: { className: string; initialOpen?: boolean; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(initialOpen)
  return <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>{children}</details>
}

function getToolName(taskStep: TaskStep): string {
  return taskStep.title.replace(/^正在执行工具：/, '').trim()
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

function SettingsPage({ settings, setSettings, policy, setPolicy, tab, setTab, onBack, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; policy: AgentPolicy; setPolicy: (value: AgentPolicy) => void; tab: SettingTab; setTab: (value: SettingTab) => void; onBack: () => void; onSave: () => void }): ReactElement {
  const groups: Array<{ title: string; tabs: SettingTab[] }> = [{ title: '个人', tabs: ['常规', '外观', '配置', '个性化'] }, { title: '集成', tabs: ['打开方式'] }, { title: '编码', tabs: ['Git', '环境'] }]
  const isGeneral = tab === '常规'
  return <div className="settings-app"><header className="window-bar"><Icon name="panel" className="bar-icon" /><button className="bar-icon-button"><Icon name="chevron-left" /></button><button className="bar-icon-button"><Icon name="chevron-right" /></button><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span></header><aside className="settings-nav"><button className="back-to-app" onClick={onBack}><Icon name="chevron-left" />返回应用</button><div className="settings-search"><Icon name="search-small" /><input placeholder="搜索设置…" /></div>{groups.map((group) => <section key={group.title}><p>{group.title}</p>{group.tabs.map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}><Icon name={item === '常规' ? 'settings' : item === 'Git' ? 'branch' : item === '环境' ? 'monitor' : item === '外观' ? 'message' : item === '打开方式' ? 'folder' : 'shield'} />{item}</button>)}</section>)}</aside><main className="settings-content">{isGeneral ? <GeneralSettings settings={settings} setSettings={setSettings} onSave={onSave} /> : tab === '打开方式' ? <NavigationSettings settings={settings} setSettings={setSettings} onSave={onSave} /> : <ConfigSettings title={tab} settings={settings} setSettings={setSettings} policy={policy} setPolicy={setPolicy} onSave={onSave} />}</main></div>
}

function NavigationSettings({ settings, setSettings, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; onSave: () => void }): ReactElement {
  const [selecting, setSelecting] = useState<'file' | 'browser' | undefined>()
  const [saved, setSaved] = useState(false)
  async function selectApplication(kind: 'file' | 'browser'): Promise<void> {
    setSelecting(kind)
    setSaved(false)
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
    setSaved(false)
    setSettings({
      ...settings,
      navigation: {
        ...settings.navigation,
        [kind === 'file' ? 'fileApplicationPath' : 'browserApplicationPath']: ''
      }
    })
  }
  function save(): void {
    onSave()
    setSaved(true)
  }
  const rows = [
    { kind: 'file' as const, title: '代码和文本文件', description: '用于打开代码、Markdown、配置和其他文本文件。', path: settings.navigation.fileApplicationPath, icon: <FileCode2 /> },
    { kind: 'browser' as const, title: 'Web 浏览器', description: '用于打开任务产生的 HTTP 和 HTTPS 服务地址。', path: settings.navigation.browserApplicationPath, icon: <Globe2 /> }
  ]
  return <div className="settings-inner navigation-settings">
    <h1>打开方式</h1>
    <section className="settings-section">
      <h2>默认应用</h2>
      <p>未指定应用时，将使用 Windows 的系统默认设置。</p>
      <div className="application-list">{rows.map((row) => <div className="application-row" key={row.kind}>
        <span className="application-type-icon">{row.icon}</span>
        <div className="application-details"><strong>{row.title}</strong><p>{row.description}</p><code title={row.path || '使用系统默认'}>{row.path || '使用系统默认'}</code></div>
        <div className="application-actions">
          <button type="button" className="application-select" disabled={Boolean(selecting)} onClick={() => void selectApplication(row.kind)}><FolderOpen />{selecting === row.kind ? '选择中…' : '选择应用'}</button>
          <button type="button" className="application-reset" disabled={!row.path || Boolean(selecting)} aria-label={'恢复' + row.title + '的系统默认应用'} title="恢复系统默认" onClick={() => resetApplication(row.kind)}><RotateCcw /></button>
        </div>
      </div>)}</div>
    </section>
    <button className="settings-save" onClick={save}>保存更改</button>
    {saved && <div className="config-notice success"><Check />打开方式已保存到本地。</div>}
  </div>
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): ReactElement { return <button type="button" className={'toggle-switch ' + (checked ? 'on' : '')} onClick={() => onChange(!checked)}><i /></button> }
function GeneralSettings({ settings, setSettings, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; onSave: () => void }): ReactElement { return <div className="settings-inner"><h1>常规</h1><section className="settings-section"><h2>工作模式</h2><p>选择 Agent 展示和执行任务的方式。</p><div className="mode-cards"><button className="mode-card selected"><Icon name="monitor" /><span><strong>适用于编程</strong><small>更具技术性的回复和控制</small></span><b><Icon name="check" /></b></button><button className="mode-card"><Icon name="message" /><span><strong>适用于日常工作</strong><small>同样强大，技术细节更少</small></span><b /></button></div></section><section className="settings-section"><h2>权限</h2><div className="permission-list"><SettingRow title="默认权限" description="默认情况下，Agent 可以读取并编辑工作区中的文件；需要时可以请求额外访问权限。" checked={true} onChange={() => undefined} /><SettingRow title="自动审核" description="Agent 可以读取和编辑工作区中的文件，并会自动审核额外访问权限请求。" checked={settings.skillsEnabled} onChange={(skillsEnabled) => setSettings({ ...settings, skillsEnabled })} /><SettingRow title="完全访问权限" description="启用后无需每次确认，可使用本地工具来完成复杂任务。" checked={Boolean(settings.model.apiKey)} onChange={() => setSettings({ ...settings, model: { ...settings.model, apiKey: settings.model.apiKey ? '' : 'configured' } })} /></div></section><button className="settings-save" onClick={onSave}>保存更改</button></div> }
function SettingRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }): ReactElement { return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><Toggle checked={checked} onChange={onChange} /></div> }
function ConfigSettings({ title, settings, setSettings, policy, setPolicy, onSave }: { title: string; settings: AppSettings; setSettings: (value: AppSettings) => void; policy: AgentPolicy; setPolicy: (value: AgentPolicy) => void; onSave: () => void }): ReactElement {
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [apiKeyCopied, setApiKeyCopied] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | undefined>()
  useEffect(() => () => { if (copyResetTimer.current) clearTimeout(copyResetTimer.current) }, [])
  async function save(): Promise<void> { setSaving(true); setNotice(undefined); try { onSave(); await new Promise((resolve) => setTimeout(resolve, 420)); setNotice({ type: 'success', text: '配置已保存到本地。' }) } catch { setNotice({ type: 'error', text: '保存失败，请重试。' }) } finally { setSaving(false) } }
  async function test(): Promise<void> { setTesting(true); setNotice(undefined); try { const result = await window.api.testConnection(settings); setNotice({ type: result.ok ? 'success' : 'error', text: result.message }) } finally { setTesting(false) } }
  function copyApiKey(): void {
    if (!settings.model.apiKey) return
    window.api.copyText(settings.model.apiKey)
    setApiKeyCopied(true)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => setApiKeyCopied(false), 1600)
  }
  const toolLabels: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
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
      <h2>模型连接</h2>
      <p>这些配置保存在本地，用于 OpenAI 兼容接口调用。</p>
      <label>接口地址<input value={settings.model.baseUrl} onChange={(event) => setSettings({ ...settings, model: { ...settings.model, baseUrl: event.target.value } })} placeholder="https://api.openai.com/v1" /></label>
      <label>模型名称<input value={settings.model.model} onChange={(event) => setSettings({ ...settings, model: { ...settings.model, model: event.target.value } })} placeholder="gpt-4.1-mini" /></label>
      <div className="api-key-field">
        <label htmlFor="model-api-key">API Key <small className="optional-field">（可选）</small></label>
        <div className="api-key-input">
          <input id="model-api-key" type={apiKeyVisible ? 'text' : 'password'} value={settings.model.apiKey} onChange={(event) => { setApiKeyCopied(false); setSettings({ ...settings, model: { ...settings.model, apiKey: event.target.value } }) }} placeholder="无需鉴权的自定义接口可留空" autoComplete="off" spellCheck={false} />
          <div className="api-key-actions">
            <button type="button" className="api-key-action" disabled={!settings.model.apiKey} aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} aria-pressed={apiKeyVisible} title={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} onClick={() => setApiKeyVisible((visible) => !visible)}>{apiKeyVisible ? <EyeOff /> : <Eye />}</button>
            <button type="button" className={'api-key-action ' + (apiKeyCopied ? 'copied' : '')} disabled={!settings.model.apiKey} aria-label={apiKeyCopied ? 'API Key 已复制' : '复制 API Key'} title={apiKeyCopied ? '已复制' : '复制 API Key'} onClick={copyApiKey}>{apiKeyCopied ? <Check /> : <Copy />}</button>
          </div>
        </div>
      </div>
    </section>
    <section className="settings-section compact">
      <h2>系统提示词</h2>
      <p>每次请求模型时都会携带这段系统级约束。</p>
      <textarea className="system-prompt" value={policy.systemPrompt} onChange={(event) => setPolicy({ ...policy, systemPrompt: event.target.value })} />
    </section>
    <section className="settings-section compact">
      <h2>内置工具</h2>
      <p>工具仅能在工作区 <code>{policy.workspacePath}</code> 内访问；危险命令会被阻止。</p>
      <div className="tool-list">{Object.entries(toolLabels).map(([name, label]) => <label key={name} className="tool-toggle"><span><strong>{label}</strong><small>{name}</small></span><Toggle checked={policy.enabledTools.includes(name)} onChange={() => toggleTool(name)} /></label>)}</div>
    </section>
    <div className="config-actions"><button className="connection-test" onClick={() => void test()} disabled={testing || saving}>{testing ? '正在测试…' : '测试连接'}</button><button className={'settings-save ' + (saving ? 'is-loading' : '')} onClick={() => void save()} disabled={saving || testing}>{saving ? '保存中…' : '保存更改'}</button></div>
    {notice && <div className={'config-notice ' + notice.type}><Icon name={notice.type === 'success' ? 'check' : 'settings'} />{notice.text}</div>}
  </div>
}
