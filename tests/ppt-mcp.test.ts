import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { PptMcpClient } from '../src/main/ppt/ppt-mcp-client'
import { startPptMcpServer, type RunningPptMcpServer } from '../src/main/ppt/ppt-mcp-server'

interface OfficeSlide { addText(text: string): void }
interface GeneratedPresentation {
  makeNewSlide(): OfficeSlide
  generate(stream: Writable): void
  on(event: 'error', callback: (error: Error) => void): void
}

const require = createRequire(import.meta.url)
const officegen = require('officegen') as (type: 'pptx') => GeneratedPresentation
let workspacePath = ''
let server: RunningPptMcpServer | undefined

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'codext-ppt-mcp-'))
  server = await startPptMcpServer(() => workspacePath, 0)
})

afterEach(async () => {
  await server?.close()
  await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('PPT MCP protocol', () => {
  it('reports processing capabilities and rejects non-local origins', async () => {
    const healthUrl = server!.url.replace('/mcp', '/health')
    const health = await fetch(healthUrl)
    const body = await health.json() as { ok: boolean; capabilities: { structureExtraction: string; libreOfficeRender: boolean; ocrVision: boolean } }

    expect(health.ok).toBe(true)
    expect(body).toMatchObject({ ok: true, capabilities: { structureExtraction: 'officeparser', ocrVision: false } })
    expect(typeof body.capabilities.libreOfficeRender).toBe('boolean')

    const forbidden = await fetch(healthUrl, { headers: { Origin: 'http://example.com' } })
    expect(forbidden.status).toBe(403)
  })

  it('discovers and calls parse_powerpoint through MCP', async () => {
    await createPowerPoint(join(workspacePath, 'roadmap.pptx'), 'PPT MCP roadmap content')

    const output = await new PptMcpClient(server!.url).parsePowerPoint({ path: 'roadmap.pptx' })

    expect(output).toContain('PPT Processing Service')
    expect(output).toContain('PPT MCP roadmap content')
  })

  it('uses an authorized conversation workspace and rejects other roots', async () => {
    await server!.close()
    const conversationWorkspace = join(workspacePath, 'conversation-workspace')
    await mkdir(conversationWorkspace)
    await createPowerPoint(join(conversationWorkspace, 'session.pptx'), 'Conversation workspace content')
    server = await startPptMcpServer((requested) => {
      if (requested && requested !== conversationWorkspace) throw new Error('unauthorized workspace')
      return requested ?? workspacePath
    }, 0)
    const client = new PptMcpClient(server.url)

    await expect(client.parsePowerPoint({ path: 'session.pptx', workspace_path: conversationWorkspace })).resolves.toContain('Conversation workspace content')
    await expect(client.parsePowerPoint({ path: 'session.pptx', workspace_path: join(workspacePath, 'other') })).rejects.toThrow('unauthorized workspace')
  })

  it('falls back to OOXML slide and notes extraction when the primary parser has no usable structure', async () => {
    const slideXml = '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:t>Fallback slide title</a:t><a:t>Fallback slide body</a:t></p:cSld></p:sld>'
    const notesXml = '<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Fallback speaker note</a:t></p:notes>'
    await writeFile(join(workspacePath, 'fallback.pptx'), zipSync({
      'ppt/slides/slide1.xml': strToU8(slideXml),
      'ppt/notesSlides/notesSlide1.xml': strToU8(notesXml)
    }))

    const output = await new PptMcpClient(server!.url).parsePowerPoint({ path: 'fallback.pptx', include_notes: true })

    expect(output).toContain('OOXML XML 兜底：已启用')
    expect(output).toContain('Fallback slide title')
    expect(output).toContain('Fallback slide body')
    expect(output).toContain('Fallback speaker note')
  })
})

async function createPowerPoint(path: string, text: string): Promise<void> {
  const document = officegen('pptx')
  document.makeNewSlide().addText(text)
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path)
    document.on('error', reject)
    stream.on('error', reject)
    stream.on('finish', resolve)
    document.generate(stream)
  })
}
