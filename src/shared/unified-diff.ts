export type UnifiedDiffLineKind = 'context' | 'add' | 'delete' | 'modify-old' | 'modify-new' | 'hunk' | 'note'

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind
  content: string
  oldLine?: number
  newLine?: number
}

export interface UnifiedDiffView {
  lines: UnifiedDiffLine[]
  added: number
  deleted: number
  modified: number
}

interface PendingChangeLine {
  content: string
  lineNumber: number
}

/** Parse a text unified diff into renderable lines and user-facing counts. */
export function parseUnifiedDiff(diff: string): UnifiedDiffView {
  const rendered: UnifiedDiffLine[] = []
  let added = 0
  let deleted = 0
  let modified = 0
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const sourceLines = diff.replaceAll('\r\n', '\n').split('\n')

  for (let index = 0; index < sourceLines.length;) {
    const line = sourceLines[index]
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      rendered.push({ kind: 'hunk', content: line })
      index++
      continue
    }

    if (!inHunk) {
      index++
      continue
    }

    if (line.startsWith('-') || line.startsWith('+')) {
      const removed: PendingChangeLine[] = []
      const inserted: PendingChangeLine[] = []
      while (index < sourceLines.length) {
        const changedLine = sourceLines[index]
        if (changedLine.startsWith('-')) {
          removed.push({ content: changedLine.slice(1), lineNumber: oldLine++ })
        } else if (changedLine.startsWith('+')) {
          inserted.push({ content: changedLine.slice(1), lineNumber: newLine++ })
        } else {
          break
        }
        index++
      }

      const paired = Math.min(removed.length, inserted.length)
      modified += paired
      deleted += removed.length - paired
      added += inserted.length - paired
      removed.forEach((item, itemIndex) => rendered.push({
        kind: itemIndex < paired ? 'modify-old' : 'delete',
        content: item.content,
        oldLine: item.lineNumber
      }))
      inserted.forEach((item, itemIndex) => rendered.push({
        kind: itemIndex < paired ? 'modify-new' : 'add',
        content: item.content,
        newLine: item.lineNumber
      }))
      continue
    }

    if (line.startsWith(' ')) {
      rendered.push({ kind: 'context', content: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
    } else if (line.startsWith('\\')) {
      rendered.push({ kind: 'note', content: line })
    }
    index++
  }

  return { lines: rendered, added, deleted, modified }
}
