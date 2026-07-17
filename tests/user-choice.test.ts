import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { UserChoiceManager } from '../src/main/user-choice'
import type { UserChoiceRequest } from '../src/shared/types'

class ChoiceTarget extends EventEmitter {
  readonly sent: UserChoiceRequest[] = []

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean { return false }
  send(channel: string, request: UserChoiceRequest): void {
    expect(channel).toBe('choice:request')
    this.sent.push(request)
  }
}

describe('UserChoiceManager', () => {
  it('accepts one valid option from the matching renderer', async () => {
    const manager = new UserChoiceManager(5_000)
    const target = new ChoiceTarget(41)
    const pending = manager.request(target, {
      title: '选择工作区',
      options: [
        { id: 'inside', label: '使用当前工作区' },
        { id: 'switch', label: '切换会话工作区' }
      ]
    })
    const request = target.sent[0]

    expect(manager.respond(99, request.id, 'inside')).toBe(false)
    expect(manager.respond(target.id, request.id, 'missing')).toBe(false)
    expect(manager.respond(target.id, request.id, 'switch')).toBe(true)
    await expect(pending).resolves.toBe('switch')
    expect(manager.respond(target.id, request.id, 'inside')).toBe(false)
  })

  it('cancels only choices owned by the requested renderer', async () => {
    const manager = new UserChoiceManager(5_000)
    const first = new ChoiceTarget(51)
    const second = new ChoiceTarget(52)
    const firstPending = manager.request(first, { title: 'first', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
    const secondPending = manager.request(second, { title: 'second', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })

    manager.cancelTarget(first.id)
    manager.respond(second.id, second.sent[0].id, 'b')

    await expect(firstPending).resolves.toBeUndefined()
    await expect(secondPending).resolves.toBe('b')
  })
})
