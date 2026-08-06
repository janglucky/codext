import { ProxyAgent } from 'undici'

type ModelRequestInit = {
  method?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  body?: string
}

const proxyAgents = new Map<string, ProxyAgent>()

export function resolveModelProxyUrl(endpoint: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const protocol = new URL(endpoint).protocol
  const keys = protocol === 'https:'
    ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']
    : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy']

  for (const key of keys) {
    const value = environment[key]?.trim()
    if (value) return value
  }
  return undefined
}

export function modelFetch(endpoint: string, init: ModelRequestInit): Promise<Response> {
  const proxyUrl = resolveModelProxyUrl(endpoint)
  if (!proxyUrl) return fetch(endpoint, init)

  const parsedProxy = new URL(proxyUrl)
  if (parsedProxy.protocol !== 'http:' && parsedProxy.protocol !== 'https:') {
    throw new Error('模型代理仅支持 HTTP 或 HTTPS 地址，当前配置为：' + parsedProxy.protocol)
  }

  let dispatcher = proxyAgents.get(proxyUrl)
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxyUrl)
    proxyAgents.set(proxyUrl, dispatcher)
  }
  return fetch(endpoint, { ...init, dispatcher } as RequestInit)
}
