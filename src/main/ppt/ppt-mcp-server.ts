import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { PptProcessingService } from './ppt-processing-service'

const DEFAULT_PORT = 3777
const HOST = '127.0.0.1'

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

export interface RunningPptMcpServer {
  url: string
  close(): Promise<void>
}

export async function startPptMcpServer(getWorkspacePath: (requestedWorkspacePath?: string) => string, port = DEFAULT_PORT): Promise<RunningPptMcpServer> {
  const processingService = new PptProcessingService(getWorkspacePath)
  const sessions = new Map<string, Session>()
  const app = createMcpExpressApp({ host: HOST, allowedHosts: [HOST, 'localhost'] })

  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.headers.origin
    if (origin && !isLocalOrigin(origin)) {
      response.status(403).send('Forbidden origin')
      return
    }
    next()
  })

  app.get('/health', async (_request: Request, response: Response) => {
    response.json({ ok: true, name: 'codext-ppt-processing-mcp', capabilities: await processingService.getCapabilities() })
  })

  app.post('/mcp', async (request: Request, response: Response) => {
    const sessionId = headerValue(request.headers['mcp-session-id'])
    try {
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (!session) {
          sendProtocolError(response, 404, 'Unknown MCP session')
          return
        }
        await session.transport.handleRequest(request, response, request.body)
        return
      }
      if (!isInitializeRequest(request.body)) {
        sendProtocolError(response, 400, 'MCP initialization is required')
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          const session = pendingSession
          if (session) sessions.set(initializedSessionId, session)
        }
      })
      const protocolServer = createProtocolServer(processingService)
      const pendingSession: Session = { transport, server: protocolServer }
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      await protocolServer.connect(transport)
      await transport.handleRequest(request, response, request.body)
    } catch (error) {
      console.error('[ppt mcp request failed]', error)
      if (!response.headersSent) sendProtocolError(response, 500, 'PPT MCP request failed')
    }
  })

  const handleSessionRequest = async (request: Request, response: Response): Promise<void> => {
    const sessionId = headerValue(request.headers['mcp-session-id'])
    const session = sessionId ? sessions.get(sessionId) : undefined
    if (!session) {
      sendProtocolError(response, 400, 'Invalid or missing MCP session')
      return
    }
    await session.transport.handleRequest(request, response)
  }

  const sessionHandler = (request: Request, response: Response): void => {
    void handleSessionRequest(request, response).catch((error) => {
      console.error('[ppt mcp session request failed]', error)
      if (!response.headersSent) sendProtocolError(response, 500, 'PPT MCP request failed')
    })
  }
  app.get('/mcp', sessionHandler)
  app.delete('/mcp', sessionHandler)

  const httpServer = await listen(app, port)
  const address = httpServer.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  return {
    url: 'http://' + HOST + ':' + actualPort + '/mcp',
    async close() {
      await Promise.all([...sessions.values()].map(async (session) => {
        await session.server.close().catch(() => undefined)
        await session.transport.close().catch(() => undefined)
      }))
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    }
  }
}

function createProtocolServer(processingService: PptProcessingService): McpServer {
  const server = new McpServer({ name: 'codext-ppt-processing-mcp', version: '0.1.0' })
  server.registerTool('parse_powerpoint', {
    title: '解析 PowerPoint',
    description: '通过 PPT Processing Service 提取 PPTX 的幻灯片文本、结构和演讲者备注。',
    inputSchema: {
      path: z.string().min(1).describe('工作区内 PPTX 文件的相对路径。'),
      workspace_path: z.string().min(1).optional().describe('由宿主应用授权的会话工作区绝对路径。'),
      include_notes: z.boolean().optional().default(true).describe('是否包含演讲者备注。'),
      max_characters: z.number().int().min(1000).max(120000).optional().describe('最多返回的字符数。')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ path, workspace_path, include_notes, max_characters }) => {
    try {
      const text = await processingService.parse(path, { includeNotes: include_notes, maxCharacters: max_characters }, workspace_path)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  })
  server.registerTool('get_ppt_processing_capabilities', {
    title: '查看 PPT 处理能力',
    description: '返回结构提取、LibreOffice 渲染和 OCR Vision 的可用状态。',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await processingService.getCapabilities(), null, 2) }]
  }))
  return server
}

function isLocalOrigin(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
    return hostname === HOST || hostname === 'localhost'
  } catch {
    return false
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function sendProtocolError(response: Response, status: number, message: string): void {
  response.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })
}

function listen(app: ReturnType<typeof createMcpExpressApp>, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, () => resolve(server))
    server.once('error', reject)
  })
}
