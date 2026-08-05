import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { classifyCommandRisk } from './command-risk'

const execFileAsync = promisify(execFile)
const blockedCommands = /(^|\s)(del|erase|rmdir|rd|format|shutdown|restart|diskpart)(\s|$)|reg\s+delete/i
const DECRYPT_UPLOAD_URL = 'http://172.16.51.141:8899/encrypt/file/tranferEncryptFileUrl'
const DECRYPT_SERVICE_ORIGIN = 'http://172.16.51.141:8899'
const DECRYPT_DOWNLOAD_PATH = '/encrypt/file/downloadEncryptFile/'
const DECRYPT_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 120_000
const PACKAGE_COMMAND_TIMEOUT_MS = 10 * 60_000
const MAX_DECRYPT_FILE_SIZE = 50 * 1024 * 1024
const MAX_LIST_ENTRIES = 500
const DECRYPT_EXTENSIONS = new Set(['.txt', '.csv', '.pdf', '.docx', '.xlsx', '.pptx'])
const WINDOWS_BATCH_EXTENSIONS = new Set(['.cmd', '.bat'])
const WINDOWS_BATCH_META_CHARACTERS = /[\0\r\n"&|<>^%!()]/
const SERVICE_START_TIMEOUT_MS = 30_000

interface RunningWorkspaceService { child: ChildProcess; url?: string; logPath: string }
const runningWorkspaceServices = new Map<string, RunningWorkspaceService>()

export async function stopAllWorkspaceServices(): Promise<void> {
  const services = [...runningWorkspaceServices.values()]
  runningWorkspaceServices.clear()
  await Promise.all(services.map((service) => new Promise<void>((resolveStop) => {
    if (service.child.exitCode !== null) {
      void rm(service.logPath, { force: true })
      resolveStop()
      return
    }
    const timer = setTimeout(resolveStop, 2000)
    service.child.once('exit', () => {
      clearTimeout(timer)
      void rm(service.logPath, { force: true })
      resolveStop()
    })
    service.child.kill()
  })))
}

export class WorkspaceTools {
  constructor(private readonly workspacePath: string) {}

  async readFile(filePath: string): Promise<string> {
    return readFile(await this.resolveExistingPath(filePath), 'utf8')
  }

  async readBinaryFile(filePath: string): Promise<Buffer> {
    const source = await this.resolveExistingPath(filePath)
    if (!(await stat(source)).isFile()) throw new Error('读取路径必须是文件。')
    return readFile(source)
  }

  async writeFile(filePath: string, content: string): Promise<string> {
    const target = this.resolvePath(filePath)
    await this.ensureSafeOutputPath(target)
    await writeFile(target, content, 'utf8')
    return '已写入 ' + this.displayPath(target)
  }

  async saveBinaryFile(filePath: string, content: Uint8Array): Promise<string> {
    const target = this.resolvePath(filePath)
    await this.ensureSafeOutputPath(target)
    await writeFile(target, content)
    return this.displayPath(target)
  }

  async createDirectory(directoryPath: string): Promise<string> {
    const target = this.resolvePath(directoryPath)
    await this.ensureSafeDirectoryPath(target)
    return '已创建目录 ' + this.displayPath(target)
  }

  async listFiles(directoryPath = '.', recursive = false): Promise<string> {
    const target = await this.resolveExistingPath(directoryPath)
    const targetStat = await stat(target)
    if (!targetStat.isDirectory()) throw new Error('列举文件的路径必须是目录。')

    const lines: string[] = []
    let truncated = false
    const visit = async (currentPath: string): Promise<void> => {
      const entries = await readdir(currentPath, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
      for (const entry of entries) {
        if (lines.length >= MAX_LIST_ENTRIES) {
          truncated = true
          return
        }
        const entryPath = join(currentPath, entry.name)
        const entryRelativePath = this.displayPath(entryPath)
        if (entry.isDirectory()) {
          lines.push('[目录] ' + entryRelativePath + '/')
          if (recursive) await visit(entryPath)
        } else if (entry.isFile()) {
          const fileStat = await stat(entryPath)
          lines.push('[文件] ' + entryRelativePath + ' (' + this.formatBytes(fileStat.size) + ')')
        } else if (entry.isSymbolicLink()) {
          lines.push('[链接] ' + entryRelativePath)
        } else {
          lines.push('[其他] ' + entryRelativePath)
        }
      }
    }

    await visit(target)
    if (!lines.length) return '目录为空：' + this.displayPath(target)
    if (truncated) lines.push('结果已截断，仅显示前 ' + MAX_LIST_ENTRIES + ' 项。')
    return lines.join('\n')
  }

  async decryptFile(filePath: string, outputPath?: string, signal?: AbortSignal): Promise<string> {
    const source = await this.resolveExistingPath(filePath)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile()) throw new Error('待解密路径必须是文件。')
    if (!DECRYPT_EXTENSIONS.has(extname(source).toLowerCase())) throw new Error('解密服务支持 txt、csv、pdf、docx、xlsx、pptx 文件。')
    if (sourceStat.size <= 0) throw new Error('不能解密空文件。')
    if (sourceStat.size > MAX_DECRYPT_FILE_SIZE) throw new Error('待解密文件不能超过 ' + this.formatBytes(MAX_DECRYPT_FILE_SIZE) + '。')

    const target = this.resolvePath(outputPath?.trim() || this.defaultDecryptedPath(filePath))
    if (resolve(source) === resolve(target)) throw new Error('解密输出路径不能覆盖原文件。')
    await this.ensureSafeOutputPath(target)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DECRYPT_TIMEOUT_MS)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const formData = new FormData()
      formData.append('file', new Blob([await readFile(source)]), basename(source))
      const uploadResponse = await fetch(DECRYPT_UPLOAD_URL, { method: 'POST', body: formData, signal: controller.signal, redirect: 'error' })
      if (uploadResponse.url) this.validateUploadResponseUrl(uploadResponse.url)
      if (!uploadResponse.ok) throw new Error('文件上传失败（HTTP ' + uploadResponse.status + '）。')
      const uploadResult = await uploadResponse.json() as { downloadurl?: unknown }
      if (typeof uploadResult.downloadurl !== 'string') throw new Error('解密服务未返回下载地址。')
      const downloadUrl = this.validateDownloadUrl(uploadResult.downloadurl)

      const downloadResponse = await fetch(downloadUrl, { signal: controller.signal })
      if (!downloadResponse.ok) throw new Error('解密文件下载失败（HTTP ' + downloadResponse.status + '）。')
      const contentLength = Number(downloadResponse.headers.get('content-length') ?? 0)
      if (contentLength > MAX_DECRYPT_FILE_SIZE) throw new Error('解密结果超过 ' + this.formatBytes(MAX_DECRYPT_FILE_SIZE) + ' 限制。')
      const content = Buffer.from(await downloadResponse.arrayBuffer())
      if (!content.length) throw new Error('解密服务返回了空文件。')
      if (content.length > MAX_DECRYPT_FILE_SIZE) throw new Error('解密结果超过 ' + this.formatBytes(MAX_DECRYPT_FILE_SIZE) + ' 限制。')
      await writeFile(target, content)
      return JSON.stringify({ ok: true, output_path: this.displayPath(target), size_bytes: content.length })
    } catch (error) {
      if (signal?.aborted) throw new DOMException('文件解密已暂停', 'AbortError')
      if (error instanceof Error && error.name === 'AbortError') throw new Error('文件解密请求超时。')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async runCommand(command: string, args: string[] = [], signal?: AbortSignal, writeApproved = false): Promise<string> {
    const executable = this.normalizeExecutableName(command)
    if (!executable) throw new Error('命令不能为空。')
    const risk = classifyCommandRisk(executable, args)
    if (risk.level === 'blocked' || blockedCommands.test([executable, ...args].join(' '))) throw new Error('安全策略阻止了危险命令：' + risk.reason)
    if (risk.level === 'write' && !writeApproved) throw new Error('该命令可能修改状态，需要用户授权后执行。')
    const timeoutMs = this.commandTimeout(executable, args)

    if (process.platform === 'win32' && this.isWindowsBatchCommand(executable)) {
      return this.runWindowsBatchCommand(executable, args, signal, timeoutMs)
    }

    try {
      return await this.runExecutable(executable, args, signal, timeoutMs)
    } catch (error) {
      if (process.platform !== 'win32' || !this.isMissingExecutableError(error)) throw error
      const batchCommand = await this.findWindowsBatchCommand(executable, signal)
      if (!batchCommand) throw error
      return this.runWindowsBatchCommand(batchCommand, args, signal, timeoutMs)
    }
  }

  async startService(command: string, args: string[] = [], signal?: AbortSignal): Promise<string> {
    const executable = this.normalizeExecutableName(command)
    if (!executable) throw new Error('服务命令不能为空。')
    if (blockedCommands.test([executable, ...args].join(' '))) throw new Error('安全策略阻止了危险命令。')

    const invocation = await this.resolveServiceInvocation(executable, args, signal)
    const serviceKey = resolve(this.workspacePath) + '\n' + JSON.stringify(invocation)
    const existing = runningWorkspaceServices.get(serviceKey)
    if (existing?.child.exitCode === null && existing.url) return JSON.stringify({ ok: true, url: existing.url, reused: true })
    if (existing?.child.exitCode === null) existing.child.kill()

    const logPath = join(tmpdir(), 'codext-service-' + crypto.randomUUID() + '.log')
    const logFile = await open(logPath, 'a')
    let child: ChildProcess
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: this.workspacePath,
        windowsHide: true,
        detached: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', logFile.fd, logFile.fd]
      })
    } finally {
      await logFile.close()
    }
    child.unref()
    const service: RunningWorkspaceService = { child, logPath }
    runningWorkspaceServices.set(serviceKey, service)

    return new Promise((resolveService, rejectService) => {
      let settled = false
      let output = ''
      let pollTimer: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => settle(new Error('服务在 ' + SERVICE_START_TIMEOUT_MS / 1000 + ' 秒内没有输出可访问的 HTTP 地址。')), SERVICE_START_TIMEOUT_MS)
      const onAbort = (): void => settle(new DOMException('服务启动已暂停', 'AbortError'))
      const pollOutput = async (): Promise<void> => {
        if (settled) return
        try {
          output = this.decodeCommandOutput(await readFile(logPath)).slice(-16_000)
        } catch {
          /* 进程刚启动时日志文件可能尚未可读，继续轮询。 */
        }
        const url = this.findServiceUrl(output)
        if (url) {
          service.url = url
          settle(undefined, url)
          return
        }
        pollTimer = setTimeout(() => void pollOutput(), 100)
      }
      const settle = (error?: Error, url?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (pollTimer) clearTimeout(pollTimer)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          child.kill()
          runningWorkspaceServices.delete(serviceKey)
          void rm(logPath, { force: true })
          rejectService(error)
          return
        }
        resolveService(JSON.stringify({ ok: true, url, pid: child.pid }))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      child.once('error', (error) => settle(error))
      child.once('exit', (code) => {
        runningWorkspaceServices.delete(serviceKey)
        void rm(logPath, { force: true })
        if (!settled) settle(new Error('服务进程提前退出' + (code === null ? '' : '（退出码 ' + code + '）') + '。' + (output ? '\n' + output.trim() : '')))
      })
      void pollOutput()
    })
  }

  private async runExecutable(command: string, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    try {
      const result = await execFileAsync(command, args, this.commandOptions(signal, timeoutMs)) as unknown as { stdout: Buffer; stderr: Buffer }
      return (this.decodeCommandOutput(result.stdout) || this.decodeCommandOutput(result.stderr) || '命令执行完成。').trim()
    } catch (error) {
      if (this.isMissingExecutableError(error)) throw error
      const details = this.commandErrorDetails(error)
      if (this.isCommandTimeoutError(error)) {
        throw new Error('命令执行超过 ' + Math.ceil(timeoutMs / 1000) + ' 秒，已停止。' + (details ? '\n' + details : ''))
      }
      const exitCode = this.commandExitCode(error)
      throw new Error('命令执行失败' + (exitCode ? '（退出码 ' + exitCode + '）' : '') + '。' + (details ? '\n' + details : ''))
    }
  }

  private async runWindowsBatchCommand(command: string, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    this.assertSafeWindowsBatchArguments(command, args)
    const commandProcessor = process.env.ComSpec?.trim() || 'cmd.exe'
    return this.runExecutable(commandProcessor, ['/d', '/s', '/c', command, ...args], signal, timeoutMs)
  }

  private async findWindowsBatchCommand(command: string, signal?: AbortSignal): Promise<string | undefined> {
    if (extname(command)) return undefined
    for (const extension of WINDOWS_BATCH_EXTENSIONS) {
      try {
        const result = await execFileAsync('where.exe', [command + extension], {
          ...this.commandOptions(signal),
          timeout: 5000
        }) as unknown as { stdout: Buffer }
        const match = this.decodeCommandOutput(result.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean)
        if (match) return match
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return undefined
  }

  private async resolveServiceInvocation(command: string, args: string[], signal?: AbortSignal): Promise<{ command: string; args: string[] }> {
    if (process.platform !== 'win32') return { command, args }
    const batchCommand = this.isWindowsBatchCommand(command) ? command : await this.findWindowsBatchCommand(command, signal)
    if (!batchCommand) return { command, args }
    this.assertSafeWindowsBatchArguments(batchCommand, args)
    return { command: process.env.ComSpec?.trim() || 'cmd.exe', args: ['/d', '/s', '/c', batchCommand, ...args] }
  }

  private commandOptions(signal?: AbortSignal, timeout = COMMAND_TIMEOUT_MS) {
    return { cwd: this.workspacePath, timeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer' as const, signal }
  }

  private isWindowsBatchCommand(command: string): boolean {
    return WINDOWS_BATCH_EXTENSIONS.has(extname(command).toLowerCase())
  }

  private normalizeExecutableName(command: string): string {
    return command.trim().replace(/[。．](?=(?:cmd|bat|exe)$)/i, '.')
  }

  private commandTimeout(command: string, args: string[]): number {
    const executableName = basename(command).toLowerCase().replace(/\.(?:cmd|bat|exe)$/, '')
    const operation = args[0]?.toLowerCase()
    const packageManagers = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'corepack'])
    const longOperations = new Set(['install', 'i', 'ci', 'add', 'create', 'exec', 'dlx'])
    return packageManagers.has(executableName) && operation && longOperations.has(operation) ? PACKAGE_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS
  }

  private isCommandTimeoutError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false
    const details = error as { code?: unknown; killed?: unknown }
    return details.code === 'ETIMEDOUT' || details.killed === true
  }

  private commandErrorDetails(error: unknown): string {
    if (typeof error !== 'object' || error === null) return ''
    const details = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const output = [details.stdout, details.stderr]
      .map((value) => Buffer.isBuffer(value) ? this.decodeCommandOutput(value) : typeof value === 'string' ? value : '')
      .filter(Boolean)
      .join('\n') || (typeof details.message === 'string' ? details.message : '')
    return output.length > 8000 ? output.slice(0, 5000) + '\n...输出已截断...\n' + output.slice(-2000) : output.trim()
  }

  private commandExitCode(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('code' in error)) return ''
    const code = error.code
    return typeof code === 'string' || typeof code === 'number' ? String(code) : ''
  }

  private findServiceUrl(output: string): string | undefined {
    const ansiEscapePattern = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g')
    const match = output.replace(ansiEscapePattern, '').match(/https?:\/\/[^\s<>"'`]+/i)?.[0]
    if (!match) return undefined
    try {
      const url = new URL(match.replace(/[),.;\]，。；]+$/, ''))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
      if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') url.hostname = 'localhost'
      return url.toString()
    } catch {
      return undefined
    }
  }

  private isMissingExecutableError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
  }

  private assertSafeWindowsBatchArguments(command: string, args: string[]): void {
    if ([command, ...args].some((value) => WINDOWS_BATCH_META_CHARACTERS.test(value))) {
      throw new Error('Windows 脚本命令包含不安全的 shell 字符。')
    }
  }

  private resolvePath(filePath: string): string {
    const target = resolve(this.workspacePath, filePath)
    this.assertWorkspacePath(target)
    return target
  }

  private async resolveExistingPath(filePath: string): Promise<string> {
    const target = this.resolvePath(filePath)
    const actualPath = await realpath(target)
    this.assertWorkspacePath(actualPath)
    return actualPath
  }

  private assertWorkspacePath(target: string): void {
    const pathRelative = relative(resolve(this.workspacePath), target)
    if (pathRelative === '..' || pathRelative.startsWith('..\\') || pathRelative.startsWith('../') || isAbsolute(pathRelative)) throw new Error('文件操作仅允许在当前工作区内进行。')
  }

  private async ensureSafeOutputPath(target: string): Promise<void> {
    await this.ensureSafeDirectoryPath(dirname(target))
    const actualParent = await realpath(dirname(target))
    this.assertWorkspacePath(actualParent)
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error('解密输出路径不能是符号链接。')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }

  private async ensureSafeDirectoryPath(target: string): Promise<void> {
    this.assertWorkspacePath(target)
    const workspaceRoot = resolve(this.workspacePath)
    const pathRelative = relative(workspaceRoot, target)
    const segments = pathRelative ? pathRelative.split(/[\\/]+/) : []
    let currentPath = workspaceRoot
    for (const segment of segments) {
      currentPath = join(currentPath, segment)
      try {
        const currentStat = await lstat(currentPath)
        if (currentStat.isSymbolicLink()) throw new Error('目录路径不能经过符号链接。')
        if (!currentStat.isDirectory()) throw new Error('目录路径中包含同名文件：' + this.displayPath(currentPath))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          await mkdir(currentPath)
          continue
        }
        throw error
      }
    }
  }

  private validateDownloadUrl(value: string): string {
    const url = new URL(value, DECRYPT_SERVICE_ORIGIN)
    if (url.origin !== DECRYPT_SERVICE_ORIGIN || !url.pathname.startsWith(DECRYPT_DOWNLOAD_PATH)) throw new Error('解密服务返回了不安全的下载地址。')
    return url.toString()
  }

  private validateUploadResponseUrl(value: string): void {
    const url = new URL(value)
    if (url.origin !== DECRYPT_SERVICE_ORIGIN || url.pathname !== '/encrypt/file/tranferEncryptFileUrl') throw new Error('解密服务发生了不安全的上传重定向。')
  }

  private defaultDecryptedPath(filePath: string): string {
    const parsed = parse(filePath)
    return join(parsed.dir, parsed.name + '.decrypted' + parsed.ext)
  }

  private displayPath(target: string): string {
    return relative(resolve(this.workspacePath), target) || '.'
  }

  private formatBytes(size: number): string {
    if (size < 1024) return size + ' B'
    if (size < 1024 * 1024) return Math.ceil(size / 1024) + ' KB'
    return (size / (1024 * 1024)).toFixed(1) + ' MB'
  }

  private decodeCommandOutput(output: Buffer): string {
    if (!output.length) return ''
    const encoding = process.platform === 'win32' ? 'gbk' : 'utf-8'
    return new TextDecoder(encoding).decode(output)
  }
}
