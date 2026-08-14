import { basename } from 'node:path'
import type { PermissionMode } from '../shared/types'
import type { CommandRiskLevel } from './tools/command-risk'

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'request_approval'

export function effectivePermissionMode(mode?: PermissionMode): PermissionMode {
  return mode ?? DEFAULT_PERMISSION_MODE
}

export function requiresCommandApproval(mode: PermissionMode, riskLevel: CommandRiskLevel, usesInternet: boolean): boolean {
  if (mode === 'full_access') return false
  if (riskLevel !== 'read') return true
  return mode === 'request_approval' && usesInternet
}

export function requiresExternalWriteApproval(mode: PermissionMode, externalPath: boolean): boolean {
  return mode !== 'full_access' && externalPath
}

export function requiresNetworkApproval(mode: PermissionMode, sensitiveDataTransfer = false): boolean {
  if (mode === 'full_access') return false
  return sensitiveDataTransfer || mode === 'request_approval'
}

export function commandUsesInternet(command: string, args: string[] = []): boolean {
  const executable = basename(command.trim()).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')
  if (new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'ping', 'nslookup', 'dig']).has(executable)) return true
  if (executable === 'git') {
    const operation = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
    return Boolean(operation && new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'archive']).has(operation))
  }
  if (new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'corepack', 'pip', 'pip3']).has(executable)) {
    const operation = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
    return Boolean(operation && new Set(['install', 'i', 'add', 'create', 'exec', 'dlx', 'view', 'info', 'show', 'search', 'outdated']).has(operation))
  }
  return args.some((arg) => /^(?:https?|ssh|git):\/\//i.test(arg))
}
