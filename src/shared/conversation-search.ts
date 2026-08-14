import type { ChatMessage, Conversation } from './types'

export interface ConversationSearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  role: ChatMessage['role']
  createdAt: string
  snippet: string
  score: number
}

export function searchConversationHistory(conversations: Conversation[], rawQuery: string, limit = 200): ConversationSearchResult[] {
  const query = normalizeSearchText(rawQuery)
  if (!query) return []
  const terms = [...new Set(query.split(/\s+/).filter(Boolean))]
  const results: ConversationSearchResult[] = []

  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      const attachmentNames = message.attachments?.map((attachment) => attachment.name).join(' ') ?? ''
      const source = [message.content, attachmentNames].filter(Boolean).join(' ')
      const searchable = normalizeSearchText(source)
      if (!searchable || !terms.every((term) => searchable.includes(term))) continue
      const exactPhrase = searchable.includes(query)
      const earliestMatch = Math.min(...terms.map((term) => searchable.indexOf(term)).filter((index) => index >= 0))
      const recency = Number.isFinite(Date.parse(message.createdAt)) ? Date.parse(message.createdAt) / 1e13 : 0
      results.push({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        snippet: createSearchSnippet(source, terms, earliestMatch),
        score: (exactPhrase ? 100 : 0) + terms.length * 10 + (message.role === 'user' ? 2 : 0) + recency
      })
    }
  }

  return results
    .sort((left, right) => right.score - left.score || Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, Math.max(1, limit))
}

function createSearchSnippet(source: string, terms: string[], normalizedMatchIndex: number): string {
  const text = source.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const lower = text.toLocaleLowerCase()
  const actualIndexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)
  const matchIndex = actualIndexes.length ? Math.min(...actualIndexes) : Math.max(0, normalizedMatchIndex)
  const start = Math.max(0, matchIndex - 58)
  const end = Math.min(text.length, Math.max(matchIndex + 150, start + 190))
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}
