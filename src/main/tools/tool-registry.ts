export type ToolName = 'read_file' | 'write_file' | 'create_directory' | 'list_files' | 'decrypt_file' | 'parse_word' | 'parse_excel' | 'parse_powerpoint' | 'run_command'
export type ToolArguments = { path?: string; content?: string; command?: string; args?: string[]; recursive?: boolean; output_path?: string; max_characters?: number; include_notes?: boolean }
export type ToolCall = { name: ToolName; arguments: ToolArguments }

export interface ToolDefinition {
  name: ToolName
  description: string
  whenToUse: string
  inputSchema: Record<string, unknown>
  example: ToolCall
}

export const toolRegistry: Record<ToolName, ToolDefinition> = {
  read_file: {
    name: 'read_file',
    description: '读取工作区内文本文件的完整内容。',
    whenToUse: '需要理解、检查、引用或修改某个已有文件前，先调用此工具读取文件。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: '工作区内相对路径，例如 src/main/index.ts。' } }
    },
    example: { name: 'read_file', arguments: { path: 'package.json' } }
  },
  write_file: {
    name: 'write_file',
    description: '向工作区内文件写入完整内容；不存在的父目录会自动创建。',
    whenToUse: '需要创建文件或覆盖更新文件内容时调用。写入前应确认目标路径和内容。',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: '工作区内相对路径。' },
        content: { type: 'string', description: '要写入文件的完整文本内容。' }
      }
    },
    example: { name: 'write_file', arguments: { path: 'notes/todo.txt', content: 'hello' } }
  },
  create_directory: {
    name: 'create_directory',
    description: '在工作区内创建目录；缺失的父目录会一并创建。',
    whenToUse: '需要为新文件、模块或输出结果准备目录时调用。路径必须是工作区内的相对路径。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: '要创建的工作区相对目录，例如 output/reports。' } }
    },
    example: { name: 'create_directory', arguments: { path: 'output/reports' } }
  },
  list_files: {
    name: 'list_files',
    description: '列举工作区目录中的文件、子目录、大小和相对路径。',
    whenToUse: '需要了解目录结构、寻找文件或确认输出是否存在时调用；优先使用本工具而不是 run_command 列目录。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列举的工作区相对目录，默认是工作区根目录。' },
        recursive: { type: 'boolean', description: '是否递归列举子目录，默认 false；结果最多返回 500 项。' }
      }
    },
    example: { name: 'list_files', arguments: { path: 'src', recursive: true } }
  },
  decrypt_file: {
    name: 'decrypt_file',
    description: '将工作区内的加密文件上传到内部服务进行解密，再把解密副本保存回工作区。已验证支持 txt、csv、pdf、docx、xlsx、pptx。',
    whenToUse: '用户明确要求解密，文本或 CSV 出现 NUL、乱码、异常二进制内容，或者 Office 解析返回加密相关错误时调用。不要猜测疑似加密文件的内容。默认生成同目录的 *.decrypted.* 文件，不覆盖原始文件；成功后从 output_path 继续读取或解析。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '待解密文件的工作区相对路径。' },
        output_path: { type: 'string', description: '可选的解密结果相对路径；不能与原文件相同。' }
      }
    },
    example: { name: 'decrypt_file', arguments: { path: 'documents/report.xlsx', output_path: 'documents/report.decrypted.xlsx' } }
  },
  parse_word: {
    name: 'parse_word',
    description: '在本地解析工作区内的 Word DOCX 文档，返回保留标题、段落、列表和表格结构的 Markdown。',
    whenToUse: '用户要求阅读、总结或提取 Word 文档内容时调用。若企业加密导致解析失败，先调用 decrypt_file 再解析解密结果。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '工作区内 DOCX 文件的相对路径。' },
        max_characters: { type: 'number', minimum: 1000, maximum: 120000, description: '最多返回的字符数，默认 60000。' }
      }
    },
    example: { name: 'parse_word', arguments: { path: 'documents/report.docx' } }
  },
  parse_excel: {
    name: 'parse_excel',
    description: '在本地解析工作区内的 Excel XLSX 工作簿，返回包含工作表和表格数据的 Markdown。',
    whenToUse: '用户要求检查、汇总或分析 Excel 工作簿时调用。若企业加密导致解析失败，先调用 decrypt_file 再解析解密结果。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '工作区内 XLSX 文件的相对路径。' },
        max_characters: { type: 'number', minimum: 1000, maximum: 120000, description: '最多返回的字符数，默认 60000。' }
      }
    },
    example: { name: 'parse_excel', arguments: { path: 'documents/data.xlsx' } }
  },
  parse_powerpoint: {
    name: 'parse_powerpoint',
    description: '通过内置 PPT MCP 解析工作区内的 PowerPoint PPTX 文件，返回按幻灯片组织的 Markdown；每次连接前都需要用户确认。',
    whenToUse: '用户要求阅读、总结或提取 PowerPoint 内容时调用。默认包含演讲者备注；若企业加密导致解析失败，先调用 decrypt_file，再用返回的 output_path 重新解析。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '工作区内 PPTX 文件的相对路径。' },
        include_notes: { type: 'boolean', description: '是否包含演讲者备注，默认 true。' },
        max_characters: { type: 'number', minimum: 1000, maximum: 120000, description: '最多返回的字符数，默认 60000。' }
      }
    },
    example: { name: 'parse_powerpoint', arguments: { path: 'documents/slides.pptx', include_notes: true } }
  },
  run_command: {
    name: 'run_command',
    description: '在工作区目录下执行安全的命令行程序，并返回 stdout/stderr。',
    whenToUse: '需要运行测试、构建或执行非破坏性工程命令时调用。禁止用它调用 Python、PowerShell、tar、unzip 或临时脚本解析 Office 文件；Office 必须使用专用解析工具。不要用来删除、格式化、关机或修改注册表。',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: '可执行文件名，例如 npm、node、git。不要传整段 shell 字符串。' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数数组，例如 ["run", "build"]。' }
      }
    },
    example: { name: 'run_command', arguments: { command: 'npm', args: ['run', 'build'] } }
  }
}

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolRegistry, name)
}

export function getEnabledToolDefinitions(enabledTools: string[]): ToolDefinition[] {
  return enabledTools.filter(isToolName).map((name) => toolRegistry[name])
}
