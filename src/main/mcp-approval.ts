import type { McpApprovalDetails, McpApprovalRequest } from '../shared/types'

export interface McpApprovalTarget {
  id: number
  isDestroyed(): boolean
  send(channel: string, request: McpApprovalRequest): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

interface PendingApproval {
  targetId: number
  settle(approved: boolean): void
}

export class McpApprovalManager {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(private readonly timeoutMs = 120_000) {}

  request(target: McpApprovalTarget, details: McpApprovalDetails): Promise<boolean> {
    if (target.isDestroyed()) return Promise.resolve(false)
    const id = crypto.randomUUID()
    const request: McpApprovalRequest = { ...details, id, expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() }

    return new Promise((resolve) => {
      let settled = false
      const onDestroyed = (): void => settle(false)
      const timer = setTimeout(() => settle(false), this.timeoutMs)
      const settle = (approved: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        target.removeListener('destroyed', onDestroyed)
        this.pending.delete(id)
        resolve(approved)
      }

      this.pending.set(id, { targetId: target.id, settle })
      target.once('destroyed', onDestroyed)
      try {
        target.send('mcp:approval-request', request)
      } catch {
        settle(false)
      }
    })
  }

  respond(targetId: number, requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.targetId !== targetId) return false
    pending.settle(approved)
    return true
  }

  cancelAll(): void {
    for (const pending of [...this.pending.values()]) pending.settle(false)
  }

  cancelTarget(targetId: number): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.targetId === targetId) pending.settle(false)
    }
  }
}
