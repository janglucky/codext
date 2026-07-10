import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const blockedCommands = /(^|\s)(del|erase|rmdir|rd|format|shutdown|restart|diskpart)(\s|$)|reg\s+delete/i

export class WorkspaceTools {
  constructor(private readonly workspacePath: string) {}
  async readFile(filePath: string): Promise<string> { return readFile(this.resolvePath(filePath), 'utf8') }
  async writeFile(filePath: string, content: string): Promise<string> { const target = this.resolvePath(filePath); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content, 'utf8'); return '已写入 ' + relative(this.workspacePath, target) }
  async runCommand(command: string, args: string[] = []): Promise<string> {
    if (blockedCommands.test([command, ...args].join(' '))) throw new Error('安全策略阻止了危险命令。')
    const result = await execFileAsync(command, args, { cwd: this.workspacePath, timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer' }) as unknown as { stdout: Buffer; stderr: Buffer }
    return (this.decodeCommandOutput(result.stdout) || this.decodeCommandOutput(result.stderr) || '命令执行完成。').trim()
  }
  private resolvePath(filePath: string): string { const target = resolve(this.workspacePath, filePath); const pathRelative = relative(this.workspacePath, target); if (pathRelative.startsWith('..') || pathRelative.includes(':')) throw new Error('文件操作仅允许在当前工作区内进行。'); return target }
  private decodeCommandOutput(output: Buffer): string {
    if (!output.length) return ''
    const encoding = process.platform === 'win32' ? 'gbk' : 'utf-8'
    return new TextDecoder(encoding).decode(output)
  }
}


