import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { parseOfficeDocument } from '../src/main/tools/office-parser'

interface OfficeParagraph { addText(text: string): void }
interface OfficeSlide { addText(text: string): void }
interface OfficeSheet { name: string; data: Array<Array<string | number>> }
interface GeneratedOfficeDocument {
  createP(): OfficeParagraph
  makeNewSlide(): OfficeSlide
  makeNewSheet(): OfficeSheet
  generate(stream: Writable): void
  on(event: 'error', callback: (error: Error) => void): void
}
type OfficegenFactory = (type: 'docx' | 'xlsx' | 'pptx') => GeneratedOfficeDocument

const require = createRequire(import.meta.url)
const officegen = require('officegen') as OfficegenFactory
let workspacePath = ''

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'codext-office-parser-'))
})

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('Office parser', () => {
  it('parses Word, Excel and PowerPoint OOXML files locally', async () => {
    await Promise.all([
      createWord(join(workspacePath, 'sample.docx'), 'Word contract content'),
      createExcel(join(workspacePath, 'sample.xlsx'), 'Excel revenue content'),
      createPowerPoint(join(workspacePath, 'sample.pptx'), 'PowerPoint roadmap content')
    ])

    const [word, excel, powerpoint] = await Promise.all([
      parseOfficeDocument(workspacePath, 'sample.docx', 'word'),
      parseOfficeDocument(workspacePath, 'sample.xlsx', 'excel'),
      parseOfficeDocument(workspacePath, 'sample.pptx', 'powerpoint')
    ])

    expect(word).toContain('Word contract content')
    expect(excel).toContain('Excel revenue content')
    expect(powerpoint).toContain('PowerPoint roadmap content')
  })

  it('rejects files outside the workspace and mismatched formats', async () => {
    await createWord(join(workspacePath, 'sample.docx'), 'content')
    await expect(parseOfficeDocument(workspacePath, '../sample.docx', 'word')).rejects.toThrow('工作区')
    await expect(parseOfficeDocument(workspacePath, 'sample.docx', 'excel')).rejects.toThrow('仅支持')
  })
})

async function createWord(path: string, text: string): Promise<void> {
  const document = officegen('docx')
  document.createP().addText(text)
  await generate(document, path)
}

async function createExcel(path: string, text: string): Promise<void> {
  const document = officegen('xlsx')
  const sheet = document.makeNewSheet()
  sheet.name = 'Data'
  sheet.data[0] = ['Label', 'Value']
  sheet.data[1] = [text, 42]
  await generate(document, path)
}

async function createPowerPoint(path: string, text: string): Promise<void> {
  const document = officegen('pptx')
  document.makeNewSlide().addText(text)
  await generate(document, path)
}

function generate(document: GeneratedOfficeDocument, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(path)
    document.on('error', reject)
    stream.on('error', reject)
    stream.on('finish', resolve)
    document.generate(stream)
  })
}
