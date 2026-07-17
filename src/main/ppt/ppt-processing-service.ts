import { access, readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { unzipSync } from 'fflate'
import { parseOfficeDocument, resolveOfficeFile, type OfficeParseOptions } from '../tools/office-parser'

const DRAWING_ML_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const MAX_FALLBACK_ENTRIES = 1000
const MAX_FALLBACK_ENTRY_SIZE = 4 * 1024 * 1024
const MAX_FALLBACK_TOTAL_SIZE = 32 * 1024 * 1024
const DEFAULT_MAX_CHARACTERS = 60_000
const MAX_OUTPUT_CHARACTERS = 120_000

export interface PptProcessingCapabilities {
  structureExtraction: 'officeparser'
  ooxmlFallback: true
  libreOfficeRender: boolean
  ocrVision: boolean
}

export class PptProcessingService {
  constructor(private readonly getWorkspacePath: (requestedWorkspacePath?: string) => string) {}

  async parse(filePath: string, options: OfficeParseOptions = {}, workspacePath?: string): Promise<string> {
    const resolvedWorkspacePath = this.getWorkspacePath(workspacePath)
    const capabilities = await this.getCapabilities()
    let content = ''
    let parserError: unknown
    try {
      content = await parseOfficeDocument(resolvedWorkspacePath, filePath, 'powerpoint', options)
    } catch (error) {
      parserError = error
    }

    let fallbackUsed = false
    if (!hasMeaningfulBody(content)) {
      try {
        const fallback = await extractPptxOoxmlText(resolvedWorkspacePath, filePath, options)
        if (fallback) {
          content = fallback
          fallbackUsed = true
        }
      } catch (fallbackError) {
        if (parserError) throw parserError
        throw fallbackError
      }
    }
    if (!hasMeaningfulBody(content)) {
      if (parserError) throw parserError
      throw new Error('PowerPoint 中没有可提取的幻灯片文本或演讲者备注。')
    }
    const pipeline = [
      'PPT Processing Service：',
      '- 结构提取：officeparser',
      '- OOXML XML 兜底：' + (fallbackUsed ? '已启用' : '未使用'),
      '- LibreOffice 渲染：' + (capabilities.libreOfficeRender ? '可用' : '不可用，已跳过'),
      '- OCR Vision：' + (capabilities.ocrVision ? '可用' : '不可用，已跳过')
    ].join('\n')
    return pipeline + '\n\n' + content
  }

  async getCapabilities(): Promise<PptProcessingCapabilities> {
    return {
      structureExtraction: 'officeparser',
      ooxmlFallback: true,
      libreOfficeRender: await hasLibreOffice(),
      ocrVision: false
    }
  }
}

export async function extractPptxOoxmlText(workspacePath: string, filePath: string, options: OfficeParseOptions = {}): Promise<string> {
  const source = await resolveOfficeFile(workspacePath, filePath)
  let extractedEntries = 0
  let extractedSize = 0
  const archive = unzipSync(await readFile(source), {
    filter: (entry) => {
      if (!/^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i.test(entry.name)) return false
      extractedEntries++
      extractedSize += entry.originalSize
      if (extractedEntries > MAX_FALLBACK_ENTRIES) throw new Error('PPT XML 条目数量超过安全限制。')
      if (entry.originalSize > MAX_FALLBACK_ENTRY_SIZE || extractedSize > MAX_FALLBACK_TOTAL_SIZE) throw new Error('PPT XML 解压大小超过安全限制。')
      return true
    }
  })
  const slides = Object.entries(archive)
    .flatMap(([name, data]) => {
      const number = entryNumber(name, /^ppt\/slides\/slide(\d+)\.xml$/i)
      return number === undefined ? [] : [{ name, data, number }]
    })
    .sort((left, right) => left.number - right.number)
  const notes = new Map(Object.entries(archive)
    .flatMap(([name, data]) => {
      const number = entryNumber(name, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/i)
      return number === undefined ? [] : [{ data, number }]
    })
    .map((entry) => [entry.number, drawingText(entry.data)]))
  const sections = slides.map((slide) => {
    const slideText = drawingText(slide.data)
    const noteText = options.includeNotes === false ? [] : notes.get(slide.number) ?? []
    return [
      '## Slide ' + slide.number,
      slideText.length ? slideText.join('\n') : '[无可提取文本]',
      noteText.length ? '### Notes\n' + noteText.join('\n') : ''
    ].filter(Boolean).join('\n\n')
  })
  if (!sections.some((section) => hasMeaningfulBody(section.replace(/\[无可提取文本\]/g, '')))) return ''
  const maxCharacters = Math.min(Math.max(Math.floor(options.maxCharacters ?? DEFAULT_MAX_CHARACTERS), 1000), MAX_OUTPUT_CHARACTERS)
  const body = sections.join('\n\n').trim()
  const truncated = body.length > maxCharacters ? body.slice(0, maxCharacters) + '\n\n[内容过长，已截断]' : body
  return '文件：' + filePath + '\n类型：PowerPoint（OOXML XML 兜底）\n\n' + truncated
}

function drawingText(data: Uint8Array): string[] {
  const document = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml')
  const elements = document.getElementsByTagNameNS(DRAWING_ML_NAMESPACE, 't')
  const text: string[] = []
  for (let index = 0; index < elements.length; index++) {
    const value = elements.item(index)?.textContent?.trim()
    if (value) text.push(value)
  }
  return text
}

function entryNumber(name: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(name)
  return match ? Number(match[1]) : undefined
}

function hasMeaningfulBody(content: string): boolean {
  const body = content.includes('\n\n') ? content.slice(content.indexOf('\n\n') + 2) : content
  return (body.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3
}

async function hasLibreOffice(): Promise<boolean> {
  const executableNames = process.platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice']
  const candidates = (process.env.PATH ?? '').split(delimiter).flatMap((directory) => executableNames.map((name) => join(directory, name)))
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    )
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true
  }
  return false
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
