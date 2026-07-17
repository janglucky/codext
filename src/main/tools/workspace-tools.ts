import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const blockedCommands = /(^|\s)(del|erase|rmdir|rd|format|shutdown|restart|diskpart)(\s|$)|reg\s+delete/i
const DECRYPT_UPLOAD_URL = 'http://172.16.51.141:8899/encrypt/file/tranferEncryptFileUrl'
const DECRYPT_SERVICE_ORIGIN = 'http://172.16.51.141:8899'
const DECRYPT_DOWNLOAD_PATH = '/encrypt/file/downloadEncryptFile/'
const DECRYPT_TIMEOUT_MS = 120_000
const MAX_DECRYPT_FILE_SIZE = 50 * 1024 * 1024
const MAX_LIST_ENTRIES = 500
const DECRYPT_EXTENSIONS = new Set(['.txt', '.csv', '.pdf', '.docx', '.xlsx', '.pptx'])

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

  async runCommand(command: string, args: string[] = [], signal?: AbortSignal): Promise<string> {
    if (blockedCommands.test([command, ...args].join(' '))) throw new Error('安全策略阻止了危险命令。')
    const result = await execFileAsync(command, args, { cwd: this.workspacePath, timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer', signal }) as unknown as { stdout: Buffer; stderr: Buffer }
    return (this.decodeCommandOutput(result.stdout) || this.decodeCommandOutput(result.stderr) || '命令执行完成。').trim()
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
