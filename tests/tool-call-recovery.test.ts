import { describe, expect, it } from 'vitest'
import {
  applyPathCandidate,
  asStreamAssemblyIssue,
  normalizeRawToolCall,
  prepareToolCall
} from '../src/main/agent/tool-call-recovery'

describe('tool call recovery', () => {
  it('normalizes tool names, aliases and safely coercible argument types', () => {
    const normalized = normalizeRawToolCall({
      name: 'run-command',
      arguments: { cmd: 'npm', argv: '["run","build"]' }
    })

    expect(normalized.issue).toBeUndefined()
    expect(normalized.call).toEqual({ name: 'run_command', arguments: { command: 'npm', args: ['run', 'build'] } })
    expect(normalized.normalizedFields).toEqual(expect.arrayContaining(['cmd → command', 'argv → args']))
  })

  it('classifies malformed argument JSON without discarding the tool name', () => {
    const normalized = normalizeRawToolCall({ name: 'read_file', arguments: '{"path":' })

    expect(normalized.call).toBeUndefined()
    expect(normalized.issue).toMatchObject({
      type: 'ARGUMENTS_INVALID_JSON',
      toolName: 'read_file',
      invalid: ['arguments'],
      recoverable: true
    })
    expect(normalized.issue?.partialCall).toEqual({ name: 'read_file', arguments: {} })
  })

  it('applies only safe defaults for directory listing and command args', () => {
    const listing = prepareToolCall({ name: 'list_files', arguments: {} }, { currentRequest: '查看项目目录' })
    const command = prepareToolCall({ name: 'run_command', arguments: { command: 'git' } }, { currentRequest: '查看状态' })

    expect(listing.call).toEqual({ name: 'list_files', arguments: { path: '.', recursive: false } })
    expect(command.call).toEqual({ name: 'run_command', arguments: { command: 'git', args: [] } })
  })

  it('infers a read-only path only when the current task has one candidate', () => {
    const prepared = prepareToolCall(
      { name: 'read_file', arguments: {} },
      { currentRequest: '请读取 src/main/index.ts 并检查入口。', latestObservation: 'Observation #1:\n旧文件 old.ts' }
    )

    expect(prepared.issue).toBeUndefined()
    expect(prepared.call?.arguments.path).toBe('src/main/index.ts')
    expect(prepared.adjustments.join(' ')).toContain('当前任务唯一候选')
  })

  it('returns candidates instead of guessing when multiple paths are present', () => {
    const prepared = prepareToolCall(
      { name: 'read_file', arguments: {} },
      { currentRequest: '比较 package.json 和 tsconfig.json。' }
    )

    expect(prepared.call).toBeUndefined()
    expect(prepared.issue).toMatchObject({
      type: 'ARGUMENT_AMBIGUOUS',
      toolName: 'read_file',
      missing: ['path'],
      candidates: ['package.json', 'tsconfig.json']
    })
    expect(applyPathCandidate(prepared.issue!, 'tsconfig.json')).toEqual({ name: 'read_file', arguments: { path: 'tsconfig.json' } })
  })

  it('does not invent required write content', () => {
    const prepared = prepareToolCall(
      { name: 'write_file', arguments: { path: 'notes.txt' } },
      { currentRequest: '更新 notes.txt' }
    )

    expect(prepared.call).toBeUndefined()
    expect(prepared.issue).toMatchObject({ type: 'ARGUMENT_MISSING', missing: ['content'] })
  })

  it('distinguishes type errors and stream assembly errors', () => {
    const normalized = normalizeRawToolCall({ name: 'list_files', arguments: { recursive: 'sometimes' } })

    expect(normalized.issue).toMatchObject({ type: 'ARGUMENT_TYPE_ERROR', invalid: ['recursive'] })
    expect(asStreamAssemblyIssue(normalized.issue!)).toMatchObject({ type: 'STREAM_ASSEMBLY_ERROR', invalid: ['recursive'] })
  })
})
