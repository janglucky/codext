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

  it('converts executable-style tool names into run_command calls', () => {
    expect(normalizeRawToolCall({ name: 'npx', arguments: { args: ['vite', '--version'] } })).toMatchObject({
      call: { name: 'run_command', arguments: { command: 'npx', args: ['vite', '--version'] } },
      normalizedFields: ['工具 npx → run_command']
    })
    expect(normalizeRawToolCall({ name: 'npm', arguments: { command: 'run', args: ['build'] } }).call)
      .toEqual({ name: 'run_command', arguments: { command: 'npm', args: ['run', 'build'] } })
  })

  it('normalizes aliases for background command execution', () => {
    const normalized = normalizeRawToolCall({
      name: 'run-command',
      arguments: { cmd: 'npm', argv: ['run', 'electron:dev'], runInBackground: 'true' }
    })

    expect(normalized.issue).toBeUndefined()
    expect(normalized.call).toEqual({
      name: 'run_command',
      arguments: { command: 'npm', args: ['run', 'electron:dev'], background: true }
    })
    expect(normalized.normalizedFields).toEqual(expect.arrayContaining(['runInBackground → background']))
  })

  it('keeps unrelated unknown tool names as repairable issues', () => {
    expect(normalizeRawToolCall({ name: 'search_the_web', arguments: { args: ['query'] } }).issue)
      .toMatchObject({ type: 'UNKNOWN_TOOL', toolName: 'search_the_web' })
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

  it('normalizes root aliases to the current workspace for directory listing', () => {
    for (const path of ['/', '\\', './', '.\\']) {
      const prepared = prepareToolCall({ name: 'list_files', arguments: { path, recursive: false } }, { currentRequest: '查看项目结构' })
      expect(prepared.call?.arguments.path).toBe('.')
    }
  })

  it('splits a command accidentally merged with its arguments', () => {
    const prepared = prepareToolCall({ name: 'run_command', arguments: { command: '/usr/bin/git --version', args: [] } }, { currentRequest: '检查 git 版本' })

    expect(prepared.call?.arguments).toEqual({ command: '/usr/bin/git', args: ['--version'] })
    expect(prepared.adjustments).toContain('command 已拆分为可执行文件和参数')
  })

  it('forces Electron desktop launches into background mode', () => {
    const direct = prepareToolCall({
      name: 'run_command',
      arguments: { command: 'npx', args: ['electron', '.'] }
    }, { currentRequest: '启动这个桌面客户端' })
    const wrapped = prepareToolCall({
      name: 'run_command',
      arguments: { command: 'bash', args: ['-c', 'ELECTRON_DISABLE_SANDBOX=1 node_modules/electron/dist/electron .'] }
    }, { currentRequest: '启动 APP' })

    expect(direct.call?.arguments.background).toBe(true)
    if (process.platform === 'linux') expect(direct.call?.arguments.args).toEqual(['electron', '--no-sandbox', '.'])
    expect(wrapped.call?.arguments.background).toBe(true)
    expect(wrapped.adjustments).toContain('检测到桌面应用启动，使用后台模式')
  })

  it('repairs an inline Electron command and converts start_service to a background run_command', () => {
    const prepared = prepareToolCall({
      name: 'start_service',
      arguments: { command: 'ELECTRON_DISABLE_SANDBOX=1 npx electron .', args: [] }
    }, { currentRequest: '启动 Electron APP' })

    expect(prepared.call).toEqual({
      id: undefined,
      dependsOn: undefined,
      name: 'run_command',
      arguments: { command: 'npx', args: ['electron', '--no-sandbox', '.'], background: true }
    })
    expect(prepared.adjustments).toEqual(expect.arrayContaining([
      '已规范化 Electron 启动命令',
      '桌面应用改用后台命令启动',
      '检测到桌面应用启动，使用后台模式'
    ]))
  })

  it('does not background Electron installation, builds or version checks', () => {
    const calls = [
      { command: 'npm', args: ['install', 'electron'] },
      { command: 'npx', args: ['electron-builder', '--linux'] },
      { command: 'npx', args: ['electron', '--version'] }
    ]

    for (const argumentsValue of calls) {
      const prepared = prepareToolCall({ name: 'run_command', arguments: argumentsValue }, { currentRequest: '检查 Electron 项目' })
      expect(prepared.call?.arguments.background).not.toBe(true)
    }
  })

  it('preserves explicit multi-tool dependencies from Qwen aliases', () => {
    const normalized = normalizeRawToolCall({
      id: 'read_after_write',
      depends_on: ['write_config'],
      function: { name: 'read_file', arguments: '{"path":"config.json"}' }
    })

    expect(normalized.call).toEqual({
      id: 'read_after_write',
      dependsOn: ['write_config'],
      name: 'read_file',
      arguments: { path: 'config.json' }
    })
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

  it('normalizes edit aliases while preserving exact replacement text', () => {
    const normalized = normalizeRawToolCall({
      name: 'edit-file',
      arguments: { filePath: 'src/app.ts', oldText: '  old value\n', replacement: '  new value\n', replaceAll: 'true' }
    })

    expect(normalized.issue).toBeUndefined()
    expect(normalized.call).toEqual({
      name: 'edit_file',
      arguments: { path: 'src/app.ts', old_text: '  old value\n', new_text: '  new value\n', replace_all: true }
    })
    expect(normalized.normalizedFields).toEqual(expect.arrayContaining([
      'filePath → path', 'oldText → old_text', 'replacement → new_text', 'replaceAll → replace_all'
    ]))
  })

  it('requires non-empty old_text but permits an empty edit replacement', () => {
    const missingOldText = prepareToolCall(
      { name: 'edit_file', arguments: { path: 'notes.txt', new_text: '' } },
      { currentRequest: '删除 notes.txt 中的指定内容' }
    )
    const emptyOldText = prepareToolCall(
      { name: 'edit_file', arguments: { path: 'notes.txt', old_text: '', new_text: '' } },
      { currentRequest: '删除 notes.txt 中的指定内容' }
    )

    expect(missingOldText.issue).toMatchObject({ type: 'ARGUMENT_MISSING', missing: ['old_text'] })
    expect(emptyOldText.issue).toMatchObject({ type: 'ARGUMENT_MISSING', missing: ['old_text'] })
    expect(prepareToolCall(
      { name: 'edit_file', arguments: { path: 'notes.txt', old_text: 'remove me', new_text: '' } },
      { currentRequest: '删除 notes.txt 中的指定内容' }
    ).call).toEqual({ name: 'edit_file', arguments: { path: 'notes.txt', old_text: 'remove me', new_text: '' } })
  })

  it('distinguishes type errors and stream assembly errors', () => {
    const normalized = normalizeRawToolCall({ name: 'list_files', arguments: { recursive: 'sometimes' } })

    expect(normalized.issue).toMatchObject({ type: 'ARGUMENT_TYPE_ERROR', invalid: ['recursive'] })
    expect(asStreamAssemblyIssue(normalized.issue!)).toMatchObject({ type: 'STREAM_ASSEMBLY_ERROR', invalid: ['recursive'] })
  })
})
