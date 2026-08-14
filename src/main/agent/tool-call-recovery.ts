import { isToolName, toolRegistry, type ToolArguments, type ToolCall, type ToolName } from '../tools/tool-registry'

export type ToolCallIssueType =
  | 'ARGUMENTS_INVALID_JSON'
  | 'ARGUMENT_TYPE_ERROR'
  | 'ARGUMENT_MISSING'
  | 'ARGUMENT_AMBIGUOUS'
  | 'UNKNOWN_TOOL'
  | 'STREAM_ASSEMBLY_ERROR'

export interface ToolCallIssue {
  type: ToolCallIssueType
  toolName?: string
  received: unknown
  missing: string[]
  invalid: string[]
  candidates: string[]
  recoverable: boolean
  partialCall?: ToolCall
  signature: string
}

export interface ToolCallNormalization {
  call?: ToolCall
  issue?: ToolCallIssue
  normalizedFields: string[]
}

export interface ToolCallPreparation {
  call?: ToolCall
  issue?: ToolCallIssue
  adjustments: string[]
}

export interface ToolCallContext {
  currentRequest: string
  latestObservation?: string
}

type ArgumentNormalization = {
  arguments?: ToolArguments
  issueType?: 'ARGUMENTS_INVALID_JSON' | 'ARGUMENT_TYPE_ERROR'
  invalid: string[]
  normalizedFields: string[]
}

const PATH_INFERENCE_TOOLS = new Set<ToolName>(['read_file', 'edit_file', 'parse_word', 'parse_excel', 'parse_powerpoint'])
const PATH_EXTENSIONS: Partial<Record<ToolName, Set<string>>> = {
  parse_word: new Set(['docx']),
  parse_excel: new Set(['xlsx']),
  parse_powerpoint: new Set(['pptx'])
}
const GENERIC_FILE_EXTENSIONS = new Set([
  'bat', 'c', 'cc', 'cfg', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv', 'doc', 'docx', 'env', 'go', 'h', 'hpp',
  'htm', 'html', 'ini', 'java', 'js', 'json', 'jsonc', 'jsx', 'kt', 'lock', 'log', 'md', 'mdx', 'mjs', 'mts',
  'pdf', 'php', 'ppt', 'pptx', 'properties', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'toml', 'ts',
  'tsx', 'txt', 'vue', 'xml', 'xls', 'xlsx', 'yaml', 'yml'
])
const EXECUTABLE_TOOL_ALIASES = new Set([
  'bash', 'cat', 'cmd', 'curl', 'dir', 'eslint', 'find', 'git', 'grep', 'jq', 'ls', 'node', 'npm', 'npx',
  'pnpm', 'pytest', 'rg', 'sh', 'ssh', 'tsc', 'uvicorn', 'vite', 'yarn', 'zsh'
])
const PATH_PATTERN = /(?:^|[\s`"'（(])((?:(?:[\p{L}\p{N}_@+.-]+)[\\/])*[\p{L}\p{N}_@+-]+\.[A-Za-z0-9]{1,12})(?=$|[\s`"'）),，。:：;；\]}>])/gimu

export function normalizeRawToolCall(value: unknown): ToolCallNormalization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { issue: createIssue('UNKNOWN_TOOL', undefined, value), normalizedFields: [] }
  }
  const raw = value as Record<string, unknown>
  const functionValue = raw.function
  const source = functionValue && typeof functionValue === 'object' && !Array.isArray(functionValue)
    ? functionValue as Record<string, unknown>
    : raw
  const rawName = typeof source.name === 'string' ? source.name : ''
  const rawId = raw.id ?? source.id
  const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : undefined
  const rawArguments = source.arguments ?? source.parameters ?? source.input ?? source.action_input
  const dependsOn = normalizeDependencies(raw.depends_on ?? raw.dependsOn ?? raw.after ?? source.depends_on ?? source.dependsOn ?? source.after ?? dependencyValue(rawArguments))
  const normalizedName = normalizeToolName(rawName)
  if (!isToolName(normalizedName)) {
    const executableCall = normalizeExecutableToolAlias(rawName, normalizedName, rawArguments, id, dependsOn)
    if (executableCall) return executableCall
    return { issue: createIssue('UNKNOWN_TOOL', rawName || undefined, value), normalizedFields: [] }
  }

  const normalized = normalizeArgumentsDetailed(rawArguments)
  const partialCall: ToolCall = { id, dependsOn, name: normalizedName, arguments: normalized.arguments ?? {} }
  if (normalized.issueType) {
    return {
      issue: createIssue(normalized.issueType, normalizedName, rawArguments, {
        invalid: normalized.invalid,
        partialCall
      }),
      normalizedFields: normalized.normalizedFields
    }
  }
  return { call: partialCall, normalizedFields: normalized.normalizedFields }
}

function normalizeExecutableToolAlias(rawName: string, normalizedName: string, rawArguments: unknown, id?: string, dependsOn?: string[]): ToolCallNormalization | undefined {
  if (!EXECUTABLE_TOOL_ALIASES.has(normalizedName)) return undefined
  const normalized = normalizeArgumentsDetailed(rawArguments)
  if (normalized.issueType) {
    const partialCall: ToolCall = { id, dependsOn, name: 'run_command', arguments: { command: rawName.trim(), args: [] } }
    return {
      issue: createIssue(normalized.issueType, 'run_command', rawArguments, { invalid: normalized.invalid, partialCall }),
      normalizedFields: ['工具 ' + rawName + ' → run_command', ...normalized.normalizedFields]
    }
  }
  const executableArguments = normalized.arguments ?? {}
  const args = [...(executableArguments.args ?? [])]
  if (executableArguments.command) args.unshift(executableArguments.command)
  return {
    call: { id, dependsOn, name: 'run_command', arguments: { command: rawName.trim(), args } },
    normalizedFields: ['工具 ' + rawName + ' → run_command', ...normalized.normalizedFields]
  }
}

export function normalizeToolArguments(value: unknown): ToolArguments | undefined {
  const normalized = normalizeArgumentsDetailed(value)
  return normalized.issueType ? undefined : normalized.arguments
}

export function prepareToolCall(call: ToolCall, context: ToolCallContext): ToolCallPreparation {
  let toolName = call.name
  const args: ToolArguments = { ...call.arguments }
  const adjustments: string[] = []

  if (call.name === 'list_files') {
    if (typeof args.path === 'string' && isWorkspaceRootAlias(args.path)) {
      if (args.path.trim() !== '.') adjustments.push('path 已规范化为工作区根目录 .')
      args.path = '.'
    }
    if (!nonEmptyString(args.path)) {
      args.path = '.'
      adjustments.push('path 使用工作区根目录 .')
    }
    if (typeof args.recursive !== 'boolean') {
      args.recursive = false
      adjustments.push('recursive 使用默认值 false')
    }
  }
  if ((call.name === 'run_command' || call.name === 'start_service') && !args.args) {
    args.args = []
    adjustments.push('args 使用默认空数组')
  }
  if ((toolName === 'run_command' || toolName === 'start_service') && nonEmptyString(args.command)) {
    const normalizedLaunch = normalizeInlineElectronLaunch(args.command, args.args ?? [])
    if (normalizedLaunch) {
      args.command = normalizedLaunch.command
      args.args = normalizedLaunch.args
      adjustments.push('已规范化 Electron 启动命令')
    }
  }
  if ((toolName === 'run_command' || toolName === 'start_service') && nonEmptyString(args.command) && !(args.args ?? []).length) {
    const normalizedCommand = normalizeInlineCommandInvocation(args.command)
    if (normalizedCommand) {
      args.command = normalizedCommand.command
      args.args = normalizedCommand.args
      adjustments.push('command 已拆分为可执行文件和参数')
    }
  }
  if ((toolName === 'run_command' || toolName === 'start_service') && nonEmptyString(args.command) && shouldRunDesktopAppInBackground(args.command, args.args ?? [], context.currentRequest)) {
    if (toolName === 'start_service') {
      toolName = 'run_command'
      adjustments.push('桌面应用改用后台命令启动')
    }
    if (args.background !== true) {
      args.background = true
      adjustments.push('检测到桌面应用启动，使用后台模式')
    }
    if (process.platform === 'linux' && isElectronLaunch(args.command, args.args ?? []) && !(args.args ?? []).includes('--no-sandbox')) {
      const electronArgumentIndex = /^(?:npx|pnpx)$/i.test(args.command) ? 1 : 0
      args.args = [...(args.args ?? [])]
      args.args.splice(electronArgumentIndex, 0, '--no-sandbox')
      adjustments.push('Linux Electron 启动使用 --no-sandbox')
    }
  }

  const required = requiredArguments(toolName)
  let missing = required.filter((field) => !hasRequiredValue(args, field))
  if (missing.includes('path')) {
    const candidates = collectPathCandidates(context, toolName)
    if (PATH_INFERENCE_TOOLS.has(toolName) && candidates.length === 1) {
      args.path = candidates[0]
      missing = missing.filter((field) => field !== 'path')
      adjustments.push('path 从当前任务唯一候选补全为 ' + candidates[0])
    } else if (candidates.length > 1) {
      const partialCall = { name: toolName, arguments: args }
      return {
        issue: createIssue('ARGUMENT_AMBIGUOUS', toolName, call.arguments, {
          missing,
          candidates,
          partialCall
        }),
        adjustments
      }
    }
  }

  if (missing.length) {
    const candidates = missing.includes('path') ? collectPathCandidates(context, toolName) : []
    const partialCall = { name: toolName, arguments: args }
    return {
      issue: createIssue('ARGUMENT_MISSING', toolName, call.arguments, {
        missing,
        candidates,
        partialCall
      }),
      adjustments
    }
  }

  return { call: { id: call.id, dependsOn: call.dependsOn, name: toolName, arguments: args }, adjustments }
}

function isWorkspaceRootAlias(value: string): boolean {
  const normalized = value.trim()
  return normalized === '.' || normalized === './' || normalized === '.\\' || normalized === '/' || normalized === '\\'
}

function normalizeInlineCommandInvocation(command: string): { command: string; args: string[] } | undefined {
  const value = command.trim()
  if (!value || !/\s/.test(value) || /[;&|`$<>\r\n]/.test(value)) return undefined
  const tokens = splitSafeCommandLine(value)
  if (tokens.length < 2) return undefined
  const executable = tokens[0].replaceAll('\\', '/').split('/').at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') ?? ''
  if (!executable || executable === 'env') return undefined
  return { command: tokens[0], args: tokens.slice(1) }
}

function normalizeInlineElectronLaunch(command: string, args: string[]): { command: string; args: string[] } | undefined {
  if (args.length || !/\s/.test(command.trim())) return undefined
  let value = command.trim()
  let disableSandbox = false
  const environmentPrefix = /^(?:env\s+)?ELECTRON_DISABLE_SANDBOX=(?:1|true)\s+/i
  if (environmentPrefix.test(value)) {
    disableSandbox = true
    value = value.replace(environmentPrefix, '')
  }
  if (/[;&|`$<>\r\n]/.test(value)) return undefined
  const tokens = splitSafeCommandLine(value)
  if (!tokens.length) return undefined
  const executable = tokens[0].replaceAll('\\', '/').split('/').at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') ?? ''
  const executableIsElectron = executable === 'electron'
  const packageRunner = /^(?:npx|pnpx)$/.test(executable) && tokens[1]?.toLowerCase() === 'electron'
  if (!executableIsElectron && !packageRunner) return undefined

  const normalizedArgs = tokens.slice(1)
  if (disableSandbox && !normalizedArgs.includes('--no-sandbox')) {
    normalizedArgs.splice(packageRunner ? 1 : 0, 0, '--no-sandbox')
  }
  return { command: tokens[0], args: normalizedArgs }
}

function splitSafeCommandLine(value: string): string[] {
  return value.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|\S+/g)
    ?.map((item) => item.replace(/^['"]|['"]$/g, '')) ?? []
}

function shouldRunDesktopAppInBackground(command: string, args: string[], currentRequest: string): boolean {
  const executable = command.trim().replaceAll('\\', '/').split('/').at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') ?? ''
  const commandLine = [command, ...args].join(' ').replaceAll('\\', '/').toLowerCase()
  const finiteElectronOperation = /(?:^|\s)(?:electron-builder|electron-packager)(?:\s|$)|(?:^|\s)(?:--version|-v|install|add|build|pack|package|test|lint|check)(?:\s|$)/i.test(commandLine)
  if (finiteElectronOperation) return false

  const directElectronLaunch = executable === 'electron' || /(?:^|[\s"'])[^\s"']*electron\/dist\/electron(?:\s|["']|$)/i.test(commandLine)
  const packageElectronLaunch = /^(?:npx|pnpx)$/.test(executable) && /^electron(?:\s|$)/i.test(args.join(' ')) ||
    /^(?:npm|pnpm|yarn|yarnpkg)$/.test(executable) && args.some((arg) => /^(?:electron(?::|-)?(?:dev|start)?|dev:electron)$/i.test(arg))
  if (directElectronLaunch || packageElectronLaunch || /(?:^|[\s"'])electron(?:\s+\.|\s+--no-sandbox|["']|$)/i.test(commandLine)) return true

  const desktopIntent = /electron|桌面(?:应用|客户端|app)|客户端窗口|desktop\s+(?:app|client)/i.test(currentRequest)
  if (!desktopIntent) return false
  if (/^(?:npm|pnpm|yarn|yarnpkg)$/.test(executable)) {
    const operation = args[0]?.toLowerCase()
    return operation === 'start' || operation === 'dev' || operation === 'run' && /^(?:dev|start|electron(?::|-)?dev)$/i.test(args[1] ?? '')
  }
  return false
}

function isElectronLaunch(command: string, args: string[]): boolean {
  const executable = command.trim().replaceAll('\\', '/').split('/').at(-1)?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') ?? ''
  if (executable === 'electron' || /electron\/dist\/electron$/.test(command.replaceAll('\\', '/').toLowerCase())) return true
  return /^(?:npx|pnpx)$/.test(executable) && args[0]?.toLowerCase() === 'electron'
}

export function asStreamAssemblyIssue(issue: ToolCallIssue): ToolCallIssue {
  return createIssue('STREAM_ASSEMBLY_ERROR', issue.toolName, issue.received, {
    missing: issue.missing,
    invalid: issue.invalid,
    candidates: issue.candidates,
    recoverable: true,
    partialCall: issue.partialCall
  })
}

export function buildToolRepairPrompt(issue: ToolCallIssue, context: ToolCallContext, enabledTools: string[]): string {
  const definition = issue.toolName && isToolName(issue.toolName) ? toolRegistry[issue.toolName] : undefined
  const diagnostic = {
    type: issue.type,
    tool: issue.toolName ?? null,
    missing: issue.missing,
    invalid: issue.invalid,
    received: summarizeReceived(issue.received),
    candidates: issue.candidates,
    recoverable: issue.recoverable,
    next: 'repair_action'
  }
  return [
    'TOOL_ARGUMENT_ERROR：上一条工具调用未执行。',
    JSON.stringify(diagnostic, null, 2),
    definition ? '工具参数 Schema：\n' + JSON.stringify(definition.inputSchema, null, 2) : '允许工具：' + enabledTools.join('、'),
    '当前用户请求：\n' + trimPromptText(context.currentRequest, 1800),
    context.latestObservation ? '最新 Observation：\n' + trimPromptText(context.latestObservation, 1800) : '',
    '仅返回一个修正后的 Action JSON：{"action":{"name":"工具名","arguments":{}}}。',
    '不要输出 Thought、解释、Markdown、Final 或已经成功执行过的 Action；不能确定参数时，只使用上面的当前请求和最新 Observation，不得从更早历史猜测。'
  ].filter(Boolean).join('\n\n')
}

export function issueFailureMessage(issue: ToolCallIssue): string {
  const details = [
    '[' + issue.type + ']',
    issue.toolName ? '工具 ' + issue.toolName : '无法识别工具名称',
    issue.missing.length ? '缺少 ' + issue.missing.join('、') : '',
    issue.invalid.length ? '字段类型错误 ' + issue.invalid.join('、') : '',
    issue.candidates.length > 1 ? '存在多个候选值：' + issue.candidates.join('、') : ''
  ].filter(Boolean)
  return '工具调用参数修复失败：' + details.join('；') + '。请补充明确参数后重试。'
}

export function applyPathCandidate(issue: ToolCallIssue, path: string): ToolCall | undefined {
  if (!issue.partialCall || !issue.candidates.includes(path)) return undefined
  return { ...issue.partialCall, arguments: { ...issue.partialCall.arguments, path } }
}

function normalizeArgumentsDetailed(value: unknown): ArgumentNormalization {
  if (value === undefined || value === null || value === '') return { arguments: {}, invalid: [], normalizedFields: [] }
  let source: Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { issueType: 'ARGUMENT_TYPE_ERROR', invalid: ['arguments'], normalizedFields: [] }
      }
      source = parsed as Record<string, unknown>
    } catch {
      return { issueType: 'ARGUMENTS_INVALID_JSON', invalid: ['arguments'], normalizedFields: [] }
    }
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    source = value as Record<string, unknown>
  } else {
    return { issueType: 'ARGUMENT_TYPE_ERROR', invalid: ['arguments'], normalizedFields: [] }
  }

  const args: ToolArguments = {}
  const invalid: string[] = []
  const normalizedFields: string[] = []
  const path = readAlias(source, 'path', ['file_path', 'filePath', 'filepath', 'file', 'directory', 'dir', 'target_path', 'targetPath'])
  const content = readAlias(source, 'content', ['text', 'data', 'file_content', 'fileContent'])
  const oldText = readAlias(source, 'old_text', ['oldText', 'search', 'find', 'target'])
  const newText = readAlias(source, 'new_text', ['newText', 'replacement', 'replace'])
  const replaceAll = readAlias(source, 'replace_all', ['replaceAll'])
  const command = readAlias(source, 'command', ['cmd', 'executable', 'program'])
  const commandArgs = readAlias(source, 'args', ['argv', 'parameters', 'command_args', 'commandArgs'])
  const background = readAlias(source, 'background', ['detached', 'run_in_background', 'runInBackground'])
  const recursive = readAlias(source, 'recursive', ['recurse'])
  const outputPath = readAlias(source, 'output_path', ['outputPath'])
  const maxCharacters = readAlias(source, 'max_characters', ['maxCharacters'])
  const includeNotes = readAlias(source, 'include_notes', ['includeNotes'])

  assignString(args, 'path', path, invalid, normalizedFields)
  assignString(args, 'content', content, invalid, normalizedFields, false)
  assignString(args, 'old_text', oldText, invalid, normalizedFields, false)
  assignString(args, 'new_text', newText, invalid, normalizedFields, false)
  assignString(args, 'command', command, invalid, normalizedFields)
  assignString(args, 'output_path', outputPath, invalid, normalizedFields)

  if (commandArgs.found) {
    const normalizedArgs = normalizeStringArray(commandArgs.value)
    if (normalizedArgs) args.args = normalizedArgs
    else invalid.push('args')
    if (commandArgs.alias) normalizedFields.push(commandArgs.alias + ' → args')
  }
  if (recursive.found) {
    const normalized = normalizeBoolean(recursive.value)
    if (normalized === undefined) invalid.push('recursive')
    else args.recursive = normalized
    if (recursive.alias) normalizedFields.push(recursive.alias + ' → recursive')
  }
  if (background.found) {
    const normalized = normalizeBoolean(background.value)
    if (normalized === undefined) invalid.push('background')
    else args.background = normalized
    if (background.alias) normalizedFields.push(background.alias + ' → background')
  }
  if (replaceAll.found) {
    const normalized = normalizeBoolean(replaceAll.value)
    if (normalized === undefined) invalid.push('replace_all')
    else args.replace_all = normalized
    if (replaceAll.alias) normalizedFields.push(replaceAll.alias + ' → replace_all')
  }
  if (includeNotes.found) {
    const normalized = normalizeBoolean(includeNotes.value)
    if (normalized === undefined) invalid.push('include_notes')
    else args.include_notes = normalized
    if (includeNotes.alias) normalizedFields.push(includeNotes.alias + ' → include_notes')
  }
  if (maxCharacters.found) {
    const normalized = normalizeNumber(maxCharacters.value)
    if (normalized === undefined || normalized < 1000 || normalized > 120000) invalid.push('max_characters')
    else args.max_characters = normalized
    if (maxCharacters.alias) normalizedFields.push(maxCharacters.alias + ' → max_characters')
  }

  return {
    arguments: args,
    issueType: invalid.length ? 'ARGUMENT_TYPE_ERROR' : undefined,
    invalid,
    normalizedFields
  }
}

function readAlias(source: Record<string, unknown>, canonical: string, aliases: string[]): { found: boolean; value?: unknown; alias?: string } {
  if (Object.prototype.hasOwnProperty.call(source, canonical)) return { found: true, value: source[canonical] }
  const alias = aliases.find((key) => Object.prototype.hasOwnProperty.call(source, key))
  return alias ? { found: true, value: source[alias], alias } : { found: false }
}

function assignString(args: ToolArguments, key: 'path' | 'content' | 'old_text' | 'new_text' | 'command' | 'output_path', source: { found: boolean; value?: unknown; alias?: string }, invalid: string[], normalizedFields: string[], trim = true): void {
  if (!source.found) return
  if (typeof source.value !== 'string') {
    invalid.push(key)
    return
  }
  args[key] = trim ? source.value.trim() : source.value
  if (source.alias) normalizedFields.push(source.alias + ' → ' + key)
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed as string[] : undefined
  } catch {
    return undefined
  }
}

function dependencyValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  return source.depends_on ?? source.dependsOn ?? source.after
}

function normalizeDependencies(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const normalized = [...new Set(values.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  return normalized.length ? normalized : undefined
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && /^(?:true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true'
  return undefined
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  return undefined
}

function requiredArguments(name: ToolName): string[] {
  const required = toolRegistry[name].inputSchema.required
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string') : []
}

function hasRequiredValue(args: ToolArguments, field: string): boolean {
  const value = (args as Record<string, unknown>)[field]
  if (field === 'content' || field === 'new_text') return typeof value === 'string'
  if (field === 'old_text') return typeof value === 'string' && value.length > 0
  return typeof value === 'string' ? Boolean(value.trim()) : value !== undefined && value !== null
}

function collectPathCandidates(context: ToolCallContext, toolName: ToolName): string[] {
  const current = extractPaths(context.currentRequest, toolName)
  if (current.length) return current
  return extractPaths(context.latestObservation ?? '', toolName)
}

function extractPaths(text: string, toolName: ToolName): string[] {
  const extensions = PATH_EXTENSIONS[toolName]
  const paths = new Set<string>()
  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[1].trim().replaceAll('\\', '/')
    if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..') || /^https?:/i.test(path)) continue
    const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
    if (extensions && !extensions.has(extension)) continue
    if (!extensions && !GENERIC_FILE_EXTENSIONS.has(extension)) continue
    paths.add(path)
  }
  return [...paths].slice(0, 8)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replaceAll('-', '_')
}

function createIssue(type: ToolCallIssueType, toolName: string | undefined, received: unknown, overrides: Partial<Omit<ToolCallIssue, 'type' | 'toolName' | 'received' | 'signature'>> = {}): ToolCallIssue {
  const base = {
    missing: overrides.missing ?? [],
    invalid: overrides.invalid ?? [],
    candidates: overrides.candidates ?? [],
    recoverable: overrides.recoverable ?? true,
    partialCall: overrides.partialCall
  }
  return {
    type,
    toolName,
    received,
    ...base,
    signature: JSON.stringify([type, toolName ?? '', base.missing, base.invalid, base.candidates])
  }
}

function summarizeReceived(received: unknown): unknown {
  if (!received || typeof received !== 'object' || Array.isArray(received)) {
    return typeof received === 'string' && received.length > 500 ? received.slice(0, 500) + '…' : received
  }
  const source = received as Record<string, unknown>
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [
    key,
    key === 'content' && typeof value === 'string' && value.length > 200 ? '[字符串 ' + value.length + ' 字符]' : value
  ]))
}

function trimPromptText(text: string, maxCharacters: number): string {
  const normalized = text.trim()
  if (normalized.length <= maxCharacters) return normalized
  return normalized.slice(0, Math.floor(maxCharacters * 0.7)) + '\n…\n' + normalized.slice(-Math.floor(maxCharacters * 0.3))
}
