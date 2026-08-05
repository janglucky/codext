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
    const names = ['create_directory', 'list_files', 'decrypt_file', 'start_service']
    expect(names.every(isToolName)).toBe(true)
    expect(getEnabledToolDefinitions(names).map((tool) => tool.name)).toEqual(names)
  })
})

describe('WorkspaceTools.startService', () => {
  it('returns the service URL while leaving the server available', async () => {
    const script = "const http=require('node:http');const server=http.createServer((_request,response)=>response.end('ready'));server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port))"

    const result = JSON.parse(await workspaceTools.startService(process.execPath, ['-e', script])) as { url: string; pid: number }

    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(result.pid).toBeGreaterThan(0)
    await expect(fetch(result.url).then((response) => response.text())).resolves.toBe('ready')
  })
})

describe('WorkspaceTools.runCommand', () => {
  it('requires approval for state-changing commands and blocks destructive commands', async () => {
    await expect(workspaceTools.runCommand(process.execPath, ['-e', "process.stdout.write('script')"]))
      .rejects.toThrow('需要用户授权')
    await expect(workspaceTools.runCommand('cmd', ['/c', 'del important.txt'], undefined, true))
      .rejects.toThrow('安全策略')
  })

  it('includes stderr when a command exits unsuccessfully', async () => {
    await expect(workspaceTools.runCommand(process.execPath, ['-e', "process.stderr.write('diagnostic stderr'); process.exit(2)"], undefined, true))
      .rejects.toThrow('diagnostic stderr')
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
