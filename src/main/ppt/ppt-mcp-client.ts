export class PptMcpClient {
  constructor(private readonly serverUrl: string) {}

  async parsePowerPoint(args: Record<string, unknown>): Promise<string> {
    if (!this.serverUrl.trim()) throw new Error('PPT MCP 地址不可用。')
    const url = new URL(this.serverUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('PPT MCP 仅支持 HTTP(S) 地址。')

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const client = new Client({ name: 'codext-ppt-agent', version: '0.1.0' })
    const transport = new StreamableHTTPClientTransport(url)
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      if (!tools.tools.some((tool) => tool.name === 'parse_powerpoint')) throw new Error('PPT MCP 未提供 parse_powerpoint 工具。')
      const result = await client.callTool({ name: 'parse_powerpoint', arguments: args })
      const text = (Array.isArray(result.content) ? result.content : [])
        .filter(isTextContent)
        .map((item) => item.text)
        .join('\n')
        .trim()
      const fallback = result.structuredContent ? JSON.stringify(result.structuredContent) : 'PPT MCP 没有返回内容。'
      if (result.isError) throw new Error(text || fallback)
      return text || fallback
    } finally {
      await client.close().catch(() => undefined)
    }
  }
}

function isTextContent(value: unknown): value is { type: 'text'; text: string } {
  return Boolean(value && typeof value === 'object' && 'type' in value && value.type === 'text' && 'text' in value && typeof value.text === 'string')
}
