export interface HistoryAttachment {
  id: string
}

export interface HistoryStep {
  phase: 'reason' | 'skill' | 'act' | 'validate'
  title: string
  detail: string
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  attachments?: HistoryAttachment[]
  status?: string
  steps?: HistoryStep[]
}

export interface HistorySelectionOptions {
  hasCurrentAttachments?: boolean
  maxMessages?: number
}

type Segment<T> = { messages: T[]; userText: string; searchText: string }

const DEFAULT_MAX_MESSAGES = 12
const CONTINUATION_PATTERN = /^\s*(?:继续|接着|接着做|继续执行|继续处理|重试|再试一次|然后呢|下一步|刚才那个|上一个|这个问题|该问题|按刚才的|continue|go on|retry)\s*[。.!！]?\s*$/i
const REFERENTIAL_PATTERN = /(?:刚才|之前|上面|上述|前面|上一(?:张|个|份)|这(?:张|个|份)|该)(?:的)?(?:截图|图片|图|附件|文件|文档|表格|PPT)|(?:继续|重新|再)(?:看|读取|分析|处理)(?:刚才|之前|上面|上述)?(?:的)?(?:截图|图片|附件|文件|文档|表格|PPT)/i
const CONTEXT_DEPENDENT_PATTERN = /(?:这些|那些|上述|上面|前面|前述|刚才|之前|此前|上次|上一(?:次|轮|条|段)|这(?:个|些|几|种|段|部分|条)|那(?:个|些|几|种|段|部分|条)|该(?:方法|问题|文件|代码|位置|报错|错误|方案|结果|内容|步骤|操作)?|它们?|前者|后者|其中(?:的)?)/i
const ATTACHMENT_NOUN_PATTERN = /(?:截图|图片|图像|附件|文档|表格|PPT|幻灯片|CSV|Excel|Word)/i
const FILE_PATTERN = /(?:[A-Za-z0-9_.@+-]+[\\/])+[A-Za-z0-9_.@+ -]+|\b[A-Za-z0-9_.@+-]+\.(?:ts|tsx|js|jsx|json|md|txt|csv|log|py|html|css|ya?ml|toml|docx?|xlsx?|pptx?|pdf)\b/gi
const ASCII_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'please', 'agent', 'continue', 'retry'])
const GENERIC_CJK_TERMS = new Set(['帮我', '一下', '这个', '现在', '还是', '无法', '问题', '错误', '失败', '继续', '进行', '处理', '修复', '看看', '看下'])

export function selectTaskHistory<T extends HistoryMessage>(history: T[], currentRequest: string, options: HistorySelectionOptions = {}): T[] {
  if (!history.length) return []
  const segments = buildSegments(history)
  const selected = selectSegment(segments, currentRequest)
  if (!selected) return []

  const maxMessages = Math.max(2, options.maxMessages ?? DEFAULT_MAX_MESSAGES)
  const trimmed = selected.messages.length <= maxMessages
    ? selected.messages
    : [selected.messages[0], ...selected.messages.slice(-(maxMessages - 1))]
  const reuseAttachments = !options.hasCurrentAttachments && shouldReuseHistoricalAttachments(currentRequest)
  const attachmentMessageIndex = reuseAttachments
    ? trimmed.findLastIndex((message) => message.role === 'user' && Boolean(message.attachments?.length))
    : -1
  const resumableAssistantIndex = trimmed.findLastIndex((message) =>
    message.role === 'assistant' && Boolean(message.status && /^(?:pending|reasoning|acting|validating|paused|failed)$/.test(message.status))
  )
  const latestAssistantWithTraceIndex = trimmed.findLastIndex((message) =>
    message.role === 'assistant' && message.steps?.some(isObservationStep)
  )

  return trimmed.map((message, index) => ({
    ...message,
    content: formatHistoryContent(message, index === resumableAssistantIndex || index === latestAssistantWithTraceIndex),
    attachments: index === attachmentMessageIndex ? message.attachments : undefined,
    steps: undefined
  }))
}

export function shouldReuseHistoricalAttachments(prompt: string): boolean {
  const normalized = prompt.trim()
  return CONTINUATION_PATTERN.test(normalized) || REFERENTIAL_PATTERN.test(normalized) ||
    (normalized.length <= 40 && ATTACHMENT_NOUN_PATTERN.test(normalized))
}

function buildSegments<T extends HistoryMessage>(history: T[]): Array<Segment<T>> {
  const segments: Array<Segment<T>> = []
  let current: Segment<T> | undefined
  for (const message of history) {
    if (message.role === 'user') {
      if (!current || !isContinuationMessage(message)) {
        const next: Segment<T> = { messages: [], userText: '', searchText: '' }
        current = next
        segments.push(next)
      }
      current.messages.push(message)
      if (message.content.trim()) {
        current.userText += (current.userText ? '\n' : '') + message.content.trim()
        current.searchText += (current.searchText ? '\n' : '') + message.content.trim()
      }
      continue
    }
    if (!current) {
      current = { messages: [], userText: '', searchText: '' }
      segments.push(current)
    }
    current.messages.push(message)
    const assistantSearchText = buildAssistantSearchText(message)
    if (assistantSearchText) current.searchText += (current.searchText ? '\n' : '') + assistantSearchText
  }
  return segments.filter((segment) => segment.messages.length)
}

function selectSegment<T extends HistoryMessage>(segments: Array<Segment<T>>, currentRequest: string): Segment<T> | undefined {
  if (!segments.length) return undefined
  if (isContinuationText(currentRequest)) return segments.at(-1)
  for (let index = segments.length - 1; index >= 0; index--) {
    if (relevanceScore(currentRequest, segments[index].searchText) >= 2) return segments[index]
  }
  if (shouldReuseHistoricalAttachments(currentRequest)) {
    return [...segments].reverse().find((segment) => segment.messages.some((message) => Boolean(message.attachments?.length)))
  }
  return undefined
}

function isContinuationMessage(message: HistoryMessage): boolean {
  if (message.attachments?.length) return false
  return isContinuationText(message.content)
}

function isContinuationText(text: string): boolean {
  const normalized = text.trim()
  return CONTINUATION_PATTERN.test(normalized) || CONTEXT_DEPENDENT_PATTERN.test(normalized) ||
    (normalized.length <= 28 && /^(?:还是|刚才|上次|前面|上述|这个|该|它|再)/.test(normalized))
}

function relevanceScore(left: string, right: string): number {
  if (!left.trim() || !right.trim()) return 0
  const leftFiles = new Set(extractFiles(left))
  const rightFiles = new Set(extractFiles(right))
  let score = intersectionSize(leftFiles, rightFiles) * 8

  const leftAscii = extractAsciiTerms(left)
  const rightAscii = extractAsciiTerms(right)
  score += intersectionSize(leftAscii, rightAscii) * 2

  const leftCjk = extractCjkTerms(left)
  const rightCjk = extractCjkTerms(right)
  score += intersectionSize(leftCjk, rightCjk) * 2
  return score
}

function extractFiles(text: string): string[] {
  return (text.match(FILE_PATTERN) ?? []).map((value) => value.replaceAll('\\', '/').toLowerCase())
}

function extractAsciiTerms(text: string): Set<string> {
  const terms = text.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) ?? []
  return new Set(terms.filter((term) => !ASCII_STOP_WORDS.has(term) && !/^https?$/.test(term)))
}

function extractCjkTerms(text: string): Set<string> {
  const result = new Set<string>()
  for (const run of text.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index++) {
      const term = run.slice(index, index + 2)
      if (!GENERIC_CJK_TERMS.has(term)) result.add(term)
    }
  }
  return result
}

function intersectionSize<T>(left: Set<T>, right: Set<T>): number {
  let count = 0
  for (const value of left) if (right.has(value)) count++
  return count
}

function formatHistoryContent(message: HistoryMessage, includeTrace: boolean): string {
  const assistantContent = message.role === 'assistant' ? sanitizeAssistantHistoryContent(message.content) : message.content
  if (message.role !== 'assistant' || !includeTrace || !message.steps?.length) return assistantContent
  const observations = selectMemoryObservations(message.steps)
    .map((item) => item.title + ': ' + compactTrace(item.detail))
  return [assistantContent, observations.length ? 'Previous task memory:\n' + observations.join('\n') : ''].filter(Boolean).join('\n\n')
}

function sanitizeAssistantHistoryContent(content: string): string {
  const normalized = content.trim()
  if (!normalized) return ''
  const isProtocolEcho = /(?:Observation\s*#\s*\d+|Previous\s+task\s+memory|REACT_(?:PROTOCOL|FORMAT))/i.test(normalized)
  return isProtocolEcho ? '' : content
}

function buildAssistantSearchText(message: HistoryMessage): string {
  const observationTerms = message.steps
    ?.filter(isObservationStep)
    .flatMap((item) => [item.title, ...extractFiles(item.detail)])
    .join('\n') ?? ''
  return [message.content.trim(), observationTerms].filter(Boolean).join('\n')
}

function selectMemoryObservations(steps: HistoryStep[]): HistoryStep[] {
  const observations = steps.filter(isObservationStep)
  if (observations.length <= 4) return observations
  const selectedIndexes = new Set(observations.slice(-3).map((item) => observations.indexOf(item)))
  for (const pattern of [
    /：(?:read_file|list_files|parse_word|parse_excel|parse_powerpoint)$/,
    /：(?:write_file|edit_file|decrypt_file)$/,
    /：start_service$/
  ]) {
    const index = observations.findLastIndex((item) => pattern.test(item.title))
    if (index >= 0) selectedIndexes.add(index)
  }
  return [...selectedIndexes].sort((left, right) => left - right).map((index) => observations[index])
}

function isObservationStep(step: HistoryStep): boolean {
  return step.phase === 'act' && step.title.startsWith('Observation #')
}

function compactTrace(value: string): string {
  if (value.length <= 1200) return value
  return value.slice(0, 850) + '\n[较早内容已省略]\n' + value.slice(-300)
}
