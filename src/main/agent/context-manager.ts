import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '../../shared/models'

export type ContextContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }
export type ContextContent = string | ContextContentPart[]
export type ContextMessage = { role: 'system' | 'user' | 'assistant'; content: ContextContent }

export interface ContextCompressionResult {
  messages: ContextMessage[]
  compressed: boolean
  level: 0 | 1 | 2 | 3 | 4
  beforeTokens: number
  afterTokens: number
  inputBudget: number
  triggerTokens: number
  targetTokens: number
}

const COMPRESSION_THRESHOLD = 0.8
const COMPRESSION_TARGET = 0.62
const RECENT_MESSAGES_TO_KEEP = 6
const INTERNAL_NOISE_PATTERN = /^(?:\[上一条|FORMAT_ERROR|REPEATED_ACTION|强制收尾请求|上一条(?:\s+Action|\s+run_command|响应|工具调用)|用户没有确认任何方案|用户已经拒绝|用户或安全策略已经拒绝|附件内容疑似加密|任务尚未完成。不要等待|已达到本次任务的最大工具轮数)/i
const REQUIREMENT_PATTERN = /必须|不要|不得|不能|只允许|需要|要求|保持|禁止|务必|must|do not|don't|never|required?/i
const ERROR_PATTERN = /错误|失败|异常|超时|未完成|无法|error|failed|exception|timeout/i
const PATH_PATTERN = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|html|css|ya?ml|toml|txt|csv|docx?|xlsx?|pptx?)\b/gi

export function prepareContext(messages: ContextMessage[], options: { contextWindowTokens?: number; maxOutputTokens?: number }): ContextCompressionResult {
  const contextWindow = normalizePositiveInteger(options.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS)
  const maxOutputTokens = Math.min(normalizePositiveInteger(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS), Math.floor(contextWindow * 0.5))
  const safetyMargin = Math.max(1024, Math.floor(contextWindow * 0.04))
  const inputBudget = Math.max(1024, contextWindow - maxOutputTokens - safetyMargin)
  const triggerTokens = Math.max(1, Math.floor(inputBudget * COMPRESSION_THRESHOLD))
  const targetTokens = Math.max(1, Math.floor(inputBudget * COMPRESSION_TARGET))
  const beforeTokens = estimateContextTokens(messages)
  if (beforeTokens < triggerTokens) return result(messages, false, 0, beforeTokens, beforeTokens, inputBudget, triggerTokens, targetTokens)

  let level: ContextCompressionResult['level'] = 1
  let working = removeNoiseAndDuplicates(messages)
  if (estimateContextTokens(working) > targetTokens) {
    level = 2
    working = summarizeHistoricalMessages(working, targetTokens)
  }
  if (estimateContextTokens(working) > targetTokens) {
    level = 3
    working = compactOlderToolResults(working)
  }
  if (estimateContextTokens(working) > targetTokens) {
    level = 4
    working = createEmergencyCheckpoint(working, targetTokens)
  }

  const afterTokens = estimateContextTokens(working)
  const compressed = afterTokens < beforeTokens
  return result(compressed ? working : messages, compressed, compressed ? level : 0, beforeTokens, compressed ? afterTokens : beforeTokens, inputBudget, triggerTokens, targetTokens)
}

export function estimateContextTokens(messages: ContextMessage[]): number {
  return messages.reduce((total, message) => total + estimateContentTokens(message.content) + 4, 2)
}

function estimateContentTokens(content: ContextContent): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  return content.reduce((total, part) => total + (part.type === 'text' ? estimateTextTokens(part.text) : 1024), 0)
}

function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjkCount = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  return Math.max(1, Math.ceil(cjkCount + (text.length - cjkCount) / 4))
}

function removeNoiseAndDuplicates(messages: ContextMessage[]): ContextMessage[] {
  const protectedStart = Math.max(1, messages.length - RECENT_MESSAGES_TO_KEEP)
  const seen = new Set<string>()
  const retained: ContextMessage[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const text = contentText(message.content).trim()
    if (index === 0 || index >= protectedStart) {
      retained.push(message)
      if (text) seen.add(message.role + '\n' + text)
      continue
    }
    if (!text || INTERNAL_NOISE_PATTERN.test(text)) continue
    const signature = message.role + '\n' + text
    if (seen.has(signature)) continue
    seen.add(signature)
    retained.push(message)
  }
  return retained.reverse()
}

function summarizeHistoricalMessages(messages: ContextMessage[], targetTokens: number): ContextMessage[] {
  if (messages.length <= RECENT_MESSAGES_TO_KEEP + 1) return messages
  const recentStart = Math.max(1, messages.length - RECENT_MESSAGES_TO_KEEP)
  const historical = messages.slice(1, recentStart)
  if (!historical.length) return messages

  const fixed = [messages[0], ...messages.slice(recentStart)]
  const fixedTokens = estimateContextTokens(fixed)
  const summaryBudget = Math.max(800, Math.min(8000, targetTokens - fixedTokens - 32))
  const summary = buildStructuredSummary(historical, summaryBudget)
  return [messages[0], { role: 'user', content: summary }, ...messages.slice(recentStart)]
}

function buildStructuredSummary(messages: ContextMessage[], tokenBudget: number): string {
  const requirements: string[] = []
  const outcomes: string[] = []
  const toolsAndFiles: string[] = []
  const errors: string[] = []

  for (const message of messages) {
    const text = cleanHistoricalText(contentText(message.content))
    if (!text) continue
    if (message.role === 'user' && !isToolMessage(text)) {
      const requirementLines = selectRelevantLines(text, REQUIREMENT_PATTERN, 4)
      requirements.push(...(requirementLines.length ? requirementLines : [compactText(text, 500)]))
    } else if (message.role === 'assistant' && !isToolMessage(text)) {
      outcomes.push(compactText(text, 500))
    }
    if (isToolMessage(text)) {
      const paths = [...new Set(text.match(PATH_PATTERN) ?? [])].slice(0, 8)
      const status = selectRelevantLines(text, ERROR_PATTERN, 4)
      toolsAndFiles.push(compactText([paths.length ? '路径：' + paths.join('、') : '', ...status].filter(Boolean).join('\n') || text, 700))
    }
    errors.push(...selectRelevantLines(text, ERROR_PATTERN, 2))
  }

  const sections = [
    ['用户目标与约束', uniqueRecent(requirements, 12)],
    ['已完成结果与关键决策', uniqueRecent(outcomes, 8)],
    ['工具、文件与验证', uniqueRecent(toolsAndFiles, 10)],
    ['待处理问题与错误', uniqueRecent(errors, 8)]
  ] as const
  const body = sections
    .filter(([, entries]) => entries.length)
    .map(([title, entries]) => '## ' + title + '\n' + entries.map((entry) => '- ' + entry).join('\n'))
    .join('\n\n')
  const summary = '[上下文检查点]\n已将较早的 ' + messages.length + ' 条消息压缩为结构化记忆。原始会话仍保存在本地。\n\n' + (body || '- 较早消息没有可保留的有效信息。')
  return fitTextToTokens(summary, tokenBudget)
}

function compactOlderToolResults(messages: ContextMessage[]): ContextMessage[] {
  const latestObservationIndex = messages.findLastIndex((message) => isObservation(contentText(message.content)))
  return messages.map((message, index) => {
    const text = contentText(message.content)
    if (index === latestObservationIndex || !isObservation(text) || estimateTextTokens(text) <= 2200) return message
    const errors = selectRelevantLines(text, ERROR_PATTERN, 8)
    const paths = [...new Set(text.match(PATH_PATTERN) ?? [])].slice(0, 12)
    const compacted = [
      text.slice(0, 4000),
      paths.length ? '\n涉及路径：' + paths.join('、') : '',
      errors.length ? '\n关键错误：\n' + errors.join('\n') : '',
      '\n[较早的完整工具输出未加入本次请求；文件内容可通过对应路径重新读取。]',
      text.slice(-1200)
    ].join('')
    return { ...message, content: compacted }
  })
}

function createEmergencyCheckpoint(messages: ContextMessage[], targetTokens: number): ContextMessage[] {
  const essentialIndexes = findEssentialMessageIndexes(messages)
  const historical = messages.filter((_message, index) => index > 0 && !essentialIndexes.has(index))
  const essential = messages.filter((_message, index) => index > 0 && essentialIndexes.has(index))
  const fixedTokens = estimateContextTokens([messages[0], ...essential])
  const summaryBudget = Math.max(400, targetTokens - fixedTokens - 24)
  const checkpoint = buildStructuredSummary(historical, summaryBudget)
  return [messages[0], { role: 'user', content: checkpoint.replace('[上下文检查点]', '[上下文紧急检查点]') }, ...essential]
}

function findEssentialMessageIndexes(messages: ContextMessage[]): Set<number> {
  const indexes = new Set<number>([0])
  const lastIndex = messages.length - 1
  if (lastIndex > 0) indexes.add(lastIndex)

  const latestObservationIndex = messages.findLastIndex((message) => isObservation(contentText(message.content)))
  if (latestObservationIndex > 0) {
    indexes.add(latestObservationIndex)
    if (latestObservationIndex > 1 && messages[latestObservationIndex - 1].role === 'assistant') indexes.add(latestObservationIndex - 1)
  }

  for (let index = lastIndex; index > 0; index--) {
    const message = messages[index]
    const text = contentText(message.content).trim()
    if (message.role !== 'user' || isObservation(text) || INTERNAL_NOISE_PATTERN.test(text)) continue
    indexes.add(index)
    break
  }
  return indexes
}

function contentText(content: ContextContent): string {
  if (typeof content === 'string') return content
  return content.map((part) => part.type === 'text' ? part.text : '[图片附件]').join('\n')
}

function cleanHistoricalText(text: string): string {
  return text
    .replace(/<\s*(?:think|thought)\s*>[\s\S]*?<\s*\/\s*(?:think|thought)\s*>/gi, '')
    .replace(/\[思考过程过长，已截断]/g, '')
    .trim()
}

function isToolMessage(text: string): boolean {
  return isObservation(text) || /"(?:action|tool_calls)"\s*:|正在执行工具|工具执行/i.test(text)
}

function isObservation(text: string): boolean {
  return /^Observation #|^UserChoice Observation:/i.test(text.trim())
}

function selectRelevantLines(text: string, pattern: RegExp, limit: number): string[] {
  return text
    .split(/\r?\n|(?<=[。！？.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line && pattern.test(line))
    .slice(0, limit)
    .map((line) => compactText(line, 320))
}

function compactText(text: string, maxCharacters: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxCharacters) return normalized
  const head = Math.floor(maxCharacters * 0.72)
  return normalized.slice(0, head) + ' … ' + normalized.slice(-(maxCharacters - head - 3))
}

function uniqueRecent(values: string[], limit: number): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (let index = values.length - 1; index >= 0 && result.length < limit; index--) {
    const value = values[index]
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result.reverse()
}

function fitTextToTokens(text: string, tokenBudget: number): string {
  if (estimateTextTokens(text) <= tokenBudget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTextTokens(text.slice(0, middle)) <= tokenBudget) low = middle
    else high = middle - 1
  }
  return text.slice(0, low).trimEnd() + '\n\n[检查点已按上下文预算缩短]'
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function result(messages: ContextMessage[], compressed: boolean, level: ContextCompressionResult['level'], beforeTokens: number, afterTokens: number, inputBudget: number, triggerTokens: number, targetTokens: number): ContextCompressionResult {
  return { messages, compressed, level, beforeTokens, afterTokens, inputBudget, triggerTokens, targetTokens }
}
