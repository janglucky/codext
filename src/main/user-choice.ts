import type { UserChoiceDetails, UserChoiceRequest } from '../shared/types'

export interface UserChoiceTarget {
  id: number
  isDestroyed(): boolean
  send(channel: string, request: UserChoiceRequest): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

interface PendingChoice {
  targetId: number
  optionIds: Set<string>
  settle(optionId?: string): void
}

export class UserChoiceManager {
  private readonly pending = new Map<string, PendingChoice>()

  constructor(private readonly timeoutMs = 10 * 60_000) {}

  request(target: UserChoiceTarget, details: UserChoiceDetails): Promise<string | undefined> {
    if (target.isDestroyed()) return Promise.resolve(undefined)
    const id = crypto.randomUUID()
    const request: UserChoiceRequest = { ...details, id, expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() }
    const optionIds = new Set(details.options.map((option) => option.id))

    return new Promise((resolve) => {
      let settled = false
      const onDestroyed = (): void => settle()
      const timer = setTimeout(() => settle(), this.timeoutMs)
      const settle = (optionId?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        target.removeListener('destroyed', onDestroyed)
        this.pending.delete(id)
        resolve(optionId && optionIds.has(optionId) ? optionId : undefined)
      }
      this.pending.set(id, { targetId: target.id, optionIds, settle })
      target.once('destroyed', onDestroyed)
      try {
        target.send('choice:request', request)
      } catch {
        settle()
      }
    })
  }

  respond(targetId: number, requestId: string, optionId?: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.targetId !== targetId || (optionId && !pending.optionIds.has(optionId))) return false
    pending.settle(optionId)
    return true
  }

  cancelTarget(targetId: number): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.targetId === targetId) pending.settle()
    }
  }

  cancelAll(): void {
    for (const pending of [...this.pending.values()]) pending.settle()
  }
}
