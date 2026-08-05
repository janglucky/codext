import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTextFilePath, launchApplication, normalizeWebUrl, resolveWorkspaceFile, validateApplicationPath } from '../src/main/navigation'

let root = ''
let workspace = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codext-navigation-'))
  workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'app.ts'), 'export {}', 'utf8')
  await writeFile(join(root, 'outside.ts'), 'outside', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('workspace file navigation', () => {
  it('resolves an existing file inside the workspace', async () => {
    await expect(resolveWorkspaceFile(workspace, 'app.ts')).resolves.toBe(join(workspace, 'app.ts'))
  })

  it('rejects absolute, outside and directory paths', async () => {
    await expect(resolveWorkspaceFile(workspace, join(workspace, 'app.ts'))).rejects.toThrow('相对路径')
    await expect(resolveWorkspaceFile(workspace, '../outside.ts')).rejects.toThrow('工作区外')
    await expect(resolveWorkspaceFile(workspace, '.')).rejects.toThrow('文件')
  })
})

describe('configured applications', () => {
  it('recognizes code and text files without treating binary documents as text', () => {
    expect(isTextFilePath('src/App.tsx')).toBe(true)
    expect(isTextFilePath('README.md')).toBe(true)
    expect(isTextFilePath('.gitignore')).toBe(true)
    expect(isTextFilePath('report.xlsx')).toBe(false)
  })

  it('validates an existing application file path', async () => {
    const applicationPath = join(workspace, 'editor.exe')
    await writeFile(applicationPath, 'test', 'utf8')
    await expect(validateApplicationPath(applicationPath)).resolves.toBe(applicationPath)
    await expect(validateApplicationPath('editor.exe')).rejects.toThrow('绝对路径')
    await expect(validateApplicationPath(workspace)).rejects.toThrow('重新选择')
  })

  it('passes the target to a configured application and detaches it', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    const spawnProcess = vi.fn(() => child)
    const promise = launchApplication('editor.exe', 'C:/workspace/README.md', spawnProcess as never)
    expect(spawnProcess).toHaveBeenCalledWith('editor.exe', ['C:/workspace/README.md'], expect.objectContaining({ detached: true, stdio: 'ignore' }))
    child.emit('spawn')
    await expect(promise).resolves.toBeUndefined()
    expect(child.unref).toHaveBeenCalledOnce()
  })
})

describe('web navigation', () => {
  it('normalizes wildcard service hosts for the local browser', () => {
    expect(normalizeWebUrl('http://0.0.0.0:5173/app')).toBe('http://localhost:5173/app')
  })

  it('rejects non-web protocols and embedded credentials', () => {
    expect(() => normalizeWebUrl('file:///C:/secret.txt')).toThrow('HTTP')
    expect(() => normalizeWebUrl('https://user:password@example.com')).toThrow('登录凭据')
  })
})
