export type ToolName = 'read_file' | 'write_file' | 'run_command'
export type ToolArguments = { path?: string; content?: string; command?: string; args?: string[] }
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
  run_command: {
    name: 'run_command',
    description: '在工作区目录下执行安全的命令行程序，并返回 stdout/stderr。',
    whenToUse: '需要运行测试、构建、查看目录或执行非破坏性命令时调用。不要用来删除、格式化、关机或修改注册表。',
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
