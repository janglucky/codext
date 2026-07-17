import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { McpApprovalManager } from '../src/main/mcp-approval'
import type { McpApprovalRequest } from '../src/shared/types'

class ApprovalTarget extends EventEmitter {
  readonly sent: McpApprovalRequest[] = []
  destroyed = false

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, request: McpApprovalRequest): void {
    expect(channel).toBe('mcp:approval-request')
    this.sent.push(request)
  }
}

describe('McpApprovalManager', () => {
  it('accepts only a matching renderer single-use response', async () => {
    const manager = new McpApprovalManager(5_000)
    const target = new ApprovalTarget(12)
    const approval = manager.request(target, { toolName: 'parse_powerpoint', serverUrl: 'http://127.0.0.1:3777/mcp', path: 'slides.pptx' })
    const request = target.sent[0]

    expect(request).toMatchObject({ toolName: 'parse_powerpoint', path: 'slides.pptx' })
    expect(manager.respond(99, request.id, true)).toBe(false)
    expect(manager.respond(target.id, request.id, true)).toBe(true)
    await expect(approval).resolves.toBe(true)
    expect(manager.respond(target.id, request.id, true)).toBe(false)
  })

  it('denies pending requests when the renderer is destroyed', async () => {
    const manager = new McpApprovalManager(5_000)
    const target = new ApprovalTarget(21)
    const approval = manager.request(target, { toolName: 'parse_powerpoint', serverUrl: 'http://127.0.0.1:3777/mcp' })

    target.destroyed = true
    target.emit('destroyed')

    await expect(approval).resolves.toBe(false)
  })

  it('cancels pending approvals for one renderer only', async () => {
    const manager = new McpApprovalManager(5_000)
    const first = new ApprovalTarget(31)
    const second = new ApprovalTarget(32)
    const firstApproval = manager.request(first, { toolName: 'parse_powerpoint', serverUrl: 'http://127.0.0.1:3777/mcp' })
    const secondApproval = manager.request(second, { toolName: 'parse_powerpoint', serverUrl: 'http://127.0.0.1:3777/mcp' })

    manager.cancelTarget(first.id)
    manager.respond(second.id, second.sent[0].id, true)

    await expect(firstApproval).resolves.toBe(false)
    await expect(secondApproval).resolves.toBe(true)
  })
})
