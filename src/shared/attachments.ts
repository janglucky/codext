export const MAX_ATTACHMENT_COUNT = 6
export const MAX_IMAGE_ATTACHMENT_SIZE = 10 * 1024 * 1024
export const MAX_TEXT_ATTACHMENT_SIZE = 1024 * 1024
export const MAX_OFFICE_ATTACHMENT_SIZE = 30 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENT_SIZE = 60 * 1024 * 1024
export const MAX_TEXT_ATTACHMENT_CHARACTERS = 60_000

export type OfficeAttachmentTool = 'parse_word' | 'parse_excel' | 'parse_powerpoint'

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/css',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml'
])
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'css',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs',
  'sh', 'bash', 'ps1', 'sql', 'toml', 'ini', 'env', 'gitignore'
])
const DECRYPTABLE_EXTENSIONS = new Set(['txt', 'csv', 'pdf', 'docx', 'xlsx', 'pptx'])
const OFFICE_ATTACHMENT_TYPES: Record<string, { mimeType: string; tool: OfficeAttachmentTool }> = {
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', tool: 'parse_word' },
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', tool: 'parse_excel' },
  pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', tool: 'parse_powerpoint' }
}

export const ATTACHMENT_ACCEPT = [
  ...Array.from(IMAGE_MIME_TYPES),
  ...Array.from(TEXT_EXTENSIONS, (extension) => '.' + extension),
  ...Object.values(OFFICE_ATTACHMENT_TYPES).map((officeType) => officeType.mimeType),
  ...Object.keys(OFFICE_ATTACHMENT_TYPES).map((extension) => '.' + extension)
].join(',')

export function isImageAttachmentType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLowerCase())
}

export function isTextAttachmentType(mimeType: string, name: string): boolean {
  const normalizedMimeType = mimeType.toLowerCase()
  if (normalizedMimeType.startsWith('text/') || TEXT_MIME_TYPES.has(normalizedMimeType)) return true
  return TEXT_EXTENSIONS.has(fileExtension(name))
}

export function officeAttachmentTool(name: string): OfficeAttachmentTool | undefined {
  return OFFICE_ATTACHMENT_TYPES[fileExtension(name)]?.tool
}

export function isOfficeAttachmentType(mimeType: string, name: string): boolean {
  const officeType = OFFICE_ATTACHMENT_TYPES[fileExtension(name)]
  return Boolean(officeType && officeType.mimeType === mimeType.toLowerCase())
}

export function isDecryptableAttachmentName(name: string): boolean {
  return DECRYPTABLE_EXTENSIONS.has(fileExtension(name))
}

export function isSupportedAttachmentType(mimeType: string, name: string): boolean {
  return isImageAttachmentType(mimeType) || isTextAttachmentType(mimeType, name) || isOfficeAttachmentType(mimeType, name)
}

export function inferAttachmentMimeType(mimeType: string, name: string): string {
  const extension = fileExtension(name)
  const officeType = OFFICE_ATTACHMENT_TYPES[extension]
  if (officeType) return officeType.mimeType
  if (mimeType) return mimeType.toLowerCase()
  if (extension === 'json') return 'application/json'
  if (extension === 'csv') return 'text/csv'
  if (extension === 'html' || extension === 'htm') return 'text/html'
  if (extension === 'css') return 'text/css'
  if (extension === 'xml') return 'application/xml'
  if (extension === 'yaml' || extension === 'yml') return 'application/x-yaml'
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') return 'application/javascript'
  if (extension === 'ts' || extension === 'tsx') return 'application/typescript'
  if (TEXT_EXTENSIONS.has(extension)) return 'text/plain'
  return 'application/octet-stream'
}

function fileExtension(name: string): string {
  const normalized = name.toLowerCase()
  const lastSegment = normalized.split(/[\\/]/).at(-1) ?? normalized
  if (lastSegment.startsWith('.') && !lastSegment.slice(1).includes('.')) return lastSegment.slice(1)
  return lastSegment.includes('.') ? lastSegment.split('.').at(-1) ?? '' : ''
}
