import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_ACCEPT,
  inferAttachmentMimeType,
  isOfficeAttachmentType,
  isSupportedAttachmentType,
  officeAttachmentTool
} from '../src/shared/attachments'

describe('Office chat attachments', () => {
  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'parse_word'],
    ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'parse_excel'],
    ['roadmap.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'parse_powerpoint']
  ])('supports %s and maps it to the matching local tool', (name, mimeType, toolName) => {
    expect(inferAttachmentMimeType('application/octet-stream', name)).toBe(mimeType)
    expect(isOfficeAttachmentType(mimeType, name)).toBe(true)
    expect(isSupportedAttachmentType(mimeType, name)).toBe(true)
    expect(officeAttachmentTool(name)).toBe(toolName)
    expect(ATTACHMENT_ACCEPT).toContain('.' + name.split('.').at(-1))
  })

  it('does not claim support for legacy Office binary formats', () => {
    expect(isSupportedAttachmentType('application/msword', 'legacy.doc')).toBe(false)
    expect(isSupportedAttachmentType('application/vnd.ms-excel', 'legacy.xls')).toBe(false)
    expect(isSupportedAttachmentType('application/vnd.ms-powerpoint', 'legacy.ppt')).toBe(false)
  })
})
