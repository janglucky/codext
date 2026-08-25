import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopAllWorkspaceServices, WorkspaceTools } from '../src/main/tools/workspace-tools'
import { getEnabledToolDefinitions, isToolName } from '../src/main/tools/tool-registry'

const originalFetch = globalThis.fetch
let workspacePath = ''
let workspaceTools: WorkspaceTools

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'codext-workspace-tools-'))
  workspaceTools = new WorkspaceTools(workspacePath)
})

afterEach(async () => {
  await stopAllWorkspaceServices()
  globalThis.fetch = originalFetch
  await rm(workspacePath, { recursive: true, force: true })
})

describe('WorkspaceTools directories and listing', () => {
  it('creates nested directories and lists files recursively', async () => {
    await workspaceTools.createDirectory('reports/2026')
    await writeFile(join(workspacePath, 'reports', '2026', 'summary.txt'), 'summary', 'utf8')

    const flatListing = normalizePath(await workspaceTools.listFiles('reports'))
    const recursiveListing = normalizePath(await workspaceTools.listFiles('reports', true))

    expect(flatListing).toContain('[目录] reports/2026/')
    expect(flatListing).not.toContain('summary.txt')
    expect(recursiveListing).toContain('[文件] reports/2026/summary.txt')
  })

  it('rejects paths outside the workspace', async () => {
    await expect(workspaceTools.createDirectory('../outside')).rejects.toThrow('工作区')
    await expect(workspaceTools.listFiles('../outside')).rejects.toThrow('工作区')
  })

  it('saves binary attachments inside the workspace', async () => {
    const savedPath = await workspaceTools.saveBinaryFile('.codext-attachments/upload/report.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

    expect(normalizePath(savedPath)).toBe('.codext-attachments/upload/report.docx')
    expect(await readFile(join(workspacePath, savedPath))).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    await expect(workspaceTools.saveBinaryFile('../outside.docx', new Uint8Array([1]))).rejects.toThrow('工作区')
  })
})

describe('tool registry', () => {
  it('registers workspace and service tools', () => {
    const names = ['edit_file', 'create_directory', 'list_files', 'decrypt_file', 'start_service', 'search_knowledge_base']
    expect(names.every(isToolName)).toBe(true)
    expect(getEnabledToolDefinitions(names).map((tool) => tool.name)).toEqual(names)
  })
})

describe('WorkspaceTools.writeFile', () => {
  it('returns a full added-lines diff for a new file', async () => {
    const result = JSON.parse(await workspaceTools.writeFile('new.ts', 'const first = 1\nconst second = 2\n')) as { path: string; created: boolean; diff?: string }

    expect(normalizePath(result.path)).toBe('new.ts')
    expect(result.created).toBe(true)
    expect(result.diff).toContain('diff --git a/new.ts b/new.ts')
    expect(result.diff).toContain('+const first = 1')
    expect(result.diff).toContain('+const second = 2')
  })

  it('returns the actual diff when overwriting an existing file', async () => {
    await writeFile(join(workspacePath, 'existing.ts'), 'const port = 3000\n', 'utf8')

    const result = JSON.parse(await workspaceTools.writeFile('existing.ts', 'const port = 5173\n')) as { created: boolean; diff?: string }

    expect(result.created).toBe(false)
    expect(result.diff).toContain('-const port = 3000')
    expect(result.diff).toContain('+const port = 5173')
  })
})

describe('WorkspaceTools.editFile', () => {
  it('replaces one exact occurrence in an existing file', async () => {
    await writeFile(join(workspacePath, 'app.ts'), 'const port = 3000\nstart(port)\n', 'utf8')

    const result = JSON.parse(await workspaceTools.editFile('app.ts', 'const port = 3000', 'const port = 5173')) as { path: string; replacements: number; diff?: string }

    expect(normalizePath(result.path)).toBe('app.ts')
    expect(result.replacements).toBe(1)
    expect(result.diff).toContain('diff --git a/app.ts b/app.ts')
    expect(result.diff).toContain('-const port = 3000')
    expect(result.diff).toContain('+const port = 5173')
    expect(await readFile(join(workspacePath, 'app.ts'), 'utf8')).toBe('const port = 5173\nstart(port)\n')
  })

  it('rejects ambiguous matches unless replace_all is explicitly enabled', async () => {
    const target = join(workspacePath, 'repeated.txt')
    await writeFile(target, 'before before before', 'utf8')

    await expect(workspaceTools.editFile('repeated.txt', 'before', 'after')).rejects.toThrow('匹配 3 处')
    expect(await readFile(target, 'utf8')).toBe('before before before')

    const result = JSON.parse(await workspaceTools.editFile('repeated.txt', 'before', 'after', true)) as { replacements: number }
    expect(result.replacements).toBe(3)
    expect(await readFile(target, 'utf8')).toBe('after after after')
  })

  it('supports deletion and rejects missing text, files and unsafe paths', async () => {
    await writeFile(join(workspacePath, 'notes.txt'), 'keep\nremove me\n', 'utf8')

    await expect(workspaceTools.editFile('notes.txt', '', 'value')).rejects.toThrow('不能为空')
    await expect(workspaceTools.editFile('notes.txt', 'not present', 'value')).rejects.toThrow('未在文件中找到')
    await expect(workspaceTools.editFile('missing.txt', 'old', 'new')).rejects.toThrow()
    await expect(workspaceTools.editFile('../outside.txt', 'old', 'new')).rejects.toThrow('工作区')

    await workspaceTools.editFile('notes.txt', 'remove me\n', '')
    expect(await readFile(join(workspacePath, 'notes.txt'), 'utf8')).toBe('keep\n')
  })
})

describe('WorkspaceTools.startService', () => {
  it('reports a missing executable without an uncaught child-process error', async () => {
    await expect(workspaceTools.startService('codext-command-that-does-not-exist-' + Date.now()))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the service URL while leaving the server available', async () => {
    const script = "const http=require('node:http');const server=http.createServer((_request,response)=>response.end('ready'));server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port))"

    const result = JSON.parse(await workspaceTools.startService(process.execPath, ['-e', script])) as { url: string; pid: number }

    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(result.pid).toBeGreaterThan(0)
    await expect(fetch(result.url).then((response) => response.text())).resolves.toBe('ready')
  })

  it('includes the final service log when the process exits early', async () => {
    const script = "process.stderr.write('startup diagnostic\\n');process.exit(3)"

    await expect(workspaceTools.startService(process.execPath, ['-e', script]))
      .rejects.toThrow('startup diagnostic')
  })

  it('ignores documentation links and waits for a local service URL', async () => {
    const script = "const http=require('node:http');console.log('See https://rollupjs.org/configuration-options/#output-manualchunks');setTimeout(()=>{const server=http.createServer((_request,response)=>response.end('ready'));server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port))},100)"

    const result = JSON.parse(await workspaceTools.startService(process.execPath, ['-e', script])) as { url: string }

    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })
})

describe('WorkspaceTools.runCommand', () => {
  it('forces progress output for streamed git transfers', () => {
    const tools = workspaceTools as unknown as { withLiveProgress(command: string, args: string[], enabled: boolean): string[] }

    expect(tools.withLiveProgress('git', ['clone', '--depth', '1', 'https://example.com/repo.git'], true))
      .toEqual(['clone', '--progress', '--depth', '1', 'https://example.com/repo.git'])
    expect(tools.withLiveProgress('git', ['clone', '--progress', 'https://example.com/repo.git'], true))
      .toEqual(['clone', '--progress', 'https://example.com/repo.git'])
  })

  it.runIf(process.platform !== 'win32')('kills the complete foreground process tree after a timeout', async () => {
    const tools = workspaceTools as unknown as {
      runExecutable(command: string, args: string[], signal: undefined, timeoutMs: number, onOutput: (chunk: string) => void): Promise<string>
    }
    let output = ''
    const script = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write(String(child.pid) + '\\n')",
      "setInterval(() => {}, 1000)"
    ].join(';')

    await expect(tools.runExecutable(process.execPath, ['-e', script], undefined, 150, (chunk) => { output += chunk }))
      .rejects.toThrow('命令执行超过')

    const descendantPid = Number(output.trim().split(/\s+/)[0])
    expect(descendantPid).toBeGreaterThan(0)
    let alive = true
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(descendantPid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        alive = false
      }
    }
    if (alive) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* 已退出。 */ }
    }
    expect(alive).toBe(false)
  })

  it('streams stdout and stderr chunks while the command is running', async () => {
    const chunks: Array<{ chunk: string; source: 'stdout' | 'stderr' }> = []
    const script = "process.stdout.write('first\\n');setTimeout(()=>{process.stderr.write('second\\n')},30)"

    const result = await workspaceTools.runCommand(
      process.execPath,
      ['-e', script],
      undefined,
      true,
      false,
      false,
      (chunk, source) => chunks.push({ chunk, source })
    )

    expect(chunks.map(({ chunk }) => chunk).join('')).toContain('first\nsecond\n')
    expect(chunks.map(({ source }) => source)).toEqual(['stdout', 'stderr'])
    expect(result).toContain('first')
    expect(result).toContain('second')
  })

  it('requires approval for state-changing commands and blocks destructive commands', async () => {
    await expect(workspaceTools.runCommand(process.execPath, ['-e', "process.stdout.write('script')"]))
      .rejects.toThrow('需要用户授权')
    await expect(workspaceTools.runCommand('cmd', ['/c', 'del important.txt'], undefined, true))
      .rejects.toThrow('高风险命令需要用户明确确认')
  })

  it('includes stderr when a command exits unsuccessfully', async () => {
    await expect(workspaceTools.runCommand(process.execPath, ['-e', "process.stderr.write('diagnostic stderr'); process.exit(2)"], undefined, true))
      .rejects.toThrow('diagnostic stderr')
  })

  it('returns a PID without waiting for a background process to exit', async () => {
    const startedAt = Date.now()
    const result = JSON.parse(await workspaceTools.runCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      undefined,
      true,
      false,
      true
    )) as { ok: boolean; background: boolean; pid: number }

    try {
      expect(result).toMatchObject({ ok: true, background: true, verified: true, pid: expect.any(Number) })
      expect(Date.now() - startedAt).toBeLessThan(5000)
      expect(() => process.kill(result.pid, 0)).not.toThrow()
    } finally {
      try { process.kill(result.pid) } catch { /* 进程可能已自行退出。 */ }
    }
  })

  it('reports a background process that exits during startup', async () => {
    await expect(workspaceTools.runCommand(
      process.execPath,
      ['-e', 'process.exit(3)'],
      undefined,
      true,
      false,
      true
    )).rejects.toThrow('启动确认前退出')
  })

  it('includes background startup logs when the process exits early', async () => {
    await expect(workspaceTools.runCommand(
      process.execPath,
      ['-e', "process.stderr.write('desktop startup failed\\n'); process.exit(4)"],
      undefined,
      true,
      false,
      true
    )).rejects.toThrow('desktop startup failed')
  })

  it.runIf(process.platform === 'win32')('resolves npm to its Windows command wrapper', async () => {
    await expect(workspaceTools.runCommand('npm', ['--version'])).resolves.toMatch(/^\d+\.\d+\.\d+/)
  })

  it.runIf(process.platform === 'win32')('runs an explicit npm.cmd command', async () => {
    await expect(workspaceTools.runCommand('npm.cmd', ['--version'])).resolves.toMatch(/^\d+\.\d+\.\d+/)
  })

  it.runIf(process.platform === 'win32')('normalizes a full-width dot in a Windows command name', async () => {
    await expect(workspaceTools.runCommand('npm。cmd', ['--version'])).resolves.toMatch(/^\d+\.\d+\.\d+/)
  })

  it.runIf(process.platform === 'win32')('rejects shell metacharacters passed to Windows command wrappers', async () => {
    await expect(workspaceTools.runCommand('npm.cmd', ['--version & whoami'], undefined, true)).rejects.toThrow('不安全')
  })
})

describe('WorkspaceTools.decryptFile', () => {
  it('uploads to the decrypt service and saves the downloaded result', async () => {
    await writeFile(join(workspacePath, 'secret.txt'), 'encrypted-content', 'utf8')
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/encrypt/file/tranferEncryptFileUrl')) {
        expect(init?.method).toBe('POST')
        expect(init?.redirect).toBe('error')
        expect(init?.body).toBeInstanceOf(FormData)
        expect((init?.body as FormData).get('file')).toBeInstanceOf(Blob)
        return new Response(JSON.stringify({ downloadurl: 'http://172.16.51.141:8899/encrypt/file/downloadEncryptFile/test-id' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      expect(url).toBe('http://172.16.51.141:8899/encrypt/file/downloadEncryptFile/test-id')
      return new Response('decrypted-content', { status: 200, headers: { 'content-length': '17' } })
    })
    globalThis.fetch = fetchMock

    const result = await workspaceTools.decryptFile('secret.txt', 'output/secret.txt')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(result)).toMatchObject({ ok: true, output_path: expect.stringContaining('output'), size_bytes: 17 })
    expect(normalizePath(JSON.parse(result).output_path as string)).toBe('output/secret.txt')
    expect((await stat(join(workspacePath, 'output', 'secret.txt'))).isFile()).toBe(true)
    expect(await readFile(join(workspacePath, 'output', 'secret.txt'), 'utf8')).toBe('decrypted-content')
  })

  it('rejects download URLs outside the configured service', async () => {
    await writeFile(join(workspacePath, 'secret.pdf'), 'encrypted-content', 'utf8')
    globalThis.fetch = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ downloadurl: 'http://example.com/stolen.pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))

    await expect(workspaceTools.decryptFile('secret.pdf')).rejects.toThrow('不安全的下载地址')
  })

  it('accepts PPTX files supported by the decrypt service', async () => {
    await writeFile(join(workspacePath, 'secret.pptx'), 'encrypted-presentation', 'utf8')
    globalThis.fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('tranferEncryptFileUrl')) {
        return new Response(JSON.stringify({ downloadurl: '/encrypt/file/downloadEncryptFile/ppt-id' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response('decrypted-presentation', { status: 200 })
    })

    const result = JSON.parse(await workspaceTools.decryptFile('secret.pptx')) as { output_path: string }

    expect(normalizePath(result.output_path)).toBe('secret.decrypted.pptx')
    expect(await readFile(join(workspacePath, 'secret.decrypted.pptx'), 'utf8')).toBe('decrypted-presentation')
  })

  it('accepts encrypted CSV files', async () => {
    await writeFile(join(workspacePath, 'secret.csv'), Buffer.from([0, 1, 2, 3]))
    globalThis.fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('tranferEncryptFileUrl')) {
        return new Response(JSON.stringify({ downloadurl: '/encrypt/file/downloadEncryptFile/csv-id' }), { status: 200 })
      }
      return new Response('name,value\nalpha,1\n', { status: 200 })
    })

    const result = JSON.parse(await workspaceTools.decryptFile('secret.csv')) as { output_path: string }

    expect(normalizePath(result.output_path)).toBe('secret.decrypted.csv')
    expect(await readFile(join(workspacePath, 'secret.decrypted.csv'), 'utf8')).toContain('alpha,1')
  })

  it('rejects an upload response redirected outside the decrypt service', async () => {
    await writeFile(join(workspacePath, 'secret.xlsx'), 'encrypted-workbook', 'utf8')
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      const response = new Response(JSON.stringify({ downloadurl: '/encrypt/file/downloadEncryptFile/id' }), { status: 200 })
      Object.defineProperty(response, 'url', { value: 'http://example.com/upload' })
      return response
    })

    await expect(workspaceTools.decryptFile('secret.xlsx')).rejects.toThrow('不安全的上传重定向')
  })

  it('only accepts the file types exposed by the decrypt page', async () => {
    await writeFile(join(workspacePath, 'secret.zip'), 'encrypted-content', 'utf8')
    await expect(workspaceTools.decryptFile('secret.zip')).rejects.toThrow('支持')
  })
})

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}
