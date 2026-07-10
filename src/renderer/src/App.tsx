import { FormEvent, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type SVGProps } from 'react'
import type { AgentPolicy, AppSettings, ChatMessage, Conversation, TaskStatus, TaskStep } from '../../shared/types'

type IconName = 'panel' | 'chevron-left' | 'chevron-right' | 'message' | 'search' | 'skills' | 'clock' | 'folder' | 'settings' | 'plus' | 'shield' | 'chevron-down' | 'send' | 'monitor' | 'branch' | 'search-small' | 'check' | 'trash'
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
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  branch: <><path d="M6 3v12" /><circle cx="6" cy="3" r="2" /><circle cx="6" cy="15" r="2" /><circle cx="18" cy="7" r="2" /><path d="M8 15c6 0 2-8 8-8" /></>,
  'search-small': <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 14h10l1-14" /><path d="M9 7V4h6v3" /></>
}

const initialSettings: AppSettings = { model: { baseUrl: '', apiKey: '', model: '', timeoutMs: 300000, maxRetries: 3 }, mcpUrl: '', skillsEnabled: true }
const statusText: Record<TaskStatus, string> = { pending: '等待中', reasoning: '分析中', acting: '执行中', validating: '校验中', succeeded: '已完成', failed: '失败' }
const THINKING_TITLE = '思考过程'
const THINKING_PLACEHOLDER = '思考中…'
const LOCAL_ASSISTANT_PREFIX = 'local-agent-'
const LOCAL_STEP_PREFIX = 'local-step-'
type View = 'chat' | 'settings'
type SettingTab = '常规' | '外观' | '配置' | '个性化' | 'MCP 服务器' | '浏览器' | 'Git' | '环境'

function Icon({ name, ...props }: IconProps): ReactElement {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
}

export function App(): ReactElement {
  const [prompt, setPrompt] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState('')
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [policy, setPolicy] = useState<AgentPolicy | undefined>()
  const [running, setRunning] = useState(false)
  const [view, setView] = useState<View>('chat')
  const [tab, setTab] = useState<SettingTab>('常规')
  const messageListRef = useRef<HTMLElement | null>(null)

  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) ?? conversations[0], [activeId, conversations])
  const visibleConversations = useMemo(() => conversations.filter((item) => item.messages.length > 0), [conversations])
  const scrollKey = useMemo(() => activeConversation?.messages.map((message) => [message.id, message.status ?? '', message.content.length, message.steps?.length ?? 0].join(':')).join('|') ?? '', [activeConversation])

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
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation
        return {
          ...conversation,
          messages: updateAssistantMessage(conversation.messages, messageId, (message) => ({ ...message, content, completedAt, status }))
        }
      }))
    })
  }, [])

  useEffect(() => {
    const list = messageListRef.current
    if (!list) return
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }, [activeConversation?.id, scrollKey])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!prompt.trim() || running || !activeConversation) return
    const submittedPrompt = prompt.trim()
    const conversationId = activeConversation.id
    const createdAt = new Date().toISOString()
    const optimisticMessage: ChatMessage = { id: 'local-' + crypto.randomUUID(), role: 'user', content: submittedPrompt, createdAt }
    const pendingAssistant: ChatMessage = {
      id: LOCAL_ASSISTANT_PREFIX + crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt,
      status: 'acting',
      steps: [createThinkingStep()]
    }
    setPrompt('')
    setActiveId(conversationId)
    setConversations((current) => current.map((conversation) => {
      if (conversation.id !== conversationId) return conversation
      return {
        ...conversation,
        title: conversation.title === '新对话' ? submittedPrompt.slice(0, 28) || '新对话' : conversation.title,
        updatedAt: createdAt,
        messages: [...conversation.messages, optimisticMessage, pendingAssistant]
      }
    }))
    setRunning(true)
    try {
      const result = await window.api.runTask(conversationId, submittedPrompt)
      setConversations((current) => [result.conversation, ...current.filter((item) => item.id !== result.conversation.id)])
      setActiveId(result.conversation.id)
    } finally {
      setRunning(false)
    }
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

  async function saveSettings(): Promise<void> {
    await window.api.saveSettings(settings)
    if (policy) await window.api.savePolicy(policy)
  }

  if (view === 'settings' && policy) return <SettingsPage settings={settings} setSettings={setSettings} policy={policy} setPolicy={setPolicy} tab={tab} setTab={setTab} onBack={() => setView('chat')} onSave={() => void saveSettings()} />

  return <div className="chat-app">
    <header className="window-bar"><Icon name="panel" className="bar-icon" /><button className="bar-icon-button"><Icon name="chevron-left" /></button><button className="bar-icon-button"><Icon name="chevron-right" /></button><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span><div className="bar-spacer" /><button className="top-settings" onClick={() => setView('settings')}><Icon name="settings" />设置</button></header>
    <aside className="sidebar">
      <nav className="quick-nav"><button className="quick-nav-active"><Icon name="message" /><span>快速对话</span></button><button><Icon name="search" /><span>搜索</span></button><button><Icon name="skills" /><span>技能</span></button><button><Icon name="clock" /><span>自动化</span></button></nav>
      <section className="project-list"><p>会话</p><button className="new-chat" onClick={() => void createConversation()}><Icon name="plus" />新对话</button><div className="task-list">{visibleConversations.map((conversation) => <div className={'conversation-row ' + (conversation.id === activeConversation?.id ? 'selected' : '')} key={conversation.id}><button onClick={() => setActiveId(conversation.id)}><span>{conversation.title}</span><small>{conversation.messages.length}</small></button><button className="delete-chat" onClick={() => void deleteConversation(conversation.id)} title="删除会话"><Icon name="trash" /></button></div>)}</div></section>
      <button className="sidebar-settings" onClick={() => setView('settings')}><Icon name="settings" /><span>设置</span></button>
    </aside>
    <main className="chat-main">
      <section className="message-list" ref={messageListRef}>{activeConversation?.messages.length ? activeConversation.messages.map((message) => <MessageView key={message.id} message={message} />) : <section className="welcome"><h1>今天想让 Agent 完成什么？</h1><p>同一会话里可以持续追问，Agent 会带着上下文继续执行。</p></section>}</section>
      <form className="chat-composer" onSubmit={submit}><textarea aria-label="向 Agent 描述任务" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="输入任务，Enter 发送，Shift+Enter 换行" /><div className="composer-controls"><div className="composer-left"><button type="button" className="icon-control" title="添加上下文"><Icon name="plus" /></button><button type="button" className="permission"><Icon name="shield" />完全访问<Icon name="chevron-down" /></button></div><button className="send" disabled={running} aria-label="发送任务"><Icon name={running ? 'clock' : 'send'} /></button></div><footer><span><Icon name="folder" />codext-agent<Icon name="chevron-down" /></span><span><Icon name="monitor" />本地模式<Icon name="chevron-down" /></span><span><Icon name="branch" />main<Icon name="chevron-down" /></span></footer></form>
    </main>
  </div>
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

function MessageView({ message }: { message: ChatMessage }): ReactElement {
  const shouldShowProcess = message.role === 'assistant' && (message.status === 'acting' || Boolean(message.steps?.length))
  return <article className={'message-item ' + message.role}>
    <div className="message-meta"><span>{message.role === 'user' ? '你' : 'Codext Agent'}</span>{message.status && <b className={'run-status ' + message.status}>{statusText[message.status]}</b>}</div>
    {shouldShowProcess ? <AgentProcess key={message.status === 'acting' ? 'open' : 'closed'} message={message} /> : null}
    {message.content ? <div className="message-bubble">{message.content}</div> : null}
  </article>
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
  const groups: Array<{ title: string; tabs: SettingTab[] }> = [{ title: '个人', tabs: ['常规', '外观', '配置', '个性化'] }, { title: '集成', tabs: ['MCP 服务器', '浏览器'] }, { title: '编码', tabs: ['Git', '环境'] }]
  const isGeneral = tab === '常规'
  return <div className="settings-app"><header className="window-bar"><Icon name="panel" className="bar-icon" /><button className="bar-icon-button"><Icon name="chevron-left" /></button><button className="bar-icon-button"><Icon name="chevron-right" /></button><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span></header><aside className="settings-nav"><button className="back-to-app" onClick={onBack}><Icon name="chevron-left" />返回应用</button><div className="settings-search"><Icon name="search-small" /><input placeholder="搜索设置…" /></div>{groups.map((group) => <section key={group.title}><p>{group.title}</p>{group.tabs.map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}><Icon name={item === '常规' ? 'settings' : item === 'MCP 服务器' ? 'skills' : item === 'Git' ? 'branch' : item === '环境' ? 'monitor' : item === '外观' ? 'message' : 'shield'} />{item}</button>)}</section>)}</aside><main className="settings-content">{isGeneral ? <GeneralSettings settings={settings} setSettings={setSettings} onSave={onSave} /> : <ConfigSettings title={tab} settings={settings} setSettings={setSettings} policy={policy} setPolicy={setPolicy} onSave={onSave} />}</main></div>
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }): ReactElement { return <button type="button" className={'toggle-switch ' + (checked ? 'on' : '')} onClick={() => onChange(!checked)}><i /></button> }
function GeneralSettings({ settings, setSettings, onSave }: { settings: AppSettings; setSettings: (value: AppSettings) => void; onSave: () => void }): ReactElement { return <div className="settings-inner"><h1>常规</h1><section className="settings-section"><h2>工作模式</h2><p>选择 Agent 展示和执行任务的方式。</p><div className="mode-cards"><button className="mode-card selected"><Icon name="monitor" /><span><strong>适用于编程</strong><small>更具技术性的回复和控制</small></span><b><Icon name="check" /></b></button><button className="mode-card"><Icon name="message" /><span><strong>适用于日常工作</strong><small>同样强大，技术细节更少</small></span><b /></button></div></section><section className="settings-section"><h2>权限</h2><div className="permission-list"><SettingRow title="默认权限" description="默认情况下，Agent 可以读取并编辑工作区中的文件；需要时可以请求额外访问权限。" checked={true} onChange={() => undefined} /><SettingRow title="自动审核" description="Agent 可以读取和编辑工作区中的文件，并会自动审核额外访问权限请求。" checked={settings.skillsEnabled} onChange={(skillsEnabled) => setSettings({ ...settings, skillsEnabled })} /><SettingRow title="完全访问权限" description="启用后无需每次确认，可使用本地工具来完成复杂任务。" checked={Boolean(settings.model.apiKey)} onChange={() => setSettings({ ...settings, model: { ...settings.model, apiKey: settings.model.apiKey ? '' : 'configured' } })} /></div></section><button className="settings-save" onClick={onSave}>保存更改</button></div> }
function SettingRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }): ReactElement { return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><Toggle checked={checked} onChange={onChange} /></div> }
function ConfigSettings({ title, settings, setSettings, policy, setPolicy, onSave }: { title: string; settings: AppSettings; setSettings: (value: AppSettings) => void; policy: AgentPolicy; setPolicy: (value: AgentPolicy) => void; onSave: () => void }): ReactElement {
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | undefined>()
  async function save(): Promise<void> { setSaving(true); setNotice(undefined); try { onSave(); await new Promise((resolve) => setTimeout(resolve, 420)); setNotice({ type: 'success', text: '配置已保存到本地。' }) } catch { setNotice({ type: 'error', text: '保存失败，请重试。' }) } finally { setSaving(false) } }
  async function test(): Promise<void> { setTesting(true); setNotice(undefined); try { const result = await window.api.testConnection(settings); setNotice({ type: result.ok ? 'success' : 'error', text: result.message }) } finally { setTesting(false) } }
  const toolLabels: Record<string, string> = { read_file: '读取文件', write_file: '写入文件', run_command: '执行命令行' }
  function toggleTool(name: string): void { setPolicy({ ...policy, enabledTools: policy.enabledTools.includes(name) ? policy.enabledTools.filter((item) => item !== name) : [...policy.enabledTools, name] }) }

  return <div className="settings-inner">
    <h1>{title}</h1>
    <section className="settings-section compact">
      <h2>模型连接</h2>
      <p>这些配置保存在本地，用于 OpenAI 兼容接口调用。</p>
      <label>接口地址<input value={settings.model.baseUrl} onChange={(event) => setSettings({ ...settings, model: { ...settings.model, baseUrl: event.target.value } })} placeholder="https://api.openai.com/v1" /></label>
      <label>模型名称<input value={settings.model.model} onChange={(event) => setSettings({ ...settings, model: { ...settings.model, model: event.target.value } })} placeholder="gpt-4.1-mini" /></label>
      <label>API Key <small className="optional-field">（可选）</small><input type="password" value={settings.model.apiKey} onChange={(event) => setSettings({ ...settings, model: { ...settings.model, apiKey: event.target.value } })} placeholder="无需鉴权的自定义接口可留空" /></label>
      <label>MCP 地址<input value={settings.mcpUrl} onChange={(event) => setSettings({ ...settings, mcpUrl: event.target.value })} placeholder="可选" /></label>
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
