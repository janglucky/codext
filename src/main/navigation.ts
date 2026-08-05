import { realpath, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

const textExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.env', '.go', '.h', '.hpp', '.html', '.htm', '.ini', '.java',
  '.js', '.jsx', '.json', '.less', '.log', '.md', '.mjs', '.php', '.py', '.rs', '.sass', '.scss', '.sh', '.sql',
  '.svg', '.svelte', '.tex', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml'
])

export function isTextFilePath(filePath: string): boolean {
  const normalized = filePath.trim().replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile' || name === '.gitignore' || name === '.env') return true
  const dot = name.lastIndexOf('.')
  return dot >= 0 && textExtensions.has(name.slice(dot))
}

export async function validateApplicationPath(applicationPath: string): Promise<string> {
  const requestedPath = applicationPath.trim()
  if (!requestedPath || !isAbsolute(requestedPath)) throw new Error('默认应用路径必须是绝对路径。')
  try {
    const target = await realpath(requestedPath)
    if (!(await stat(target)).isFile()) throw new Error('invalid application')
    return target
  } catch {
    throw new Error('配置的默认应用不存在，请在设置中重新选择。')
  }
}

export function launchApplication(applicationPath: string, target: string, spawnProcess = spawn): Promise<void> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    let settled = false
    const child = spawnProcess(applicationPath, [target], { detached: true, stdio: 'ignore', windowsHide: false })
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      rejectLaunch(error)
    }
    child.once('error', fail)
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolveLaunch()
    })
  })
}

export async function resolveWorkspaceFile(workspacePath: string, filePath: string): Promise<string> {
  const requestedPath = filePath.trim()
  if (!requestedPath || isAbsolute(requestedPath)) throw new Error('文件路径必须是工作区内的相对路径。')

  const workspaceRoot = await realpath(resolve(workspacePath))
  const target = await realpath(resolve(workspaceRoot, requestedPath))
  const relativePath = relative(workspaceRoot, target)
  if (relativePath === '..' || relativePath.startsWith('..\\') || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error('不能打开工作区外的文件。')
  }
  if (!(await stat(target)).isFile()) throw new Error('只能使用本地工具打开文件。')
  return target
}

export function normalizeWebUrl(value: string): string {
  const requestedUrl = value.trim()
  if (!requestedUrl || requestedUrl.length > 2048) throw new Error('Web 服务地址无效。')
  const url = new URL(requestedUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅允许打开 HTTP 或 HTTPS 地址。')
  if (url.username || url.password) throw new Error('Web 服务地址不能包含登录凭据。')
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') url.hostname = 'localhost'
  return url.toString()
}
