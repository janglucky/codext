import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReactAgent } from '../src/main/agent/react-agent'
import { commandUsesInternet, requiresCommandApproval, requiresExternalWriteApproval, requiresNetworkApproval } from '../src/main/permission-policy'
import { WorkspaceTools } from '../src/main/tools/workspace-tools'
import type { AgentPolicy, AppSettings, CommandApprovalDetails, PermissionMode } from '../src/shared/types'

const policy: AgentPolicy = {
  systemPrompt: 'test',
  workspacePath: '/workspace/project',
  enabledTools: ['write_file', 'run_command']
}

afterEach(() => vi.restoreAllMocks())

describe('permission policy', () => {
  it('maps the three permission modes to the expected approval boundaries', () => {
    expect(requiresCommandApproval('full_access', 'blocked', true)).toBe(false)
    expect(requiresCommandApproval('auto_approve', 'read', true)).toBe(false)
    expect(requiresCommandApproval('auto_approve', 'write', false)).toBe(true)
    expect(requiresCommandApproval('request_approval', 'read', true)).toBe(true)
    expect(requiresExternalWriteApproval('request_approval', true)).toBe(true)
    expect(requiresExternalWriteApproval('full_access', true)).toBe(false)
    expect(requiresNetworkApproval('auto_approve')).toBe(false)
    expect(requiresNetworkApproval('auto_approve', true)).toBe(true)
  })

  it('recognizes common command-line internet access', () => {
    expect(commandUsesInternet('curl', ['https://example.com'])).toBe(true)
    expect(commandUsesInternet('git', ['fetch', 'origin'])).toBe(true)
    expect(commandUsesInternet('npm', ['install'])).toBe(true)
    expect(commandUsesInternet('git', ['status', '--short'])).toBe(false)
  })
})

describe('ReactAgent permission integration', () => {
  it.each([
    ['auto_approve', 1],
    ['request_approval', 1],
    ['full_access', 0]
  ] as Array<[PermissionMode, number]>)('%s handles external file edits according to policy', async (permissionMode, expectedApprovals) => {
    mockModelResponses(
      { action: { name: 'write_file', arguments: { path: '/outside/report.txt', content: 'done' } } },
      { final: 'finished' }
    )
    const writeFile = vi.spyOn(WorkspaceTools.prototype, 'writeFile').mockResolvedValue('{"ok":true,"path":"/outside/report.txt","created":true}')
    const approvals: CommandApprovalDetails[] = []
    const agent = new ReactAgent(() => settings(permissionMode), () => policy)

    const task = await agent.run('写入外部报告', [], undefined, undefined, [], undefined, undefined, undefined, undefined, async (request) => {
      approvals.push(request)
      return true
    })

    expect(task.status).toBe('succeeded')
    expect(writeFile).toHaveBeenCalledWith('/outside/report.txt', 'done')
    expect(approvals).toHaveLength(expectedApprovals)
    if (expectedApprovals) expect(approvals[0]).toMatchObject({ approvalKind: 'external-file', path: '/outside/report.txt' })
  })

  it.each([
    ['auto_approve', 0],
    ['request_approval', 1],
    ['full_access', 0]
  ] as Array<[PermissionMode, number]>)('%s handles read-only internet commands according to policy', async (permissionMode, expectedApprovals) => {
    mockModelResponses(
      { action: { name: 'run_command', arguments: { command: 'curl', args: ['https://example.com'] } } },
      { final: 'finished' }
    )
    const runCommand = vi.spyOn(WorkspaceTools.prototype, 'runCommand').mockResolvedValue('ok')
    const approvals: CommandApprovalDetails[] = []
    const agent = new ReactAgent(() => settings(permissionMode), () => policy)

    const task = await agent.run('访问网页', [], undefined, undefined, [], undefined, undefined, undefined, undefined, async (request) => {
      approvals.push(request)
      return true
    })

    expect(task.status).toBe('succeeded')
    expect(runCommand).toHaveBeenCalled()
    expect(approvals).toHaveLength(expectedApprovals)
    if (expectedApprovals) expect(approvals[0].approvalKind).toBe('network')
  })
})

function settings(permissionMode: PermissionMode): AppSettings {
  return {
    model: { baseUrl: 'https://api.example.com/v1', apiKey: 'test', model: 'test-model', timeoutMs: 5000, maxRetries: 0 },
    skillsEnabled: true,
    permissionMode,
    navigation: { fileApplicationPath: '', browserApplicationPath: '' }
  }
}

function mockModelResponses(...responses: unknown[]): void {
  let index = 0
  globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve({
    ok: true,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(responses[index++] ?? responses.at(-1)) } }] })
  }))
}
