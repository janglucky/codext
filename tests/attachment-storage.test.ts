import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyConversationAttachments, materializeOfficeAttachments } from '../src/main/attachment-storage'
import type { ChatAttachment, Conversation } from '../src/shared/types'

let workspacePath = ''

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'codext-attachment-storage-'))
})

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true })
})

describe('Attachment storage', () => {
  it('writes the binary file into the workspace and retains only its relative path', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01])
    const attachment: ChatAttachment = {
      id: 'office-1',
      name: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: bytes.length,
      dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + bytes.toString('base64')
    }

    const [stored] = await materializeOfficeAttachments([attachment], workspacePath)

    expect(stored.dataUrl).toBe('')
    expect(stored.workspacePath?.replaceAll('\\', '/')).toMatch(/^\.codext-attachments\/[0-9a-f-]+\/1-report\.docx$/)
    expect(await readFile(join(workspacePath, stored.workspacePath!))).toEqual(bytes)
  })

  it('materializes decryptable text attachments and retains inline content', async () => {
    const textAttachment: ChatAttachment = {
      id: 'text-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
      dataUrl: 'data:text/plain;base64,aGVsbG8='
    }

    const result = await materializeOfficeAttachments([textAttachment], workspacePath)

    expect(result[0].dataUrl).toBe(textAttachment.dataUrl)
    expect(result[0].workspacePath?.replaceAll('\\', '/')).toMatch(/^\.codext-attachments\/[0-9a-f-]+\/1-notes\.txt$/)
    expect(await readFile(join(workspacePath, result[0].workspacePath!), 'utf8')).toBe('hello')
  })

  it('leaves text formats unsupported by the decrypt service inline only', async () => {
    const markdownAttachment: ChatAttachment = {
      id: 'markdown-1',
      name: 'notes.md',
      mimeType: 'text/markdown',
      size: 5,
      dataUrl: 'data:text/markdown;base64,aGVsbG8='
    }

    const result = await materializeOfficeAttachments([markdownAttachment], workspacePath)

    expect(result[0]).toBe(markdownAttachment)
  })

  it('copies materialized attachments when a conversation changes workspace', async () => {
    const bytes = Buffer.from('workspace attachment')
    const attachment: ChatAttachment = {
      id: 'copy-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      dataUrl: 'data:text/plain;base64,' + bytes.toString('base64')
    }
    const [stored] = await materializeOfficeAttachments([attachment], workspacePath)
    const targetWorkspace = join(workspacePath, 'target-workspace')
    await mkdir(targetWorkspace)
    const conversation: Conversation = {
      id: 'conversation-1',
      title: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ id: 'message-1', role: 'user', content: '', createdAt: new Date().toISOString(), attachments: [stored] }]
    }

    await copyConversationAttachments(conversation, workspacePath, targetWorkspace)

    expect(await readFile(join(targetWorkspace, stored.workspacePath!))).toEqual(bytes)
  })
})
