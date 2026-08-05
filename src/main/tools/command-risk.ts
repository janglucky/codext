import { basename } from 'node:path'

export type CommandRiskLevel = 'read' | 'write' | 'blocked'
export interface CommandRiskAssessment { level: CommandRiskLevel; reason: string; displayCommand: string }

const readOnlyCommands = new Set([
  'cat', 'df', 'dir', 'du', 'echo', 'env', 'fc', 'file', 'find', 'findstr', 'free', 'grep', 'head', 'hostname',
  'ipconfig', 'jq', 'ls', 'md5sum', 'more', 'nslookup', 'ping', 'printenv', 'ps', 'pwd', 'readlink', 'realpath',
  'rg', 'sha1sum', 'sha256sum', 'sort', 'stat', 'systeminfo', 'tail', 'tasklist', 'tree', 'type', 'uname', 'uptime',
  'ver', 'where', 'which', 'whoami', 'wc'
])
const destructiveExecutables = new Set(['del', 'erase', 'rmdir', 'rd', 'format', 'shutdown', 'restart', 'reboot', 'poweroff', 'halt', 'diskpart', 'rm', 'mkfs', 'dd', 'taskkill', 'kill', 'remove-item', 'stop-process'])
const shellMutationPattern = /(?:>>?|&&|\|\||[;&|`]|\$\()/

export function classifyCommandRisk(command: string, args: string[] = []): CommandRiskAssessment {
  const displayCommand = formatCommand(command, args)
  return classify(command, args, displayCommand, 0)
}

function classify(command: string, args: string[], displayCommand: string, depth: number): CommandRiskAssessment {
  const executable = executableName(command)
  const fullCommand = [command, ...args].join(' ')
  if (!executable || /[\0\r\n]/.test(fullCommand)) return assessment('blocked', '命令格式无效。', displayCommand)
  if (isDestructiveInvocation(executable, args)) {
    return assessment('blocked', '命令包含删除、格式化、终止进程或强制清理等高危操作。', displayCommand)
  }
  if (depth > 3) return assessment('write', '嵌套命令无法可靠判定为只读。', displayCommand)

  if (executable === 'cmd') return classifyShell(args, ['/c'], displayCommand, depth)
  if (executable === 'powershell' || executable === 'pwsh') return classifyPowerShell(args, displayCommand, depth)
  if (executable === 'sh' || executable === 'bash' || executable === 'zsh') return classifyShell(args, ['-c'], displayCommand, depth)
  if (executable === 'ssh') return classifySsh(args, displayCommand, depth)
  if (executable === 'sudo' || executable === 'doas') {
    const nestedStart = args.findIndex((arg) => !arg.startsWith('-'))
    if (nestedStart < 0) return assessment('write', '提权命令未提供可识别的子命令。', displayCommand)
    return classify(args[nestedStart], args.slice(nestedStart + 1), displayCommand, depth + 1)
  }

  if (readOnlyCommands.has(executable)) {
    if (executable === 'find' && args.some((arg) => /^(?:-delete|-exec|-execdir|-ok|-okdir)$/i.test(arg))) {
      return assessment('write', 'find 参数可能修改或执行远程文件。', displayCommand)
    }
    return assessment('read', '已识别为只读查询命令。', displayCommand)
  }

  if (executable === 'curl') {
    const writes = args.some((arg) => /^(?:-o|--output|-O|--remote-name|-T|--upload-file|-d|--data|--data-raw|--data-binary|-F|--form)$/i.test(arg)) ||
      args.some((arg, index) => /^(?:-X|--request)$/i.test(arg) && !/^GET$/i.test(args[index + 1] ?? ''))
    return assessment(writes ? 'write' : 'read', writes ? 'curl 参数可能写入文件或修改远程服务。' : 'curl 请求未包含写入参数。', displayCommand)
  }

  if (executable === 'sed') {
    const writes = args.some((arg) => /^-[A-Za-z]*i[A-Za-z]*$/.test(arg) || arg === '--in-place' || /(?:^|;)\s*w\s+|\/w\s+/i.test(arg))
    return assessment(writes ? 'write' : 'read', writes ? 'sed 参数可能直接修改文件。' : 'sed 仅将处理结果输出到标准输出。', displayCommand)
  }

  if (executable === 'git') return classifyGit(args, displayCommand)
  if (executable === 'npm' || executable === 'npx' || executable === 'pnpm' || executable === 'yarn' || executable === 'corepack') {
    const operation = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
    const readOperations = new Set(['view', 'info', 'show', 'search', 'list', 'ls', 'outdated'])
    const readOnly = args.length === 1 && /^(?:--version|-v)$/.test(args[0]) || Boolean(operation && readOperations.has(operation))
    return assessment(readOnly ? 'read' : 'write', readOnly ? '包管理器只执行信息查询。' : '包管理器可能安装依赖或执行项目脚本。', displayCommand)
  }

  if (executable === 'node') {
    const readOnly = args.every((arg) => /^(?:--version|-v|--check|-c)$/.test(arg) || !arg.startsWith('-')) && args.some((arg) => /^(?:--version|-v|--check|-c)$/.test(arg))
    return assessment(readOnly ? 'read' : 'write', readOnly ? 'Node.js 仅执行版本或语法检查。' : 'Node.js 脚本可能写入文件或修改系统状态。', displayCommand)
  }

  if (executable === 'tsc') {
    const readOnly = args.includes('--noEmit') && !args.includes('--incremental')
    return assessment(readOnly ? 'read' : 'write', readOnly ? 'TypeScript 仅执行不输出文件的检查。' : 'TypeScript 编译可能生成或更新文件。', displayCommand)
  }

  if (executable === 'eslint') {
    const writes = args.includes('--fix') || args.includes('--cache')
    return assessment(writes ? 'write' : 'read', writes ? 'ESLint 参数可能修改文件或缓存。' : 'ESLint 仅执行静态检查。', displayCommand)
  }

  return assessment('write', '该命令无法可靠判定为只读，按可能修改状态处理。', displayCommand)
}

function classifyShell(args: string[], switches: string[], displayCommand: string, depth: number): CommandRiskAssessment {
  const switchIndex = args.findIndex((arg) => switches.some((value) => value.toLowerCase() === arg.toLowerCase()))
  if (switchIndex < 0 || !args[switchIndex + 1]) return assessment('write', '交互式 Shell 或缺少明确子命令，可能修改状态。', displayCommand)
  const nested = args.slice(switchIndex + 1).join(' ').trim()
  if (containsDestructiveShellCommand(nested)) return assessment('blocked', 'Shell 子命令包含高危操作。', displayCommand)
  if (shellMutationPattern.test(nested)) return assessment('write', 'Shell 子命令包含重定向、串联或脚本表达式。', displayCommand)
  const tokens = splitCommandLine(nested)
  if (!tokens.length) return assessment('write', '无法识别 Shell 子命令。', displayCommand)
  return classify(tokens[0], tokens.slice(1), displayCommand, depth + 1)
}

function classifyPowerShell(args: string[], displayCommand: string, depth: number): CommandRiskAssessment {
  const commandIndex = args.findIndex((arg) => /^(?:-command|-c)$/i.test(arg))
  if (commandIndex < 0 || !args[commandIndex + 1]) return assessment('write', 'PowerShell 未提供可识别的只读命令。', displayCommand)
  const nested = args.slice(commandIndex + 1).join(' ').trim()
  if (containsDestructiveShellCommand(nested)) return assessment('blocked', 'PowerShell 子命令包含高危操作。', displayCommand)
  if (shellMutationPattern.test(nested)) return assessment('write', 'PowerShell 子命令包含重定向、串联或脚本表达式。', displayCommand)
  const tokens = splitCommandLine(nested)
  const cmdlet = tokens[0]?.toLowerCase() ?? ''
  const readOnly = cmdlet.startsWith('get-') || ['select-object', 'measure-object', 'test-path', 'resolve-path', 'compare-object'].includes(cmdlet)
  return readOnly ? assessment('read', 'PowerShell 仅执行只读查询。', displayCommand) : classify(tokens[0] ?? '', tokens.slice(1), displayCommand, depth + 1)
}

function classifySsh(args: string[], displayCommand: string, depth: number): CommandRiskAssessment {
  const optionsWithValues = new Set(['-b', '-c', '-d', '-e', '-f', '-i', '-j', '-l', '-m', '-o', '-p', '-q', '-r', '-s', '-w'])
  let index = 0
  while (index < args.length && args[index].startsWith('-')) {
    const current = args[index]
    const option = current.slice(0, 2).toLowerCase()
    index += optionsWithValues.has(option) && current.length === 2 ? 2 : 1
  }
  if (index >= args.length - 1) return assessment('write', 'SSH 未提供明确的远程只读命令。', displayCommand)
  const remoteCommand = args.slice(index + 1).join(' ').trim()
  if (containsDestructiveShellCommand(remoteCommand)) return assessment('blocked', 'SSH 远程命令包含高危操作。', displayCommand)
  if (shellMutationPattern.test(remoteCommand)) return assessment('write', 'SSH 远程命令包含重定向、串联或脚本表达式。', displayCommand)
  const tokens = splitCommandLine(remoteCommand)
  if (!tokens.length) return assessment('write', '无法识别 SSH 远程命令。', displayCommand)
  const nested = classify(tokens[0], tokens.slice(1), displayCommand, depth + 1)
  return nested.level === 'read' ? assessment('read', 'SSH 远程命令已识别为只读查询。', displayCommand) : nested
}

function classifyGit(args: string[], displayCommand: string): CommandRiskAssessment {
  const operation = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
  const readOperations = new Set(['status', 'diff', 'log', 'show', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe'])
  const readBranch = operation === 'branch' && !args.some((arg) => /^(?:-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--set-upstream-to)$/i.test(arg))
  const readRemote = operation === 'remote' && args.every((arg) => arg === 'remote' || arg === '-v' || arg === '--verbose')
  const readConfig = operation === 'config' && args.some((arg) => /^(?:--get|--get-all|--list|-l)$/i.test(arg))
  const readOnly = Boolean(operation && readOperations.has(operation)) || readBranch || readRemote || readConfig
  return assessment(readOnly ? 'read' : 'write', readOnly ? 'Git 仅执行仓库信息查询。' : 'Git 命令可能修改工作树、历史或远程仓库。', displayCommand)
}

function splitCommandLine(value: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) tokens.push(match[1] ?? match[2] ?? match[3])
  return tokens
}

function executableName(command: string): string {
  return basename(command.trim().replace(/[。．](?=(?:cmd|bat|exe)$)/i, '.')).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')
}

function containsDestructiveShellCommand(commandLine: string): boolean {
  return commandLine.split(/&&|\|\||[;&|]/).some((segment) => {
    const tokens = splitCommandLine(segment.trim())
    if (!tokens.length) return false
    const executable = executableName(tokens[0])
    if (executable === 'sudo' || executable === 'doas') {
      const nestedStart = tokens.slice(1).findIndex((arg) => !arg.startsWith('-'))
      if (nestedStart < 0) return false
      return isDestructiveInvocation(executableName(tokens[nestedStart + 1]), tokens.slice(nestedStart + 2))
    }
    return isDestructiveInvocation(executable, tokens.slice(1))
  })
}

function isDestructiveInvocation(executable: string, args: string[]): boolean {
  if (destructiveExecutables.has(executable)) return true
  if (executable === 'find') {
    if (args.includes('-delete')) return true
    const execIndex = args.findIndex((arg) => /^(?:-exec|-execdir|-ok|-okdir)$/.test(arg))
    if (execIndex >= 0 && args[execIndex + 1]) return isDestructiveInvocation(executableName(args[execIndex + 1]), args.slice(execIndex + 2))
  }
  if (executable === 'xargs' && args[0]) return isDestructiveInvocation(executableName(args[0]), args.slice(1))
  if (executable === 'reg' && args[0]?.toLowerCase() === 'delete') return true
  if (executable === 'git') {
    const operation = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
    if (operation === 'clean') return true
    if (operation === 'reset' && args.includes('--hard')) return true
    if (operation === 'push' && args.some((arg) => /^(?:--force|--force-with-lease|-f)$/.test(arg))) return true
  }
  if (executable === 'systemctl' && args.some((arg) => /^(?:poweroff|reboot|halt)$/i.test(arg))) return true
  return false
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => /^[\w@%+=:,./\\-]+$/.test(part) ? part : JSON.stringify(part)).join(' ')
}

function assessment(level: CommandRiskLevel, reason: string, displayCommand: string): CommandRiskAssessment {
  return { level, reason, displayCommand }
}
