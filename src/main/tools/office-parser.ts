import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'

export type OfficeDocumentKind = 'word' | 'excel' | 'powerpoint'

const ALLOWED_EXTENSIONS: Record<OfficeDocumentKind, Set<string>> = {
  word: new Set(['.docx']),
  excel: new Set(['.xlsx']),
  powerpoint: new Set(['.pptx'])
}
const MAX_OFFICE_FILE_SIZE = 30 * 1024 * 1024
const DEFAULT_MAX_CHARACTERS = 60_000
const MAX_OUTPUT_CHARACTERS = 120_000
const PARSE_TIMEOUT_MS = 60_000

export interface OfficeParseOptions {
  includeNotes?: boolean
  maxCharacters?: number
}

export async function parseOfficeDocument(workspacePath: string, filePath: string, kind: OfficeDocumentKind, options: OfficeParseOptions = {}): Promise<string> {
  const source = await resolveOfficeFile(workspacePath, filePath)
  const extension = extname(source).toLowerCase()
  if (!ALLOWED_EXTENSIONS[kind].has(extension)) throw new Error(kindLabel(kind) + ' 解析仅支持 ' + Array.from(ALLOWED_EXTENSIONS[kind]).join('、') + ' 文件。')
  const sourceStat = await stat(source)
  if (!sourceStat.isFile()) throw new Error('Office 解析路径必须是文件。')
  if (sourceStat.size <= 0) throw new Error('不能解析空文件。')
  if (sourceStat.size > MAX_OFFICE_FILE_SIZE) throw new Error('Office 文件不能超过 30 MB。')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS)
  try {
    const { OfficeParser } = await import('officeparser')
    const ast = await OfficeParser.parseOffice(source, {
      ignoreNotes: kind === 'powerpoint' && options.includeNotes === false,
      ignoreComments: false,
      ignoreHeadersAndFooters: false,
      ignoreSlideMasters: true,
      extractAttachments: false,
      abortSignal: controller.signal,
      decompressionLimits: { maxUncompressedBytes: 128 * 1024 * 1024, maxZipEntries: 5000 }
    })
    const converted = await ast.to('md', { includeImages: false, includeCharts: true, abortSignal: controller.signal })
    if (typeof converted.value !== 'string') throw new Error('Office 解析器返回了非文本结果。')
    const normalized = converted.value.trim()
    if (!normalized) throw new Error('Office 文件中没有可提取的文本内容。')
    const maxCharacters = Math.min(Math.max(Math.floor(options.maxCharacters ?? DEFAULT_MAX_CHARACTERS), 1000), MAX_OUTPUT_CHARACTERS)
    const body = normalized.length > maxCharacters ? normalized.slice(0, maxCharacters) + '\n\n[内容过长，已截断]' : normalized
    const warnings = [...ast.warnings, ...converted.messages]
    const warningText = warnings.length ? '\n解析警告：' + warnings.slice(0, 5).map((warning) => warning.message).join('；') : ''
    return '文件：' + relative(resolve(workspacePath), source) + '\n类型：' + kindLabel(kind) + warningText + '\n\n' + body
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Office 文件解析超时。')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveOfficeFile(workspacePath: string, filePath: string): Promise<string> {
  const workspaceRoot = resolve(workspacePath)
  const target = resolve(workspaceRoot, filePath)
  assertWithinWorkspace(workspaceRoot, target)
  const actualPath = await realpath(target)
  assertWithinWorkspace(workspaceRoot, actualPath)
  return actualPath
}

function assertWithinWorkspace(workspaceRoot: string, target: string): void {
  const pathRelative = relative(workspaceRoot, target)
  if (pathRelative === '..' || pathRelative.startsWith('..\\') || pathRelative.startsWith('../') || isAbsolute(pathRelative)) {
    throw new Error('Office 文件仅允许从当前工作区读取。')
  }
}

function kindLabel(kind: OfficeDocumentKind): string {
  if (kind === 'word') return 'Word'
  if (kind === 'excel') return 'Excel'
  return 'PowerPoint'
}
