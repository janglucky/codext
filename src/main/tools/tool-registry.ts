export type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'create_directory' | 'list_files' | 'decrypt_file' | 'parse_word' | 'parse_excel' | 'parse_powerpoint' | 'run_command' | 'start_service'
export type ToolArguments = { path?: string; content?: string; old_text?: string; new_text?: string; replace_all?: boolean; command?: string; args?: string[]; background?: boolean; recursive?: boolean; output_path?: string; max_characters?: number; include_notes?: boolean }
export type ToolCall = { id?: string; dependsOn?: string[]; name: ToolName; arguments: ToolArguments }

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
    description: '读取文本文件的完整内容；相对路径基于当前工作区，外部路径权限由宿主裁决。',
    whenToUse: '需要理解、检查、引用或修改某个已有文件前，先调用此工具读取文件。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: '工作区相对路径或用户明确指定的绝对路径，例如 src/main/index.ts。' } }
    },
    example: { name: 'read_file', arguments: { path: 'package.json' } }
  },
  write_file: {
    name: 'write_file',
    description: '向文件写入完整内容；不存在的父目录会自动创建，外部路径权限由宿主裁决。',
    whenToUse: '需要创建文件或覆盖更新文件内容时调用。写入前应确认目标路径和内容。',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: '工作区相对路径或用户明确指定的绝对路径。' },
        content: { type: 'string', description: '要写入文件的完整文本内容。' }
      }
    },
    example: { name: 'write_file', arguments: { path: 'notes/todo.txt', content: 'hello' } }
  },
  edit_file: {
    name: 'edit_file',
    description: '精确替换现有文本文件的一段内容，不会创建新文件或覆盖整个文件；外部路径权限由宿主裁决。',
    whenToUse: '已读取目标文件且只需局部修改时调用。old_text 必须与文件内容完全一致；默认要求它只出现一次，多处匹配时必须明确设置 replace_all 为 true。',
    inputSchema: {
      type: 'object',
      required: ['path', 'old_text', 'new_text'],
      properties: {
        path: { type: 'string', description: '现有文本文件的工作区相对路径或用户明确指定的绝对路径。' },
        old_text: { type: 'string', minLength: 1, description: '要替换的原始文本，必须与文件内容完全一致且不能为空。' },
        new_text: { type: 'string', description: '替换后的文本；传空字符串表示删除 old_text。' },
        replace_all: { type: 'boolean', default: false, description: '是否替换所有匹配；默认 false，多处匹配时拒绝执行。' }
      }
    },
    example: { name: 'edit_file', arguments: { path: 'src/app.ts', old_text: 'const port = 3000', new_text: 'const port = 5173', replace_all: false } }
  },
  create_directory: {
    name: 'create_directory',
    description: '创建目录；缺失的父目录会一并创建，外部路径权限由宿主裁决。',
    whenToUse: '需要为新文件、模块或输出结果准备目录时调用。优先使用工作区相对路径；用户明确指定时可使用绝对路径。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: '要创建的工作区相对目录或用户明确指定的绝对目录，例如 output/reports。' } }
    },
    example: { name: 'create_directory', arguments: { path: 'output/reports' } }
  },
  list_files: {
    name: 'list_files',
    description: '列举目录中的文件、子目录、大小和路径；外部路径权限由宿主裁决。',
    whenToUse: '需要了解目录结构、寻找文件或确认输出是否存在时调用；优先使用本工具而不是 run_command 列目录。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列举的工作区相对目录或用户明确指定的绝对目录，默认是工作区根目录。' },
        recursive: { type: 'boolean', description: '是否递归列举子目录，默认 false；结果最多返回 500 项。' }
      }
    },
    example: { name: 'list_files', arguments: { path: 'src', recursive: true } }
  },
  decrypt_file: {
    name: 'decrypt_file',
    description: '将加密文件上传到内部服务进行解密，再把解密副本保存到本地。已验证支持 txt、csv、pdf、docx、xlsx、pptx；联网和外部路径权限由宿主裁决。',
    whenToUse: '用户明确要求解密，文本或 CSV 出现 NUL、乱码、异常二进制内容，或者 Office 解析返回加密相关错误时调用。不要猜测疑似加密文件的内容。默认生成同目录的 *.decrypted.* 文件，不覆盖原始文件；成功后从 output_path 继续读取或解析。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '待解密文件的工作区相对路径或用户明确指定的绝对路径。' },
        output_path: { type: 'string', description: '可选的解密结果路径；不能与原文件相同。' }
      }
    },
    example: { name: 'decrypt_file', arguments: { path: 'documents/report.xlsx', output_path: 'documents/report.decrypted.xlsx' } }
  },
  parse_word: {
    name: 'parse_word',
    description: '在本地解析 Word DOCX 文档，返回保留标题、段落、列表和表格结构的 Markdown；外部路径权限由宿主裁决。',
    whenToUse: '用户要求阅读、总结或提取 Word 文档内容时调用。若企业加密导致解析失败，先调用 decrypt_file 再解析解密结果。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'DOCX 文件的工作区相对路径或用户明确指定的绝对路径。' },
        max_characters: { type: 'number', minimum: 1000, maximum: 120000, description: '最多返回的字符数，默认 60000。' }
      }
    },
    example: { name: 'parse_word', arguments: { path: 'documents/report.docx' } }
  },
  parse_excel: {
    name: 'parse_excel',
    description: '在本地解析 Excel XLSX 工作簿，返回包含工作表和表格数据的 Markdown；外部路径权限由宿主裁决。',
    whenToUse: '用户要求检查、汇总或分析 Excel 工作簿时调用。若企业加密导致解析失败，先调用 decrypt_file 再解析解密结果。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'XLSX 文件的工作区相对路径或用户明确指定的绝对路径。' },
        max_characters: { type: 'number', minimum: 1000, maximum: 120000, description: '最多返回的字符数，默认 60000。' }
      }
    },
    example: { name: 'parse_excel', arguments: { path: 'documents/data.xlsx' } }
  },
  parse_powerpoint: {
    name: 'parse_powerpoint',
    description: '通过内置 PPT MCP 解析 PowerPoint PPTX 文件，返回按幻灯片组织的 Markdown；是否需要确认由宿主权限模式决定。',
    whenToUse: '用户要求阅读、总结或提取 PowerPoint 内容时调用。默认包含演讲者备注；若企业加密导致解析失败，先调用 decrypt_file，再用返回的 output_path 重新解析。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'PPTX 文件的工作区相对路径或用户明确指定的绝对路径。' },
        include_notes: { type: 'boolean', description: '是否包含演讲者备注，默认 true。' },
        max_characters: { type: 'number', minimum: 1000, maximum: 120000, description: '最多返回的字符数，默认 60000。' }
      }
    },
    example: { name: 'parse_powerpoint', arguments: { path: 'documents/slides.pptx', include_notes: true } }
  },
  run_command: {
    name: 'run_command',
    description: '执行命令行程序并返回 stdout/stderr；设置 background=true 时在进程成功创建后立即返回 PID。是否需要确认由宿主根据当前权限模式和风险级别决定。',
    whenToUse: '需要查看本地或 SSH 远程信息、运行测试、构建或执行工程命令时调用。启动 Electron 或其他桌面程序时设置 background=true；只有需要识别 HTTP 地址的 Web 服务才使用 start_service。不要在 Action 前自行请求批准，宿主会在需要时显示交互。创建 Node 项目前先检查 node --version，并选择与当前 Node 引擎兼容的依赖版本；EBADENGINE 后应修正 package.json，不能原样重复安装。禁止用它调用 Python、PowerShell、tar、unzip 或临时脚本解析 Office 文件；Office 必须使用专用解析工具。',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: '可执行文件名，例如 npm、node、git。调用 Node 包管理器时固定传 npm 或 npx，不要传 npm.cmd、npm。cmd 等 Windows 启动名，宿主会自动解析。不要传整段 shell 字符串。' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数数组，例如 ["run", "build"]。' },
        background: { type: 'boolean', default: false, description: '是否在后台启动并在创建进程后立即返回。启动桌面程序时设为 true；测试和构建保持 false。' }
      }
    },
    example: { name: 'run_command', arguments: { command: 'npm', args: ['run', 'build'] } }
  },
  start_service: {
    name: 'start_service',
    description: '在工作区以独立进程启动长驻 Web 服务；检测到 HTTP(S) 地址后立即返回，关闭应用后服务仍会继续运行。是否需要确认由宿主权限模式决定。',
    whenToUse: '需要启动开发服务器、预览服务或本地 HTTP 服务时调用。禁止用 run_command 启动不会自行退出的服务。服务必须在 30 秒内向 stdout 或 stderr 输出完整访问地址。',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: '服务可执行文件名，例如 node、npm。' },
        args: { type: 'array', items: { type: 'string' }, description: '服务参数数组，例如 ["server.js"] 或 ["run", "dev"]。' }
      }
    },
    example: { name: 'start_service', arguments: { command: 'npm', args: ['run', 'dev'] } }
  }
}

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolRegistry, name)
}

export function getEnabledToolDefinitions(enabledTools: string[]): ToolDefinition[] {
  return enabledTools.filter(isToolName).map((name) => toolRegistry[name])
}
