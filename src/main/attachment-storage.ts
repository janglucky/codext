import type { ChatAttachment, Conversation } from '../shared/types'
import { isDecryptableAttachmentName, isOfficeAttachmentType } from '../shared/attachments'
import { WorkspaceTools } from './tools/workspace-tools'

export async function materializeOfficeAttachments(attachments: ChatAttachment[], workspacePath: string): Promise<ChatAttachment[]> {
  if (!attachments.some((attachment) => shouldMaterialize(attachment))) return attachments

  const tools = new WorkspaceTools(workspacePath)
  const uploadDirectory = '.codext-attachments/' + crypto.randomUUID()
  await tools.createDirectory(uploadDirectory)
  return Promise.all(attachments.map(async (attachment, index) => {
    if (!shouldMaterialize(attachment)) return attachment
    const separatorIndex = attachment.dataUrl.indexOf(',')
    if (separatorIndex < 0) throw new Error('附件数据无效：' + attachment.name)
    const relativePath = uploadDirectory + '/' + (index + 1) + '-' + attachment.name
    const savedPath = await tools.saveBinaryFile(relativePath, Buffer.from(attachment.dataUrl.slice(separatorIndex + 1), 'base64'))
    return {
      ...attachment,
      dataUrl: isOfficeAttachmentType(attachment.mimeType, attachment.name) ? '' : attachment.dataUrl,
      workspacePath: savedPath
    }
  }))
}

export async function copyConversationAttachments(conversation: Conversation, sourceWorkspacePath: string, targetWorkspacePath: string): Promise<void> {
  if (sourceWorkspacePath === targetWorkspacePath) return
  const sourceTools = new WorkspaceTools(sourceWorkspacePath)
  const targetTools = new WorkspaceTools(targetWorkspacePath)
  const copiedPaths = new Set<string>()
  const attachments = [...(conversation.activeAttachments ?? []), ...conversation.messages.flatMap((message) => message.attachments ?? [])]
  for (const attachment of attachments) {
    if (!attachment.workspacePath || copiedPaths.has(attachment.workspacePath)) continue
    const content = await sourceTools.readBinaryFile(attachment.workspacePath)
    await targetTools.saveBinaryFile(attachment.workspacePath, content)
    copiedPaths.add(attachment.workspacePath)
  }
}

function shouldMaterialize(attachment: ChatAttachment): boolean {
  return !attachment.workspacePath && (isOfficeAttachmentType(attachment.mimeType, attachment.name) || isDecryptableAttachmentName(attachment.name))
}
