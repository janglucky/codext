import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
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
const BACKGROUND_START_GRACE_MS = 2000
const EDIT_DIFF_TIMEOUT_MS = 10_000
const MAX_EDIT_DIFF_CHARACTERS = 20_000

interface RunningWorkspaceService { child: ChildProcess; url?: string; logPath: string }
export type CommandOutputListener = (chunk: string, source: 'stdout' | 'stderr') => void
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
  constructor(private readonly workspacePath: string, private readonly options: { allowExternalPaths?: boolean } = {}) {}

  async isExternalPath(filePath: string): Promise<boolean> {
    const target = resolve(this.workspacePath, filePath)
    if (this.isOutsideWorkspace(target)) return true
    try {
      return this.isOutsideWorkspace(await realpath(target))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      let parent = dirname(target)
      while (parent !== dirname(parent)) {
        try {
          return this.isOutsideWorkspace(await realpath(parent))
        } catch (parentError) {
          if (!(parentError instanceof Error && 'code' in parentError && parentError.code === 'ENOENT')) throw parentError
          parent = dirname(parent)
        }
      }
      return false
    }
  }

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
    let previousContent = ''
    let created = false
    try {
      previousContent = await readFile(target, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') created = true
      else throw error
    }
    await writeFile(target, content, 'utf8')
    const path = this.displayPath(target)
    const diff = await this.createEditDiff(path, previousContent, content)
    return JSON.stringify({ ok: true, path, created, ...(diff ? { diff } : {}) })
  }

  async editFile(filePath: string, oldText: string, newText: string, replaceAll = false): Promise<string> {
    if (!oldText.length) throw new Error('old_text 不能为空。')
    const target = await this.resolveExistingPath(filePath)
    if (!(await stat(target)).isFile()) throw new Error('编辑路径必须是文件。')
    const content = await readFile(target, 'utf8')
    const matches = this.countOccurrences(content, oldText)
    if (!matches) throw new Error('未在文件中找到与 old_text 完全一致的内容。')
    if (matches > 1 && !replaceAll) throw new Error('old_text 在文件中匹配 ' + matches + ' 处；请提供更唯一的上下文，或明确设置 replace_all 为 true。')
    const replacements = replaceAll ? matches : 1
    const updated = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText)
    await writeFile(target, updated, 'utf8')
    const path = this.displayPath(target)
    const diff = await this.createEditDiff(path, content, updated)
    return JSON.stringify({ ok: true, path, replacements, ...(diff ? { diff } : {}) })
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

  async runCommand(command: string, args: string[] = [], signal?: AbortSignal, writeApproved = false, dangerousApproved = false, background = false, onOutput?: CommandOutputListener): Promise<string> {
    const executable = this.normalizeExecutableName(command)
    if (!executable) throw new Error('命令不能为空。')
    const risk = classifyCommandRisk(executable, args)
    if ((risk.level === 'blocked' || blockedCommands.test([executable, ...args].join(' '))) && !dangerousApproved) throw new Error('高风险命令需要用户明确确认：' + risk.reason)
    if (risk.level === 'write' && !writeApproved) throw new Error('该命令可能修改状态，需要用户授权后执行。')
    if (background) return this.runBackgroundCommand(executable, args, signal, onOutput)
    const timeoutMs = this.commandTimeout(executable, args)
    const executionArgs = this.withLiveProgress(executable, args, Boolean(onOutput))

    if (process.platform === 'win32' && this.isWindowsBatchCommand(executable)) {
      return this.runWindowsBatchCommand(executable, executionArgs, signal, timeoutMs, onOutput)
    }

    try {
      return await this.runExecutable(executable, executionArgs, signal, timeoutMs, onOutput)
    } catch (error) {
      if (process.platform !== 'win32' || !this.isMissingExecutableError(error)) throw error
      const batchCommand = await this.findWindowsBatchCommand(executable, signal)
      if (!batchCommand) throw error
      return this.runWindowsBatchCommand(batchCommand, executionArgs, signal, timeoutMs, onOutput)
    }
  }

  async startService(command: string, args: string[] = [], signal?: AbortSignal, dangerousApproved = false, onOutput?: CommandOutputListener): Promise<string> {
    const executable = this.normalizeExecutableName(command)
    if (!executable) throw new Error('服务命令不能为空。')
    if (blockedCommands.test([executable, ...args].join(' ')) && !dangerousApproved) throw new Error('高风险命令需要用户明确确认。')

    const invocation = await this.resolveServiceInvocation(executable, args, signal)
    const serviceKey = resolve(this.workspacePath) + '\n' + JSON.stringify(invocation)
    const existing = runningWorkspaceServices.get(serviceKey)
    if (existing?.child.exitCode === null && existing.url) return JSON.stringify({ ok: true, url: existing.url, reused: true })
    if (existing?.child.exitCode === null) existing.child.kill()

    const logPath = join(tmpdir(), 'codext-service-' + crypto.randomUUID() + '.log')
    const logFile = await open(logPath, 'a')
    let child: ChildProcess
    let earlySpawnError: Error | undefined
    const captureEarlySpawnError = (error: Error): void => { earlySpawnError = error }
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: this.workspacePath,
        windowsHide: true,
        detached: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', logFile.fd, logFile.fd]
      })
      // Attach before the first await. ENOENT can otherwise emit while the
      // log file is closing and surface as an uncaught main-process error.
      child.once('error', captureEarlySpawnError)
    } finally {
      await logFile.close()
    }
    child.unref()
    const service: RunningWorkspaceService = { child, logPath }
    runningWorkspaceServices.set(serviceKey, service)

    return new Promise((resolveService, rejectService) => {
      let settled = false
      let output = ''
      let publishedOutput = ''
      let pollTimer: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => settle(new Error('服务在 ' + SERVICE_START_TIMEOUT_MS / 1000 + ' 秒内没有输出可访问的 HTTP 地址。')), SERVICE_START_TIMEOUT_MS)
      const onAbort = (): void => settle(new DOMException('服务启动已暂停', 'AbortError'))
      const publishOutput = (): void => {
        if (output === publishedOutput) return
        const delta = output.startsWith(publishedOutput) ? output.slice(publishedOutput.length) : output
        if (delta) onOutput?.(delta, 'stdout')
        publishedOutput = output
      }
      const pollOutput = async (): Promise<void> => {
        if (settled) return
        try {
          output = this.decodeCommandOutput(await readFile(logPath)).slice(-16_000)
          publishOutput()
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
      child.removeListener('error', captureEarlySpawnError)
      child.once('error', (error) => settle(error))
      child.once('exit', (code) => {
        void (async () => {
          runningWorkspaceServices.delete(serviceKey)
          if (settled) {
            await rm(logPath, { force: true })
            return
          }
          try {
            output = this.decodeCommandOutput(await readFile(logPath)).slice(-16_000)
          } catch {
            /* 日志文件可能未创建，保留已有输出。 */
          }
          publishOutput()
          settle(new Error('服务进程提前退出' + (code === null ? '' : '（退出码 ' + code + '）') + '。' + (output ? '\n' + output.trim() : '')))
        })()
      })
      if (earlySpawnError) settle(earlySpawnError)
      else void pollOutput()
    })
  }

  private runExecutable(command: string, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS, onOutput?: CommandOutputListener): Promise<string> {
    return new Promise((resolveCommand, rejectCommand) => {
      if (signal?.aborted) {
        rejectCommand(new DOMException('命令执行已暂停', 'AbortError'))
        return
      }
      let timedOut = false
      let outputExceeded = false
      let settled = false
      let spawnError: Error | undefined
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let outputBytes = 0
      const maxOutputBytes = 1024 * 1024
      const child = spawn(command, args, {
        cwd: this.workspacePath,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        signal?.removeEventListener('abort', onAbort)
        const stdoutText = this.decodeCommandValue(Buffer.concat(stdoutChunks))
        const stderrText = this.decodeCommandValue(Buffer.concat(stderrChunks))
        if (signal?.aborted) {
          rejectCommand(new DOMException('命令执行已暂停', 'AbortError'))
          return
        }
        if (!spawnError && !timedOut && !outputExceeded && code === 0) {
          const output = [stdoutText, stderrText].filter(Boolean).join(stdoutText && stderrText ? '\n' : '')
          resolveCommand((output || '命令执行完成。').trim())
          return
        }
        if (spawnError && this.isMissingExecutableError(spawnError)) {
          rejectCommand(spawnError)
          return
        }
        const rawDetails = [stdoutText, stderrText].filter(Boolean).join('\n').trim()
        const details = rawDetails.length > 32_000
          ? rawDetails.slice(0, 24_000) + '\n...输出已截断...\n' + rawDetails.slice(-8_000)
          : rawDetails
        if (timedOut) {
          rejectCommand(new Error('命令执行超过 ' + Math.ceil(timeoutMs / 1000) + ' 秒，已停止。' + (details ? '\n' + details : '')))
          return
        }
        if (outputExceeded) {
          rejectCommand(new Error('命令输出超过 1 MB，已停止。' + (details ? '\n' + details : '')))
          return
        }
        const exitCode = code === null ? '' : String(code)
        rejectCommand(new Error('命令执行失败' + (exitCode ? '（退出码 ' + exitCode + '）' : '') + '。' + (details ? '\n' + details : spawnError ? '\n' + spawnError.message : '')))
      }
      const onAbort = (): void => this.terminateCommandTree(child, true)
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        this.terminateCommandTree(child, true)
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      child.once('error', (error) => {
        spawnError = error
        finish(null)
      })
      child.once('exit', () => {
        // Foreground commands must not leave descendants holding stdout/stderr
        // pipes open after the root process exits. Long-lived processes use
        // background=true or start_service instead.
        this.terminateCommandTree(child, false)
      })
      child.once('close', (code) => finish(code))
      const captureOutput = (chunk: Buffer | string, source: 'stdout' | 'stderr'): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        outputBytes += buffer.length
        const target = source === 'stdout' ? stdoutChunks : stderrChunks
        target.push(buffer)
        if (outputBytes > maxOutputBytes && !outputExceeded) {
          outputExceeded = true
          this.terminateCommandTree(child, true)
        }
        const text = this.decodeCommandValue(buffer)
        if (text) onOutput?.(text, source)
      }
      child.stdout?.on('data', (chunk: Buffer | string) => {
        captureOutput(chunk, 'stdout')
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        captureOutput(chunk, 'stderr')
      })
    })
  }

  private terminateCommandTree(child: ChildProcess, force: boolean): void {
    const pid = child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      })
      killer.on('error', () => undefined)
      killer.unref()
      return
    }
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) child.kill(force ? 'SIGKILL' : 'SIGTERM')
    }
  }

  private async runBackgroundCommand(command: string, args: string[], signal?: AbortSignal, onOutput?: CommandOutputListener): Promise<string> {
    if (signal?.aborted) throw new DOMException('后台命令已暂停', 'AbortError')
    const invocation = await this.resolveServiceInvocation(command, args, signal)
    const logPath = join(tmpdir(), 'codext-background-' + crypto.randomUUID() + '.log')
    const logFile = await open(logPath, 'a')
    let child: ChildProcess
    let earlySpawnError: Error | undefined
    let spawnedEarly = false
    const captureEarlySpawnError = (error: Error): void => { earlySpawnError = error }
    const captureEarlySpawn = (): void => { spawnedEarly = true }
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: this.workspacePath,
        windowsHide: false,
        detached: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', logFile.fd, logFile.fd]
      })
      child.once('error', captureEarlySpawnError)
      child.once('spawn', captureEarlySpawn)
    } finally {
      await logFile.close()
    }
    return new Promise((resolveBackground, rejectBackground) => {
      let settled = false
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      let outputPollTimer: ReturnType<typeof setTimeout> | undefined
      let publishedOutput = ''
      const publishOutput = async (): Promise<void> => {
        if (settled) return
        try {
          const output = this.decodeCommandOutput(await readFile(logPath))
          if (output !== publishedOutput) {
            const delta = output.startsWith(publishedOutput) ? output.slice(publishedOutput.length) : output
            if (delta) onOutput?.(delta, 'stdout')
            publishedOutput = output
          }
        } catch {
          /* 进程刚启动时日志可能尚未可读。 */
        }
        if (!settled) outputPollTimer = setTimeout(() => void publishOutput(), 80)
      }
      const cleanup = (): void => {
        if (graceTimer) clearTimeout(graceTimer)
        if (outputPollTimer) clearTimeout(outputPollTimer)
        signal?.removeEventListener('abort', onAbort)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
      }
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) {
          void readFile(logPath).then((output) => {
            const details = this.decodeCommandOutput(output).trim()
            return rm(logPath, { force: true }).then(() => rejectBackground(new Error(error.message + (details ? '\n' + details : ''))))
          }).catch(() => rejectBackground(error))
          return
        }
        child.once('error', () => undefined)
        child.unref()
        child.once('exit', () => { void rm(logPath, { force: true }) })
        resolveBackground(JSON.stringify({ ok: true, background: true, verified: true, pid: child.pid }))
      }
      const onAbort = (): void => {
        child.kill()
        settle(new DOMException('后台命令已暂停', 'AbortError'))
      }
      const onError = (error: Error): void => settle(error)
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        const detail = code === null ? '信号 ' + (exitSignal ?? '未知') : '退出码 ' + code
        settle(new Error('后台进程在启动确认前退出（' + detail + '）。'))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      child.removeListener('error', captureEarlySpawnError)
      child.removeListener('spawn', captureEarlySpawn)
      child.once('error', onError)
      child.once('exit', onExit)
      child.once('spawn', () => {
        graceTimer = setTimeout(() => settle(), BACKGROUND_START_GRACE_MS)
      })
      if (earlySpawnError) settle(earlySpawnError)
      else {
        void publishOutput()
        if (spawnedEarly) graceTimer = setTimeout(() => settle(), BACKGROUND_START_GRACE_MS)
      }
    })
  }

  private async runWindowsBatchCommand(command: string, args: string[], signal?: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS, onOutput?: CommandOutputListener): Promise<string> {
    this.assertSafeWindowsBatchArguments(command, args)
    const commandProcessor = process.env.ComSpec?.trim() || 'cmd.exe'
    return this.runExecutable(commandProcessor, ['/d', '/s', '/c', command, ...args], signal, timeoutMs, onOutput)
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
    const executableName = basename(command).toLowerCase().replace(/\.(?:cmd|bat|exe)$/, '')
    if (process.platform !== 'win32' && /^(?:npx|pnpx)$/.test(executableName) && args[0]?.toLowerCase() === 'electron') {
      const localElectron = join(this.workspacePath, 'node_modules', 'electron', 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
      try {
        const localStat = await stat(localElectron)
        if (localStat.isFile()) return { command: localElectron, args: args.slice(1) }
      } catch {
        /* Fall back to the package runner so its error can be reported. */
      }
    }
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

  private withLiveProgress(command: string, args: string[], enabled: boolean): string[] {
    if (!enabled || basename(command).toLowerCase().replace(/\.(?:cmd|bat|exe)$/, '') !== 'git') return args
    const operation = args[0]?.toLowerCase()
    if (!operation || !['clone', 'fetch', 'pull'].includes(operation) || args.includes('--progress') || args.includes('--no-progress')) return args
    return [args[0], '--progress', ...args.slice(1)]
  }

  private commandTimeout(command: string, args: string[]): number {
    const executableName = basename(command).toLowerCase().replace(/\.(?:cmd|bat|exe)$/, '')
    const operation = args[0]?.toLowerCase()
    const packageManagers = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'corepack'])
    const longOperations = new Set(['install', 'i', 'ci', 'add', 'create', 'exec', 'dlx'])
    return packageManagers.has(executableName) && operation && longOperations.has(operation) ? PACKAGE_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS
  }

  private commandExitCode(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('code' in error)) return ''
    const code = error.code
    return typeof code === 'string' || typeof code === 'number' ? String(code) : ''
  }

  private findServiceUrl(output: string): string | undefined {
    const ansiEscapePattern = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g')
    const matches = output.replace(ansiEscapePattern, '').match(/https?:\/\/[^\s<>"'`]+/gi) ?? []
    for (const match of matches) {
      try {
        const url = new URL(match.replace(/[),.;\]，。；]+$/, ''))
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !this.isLocalServiceHost(url.hostname)) continue
        if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') url.hostname = 'localhost'
        return url.toString()
      } catch {
        /* 继续检查日志中的其他 URL。 */
      }
    }
    return undefined
  }

  private isLocalServiceHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || host.endsWith('.local')) return true
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
    const private172 = /^172\.(\d{1,2})\./.exec(host)
    return private172 ? Number(private172[1]) >= 16 && Number(private172[1]) <= 31 : false
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

  private countOccurrences(content: string, search: string): number {
    let count = 0
    let offset = 0
    while ((offset = content.indexOf(search, offset)) >= 0) {
      count++
      offset += search.length
    }
    return count
  }

  private async createEditDiff(filePath: string, before: string, after: string): Promise<string | undefined> {
    const tempRoot = await mkdtemp(join(tmpdir(), 'codext-edit-diff-'))
    const normalizedPath = filePath.replaceAll('\\', '/')
    const beforePath = join(tempRoot, 'before', normalizedPath)
    const afterPath = join(tempRoot, 'after', normalizedPath)
    try {
      await Promise.all([
        mkdir(dirname(beforePath), { recursive: true }),
        mkdir(dirname(afterPath), { recursive: true })
      ])
      await Promise.all([
        writeFile(beforePath, before, 'utf8'),
        writeFile(afterPath, after, 'utf8')
      ])

      let output = ''
      try {
        const result = await execFileAsync('git', [
          'diff', '--no-index', '--no-color', '--no-ext-diff', '--text', '--unified=3', '--',
          relative(tempRoot, beforePath), relative(tempRoot, afterPath)
        ], {
          cwd: tempRoot,
          timeout: EDIT_DIFF_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          encoding: 'buffer'
        }) as unknown as { stdout: Buffer }
        output = this.decodeCommandOutput(result.stdout)
      } catch (error) {
        // git diff --no-index returns 1 when it successfully finds changes.
        if (this.commandExitCode(error) !== '1') return undefined
        const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? error.stdout : undefined
        output = Buffer.isBuffer(stdout) ? this.decodeCommandOutput(stdout) : typeof stdout === 'string' ? stdout : ''
      }

      const normalized = output
        .replaceAll('a/before/', 'a/')
        .replaceAll('b/after/', 'b/')
        .trim()
      if (!normalized) return undefined
      if (normalized.length <= MAX_EDIT_DIFF_CHARACTERS) return normalized
      return normalized.slice(0, 16_000) + '\n...差异内容过长，已截断...\n' + normalized.slice(-4_000)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }

  private assertWorkspacePath(target: string): void {
    if (this.options.allowExternalPaths) return
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
    if (this.options.allowExternalPaths && this.isOutsideWorkspace(target)) {
      await mkdir(target, { recursive: true })
      return
    }
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
          // Multiple independent write_file calls may create the same parent
          // directory concurrently. Recursive mkdir is idempotent for an
          // already-created directory and avoids a false EEXIST failure.
          await mkdir(currentPath, { recursive: true })
          continue
        }
        throw error
      }
    }
  }

  private isOutsideWorkspace(target: string): boolean {
    const pathRelative = relative(resolve(this.workspacePath), resolve(target))
    return pathRelative === '..' || pathRelative.startsWith('..\\') || pathRelative.startsWith('../') || isAbsolute(pathRelative)
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
    return this.isOutsideWorkspace(target) ? resolve(target) : relative(resolve(this.workspacePath), target) || '.'
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

  private decodeCommandValue(output: Buffer | string): string {
    return typeof output === 'string' ? output : this.decodeCommandOutput(output)
  }
}
