import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { CommandApprovalManager } from '../src/main/command-approval'
import type { CommandApprovalRequest } from '../src/shared/types'

class ApprovalTarget extends EventEmitter {
  readonly sent: CommandApprovalRequest[] = []
  destroyed = false

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, request: CommandApprovalRequest): void {
    expect(channel).toBe('command:approval-request')
    this.sent.push(request)
  }
}

describe('CommandApprovalManager', () => {
  it('accepts a matching single-use response', async () => {
    const manager = new CommandApprovalManager(5_000)
    const target = new ApprovalTarget(12)
    const approval = manager.request(target, {
      command: 'npm',
      args: ['install'],
      displayCommand: 'npm install',
      reason: '可能安装依赖。',
      background: true,
      workspacePath: 'D:/work/codext'
    })
    const request = target.sent[0]

    expect(request).toMatchObject({ command: 'npm', args: ['install'], background: true })
    expect(manager.respond(99, request.id, true)).toBe(false)
    expect(manager.respond(target.id, request.id, true)).toBe(true)
    await expect(approval).resolves.toBe(true)
    expect(manager.respond(target.id, request.id, true)).toBe(false)
  })

  it('denies a pending request when its renderer is destroyed', async () => {
    const manager = new CommandApprovalManager(5_000)
    const target = new ApprovalTarget(21)
    const approval = manager.request(target, { command: 'git', args: ['commit'], displayCommand: 'git commit', reason: '可能修改仓库。' })

    target.destroyed = true
    target.emit('destroyed')

    await expect(approval).resolves.toBe(false)
  })
})
