import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelFetch, resolveModelProxyUrl } from '../src/main/model-fetch'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('model proxy selection', () => {
  it('prefers HTTPS_PROXY for HTTPS model endpoints', () => {
    expect(resolveModelProxyUrl('https://api.example.com/v1', {
      HTTPS_PROXY: 'http://secure-proxy:7890',
      HTTP_PROXY: 'http://plain-proxy:7890'
    })).toBe('http://secure-proxy:7890')
  })

  it('prefers HTTP_PROXY for HTTP model endpoints', () => {
    expect(resolveModelProxyUrl('http://model.example.com/v1', {
      HTTPS_PROXY: 'http://secure-proxy:7890',
      HTTP_PROXY: 'http://plain-proxy:7890'
    })).toBe('http://plain-proxy:7890')
  })

  it('falls back to ALL_PROXY', () => {
    expect(resolveModelProxyUrl('https://api.example.com/v1', {
      ALL_PROXY: 'http://fallback-proxy:7890'
    })).toBe('http://fallback-proxy:7890')
  })

  it('allows direct requests when no proxy is configured', () => {
    expect(resolveModelProxyUrl('https://api.example.com/v1', {})).toBeUndefined()
  })

  it('uses the global fetch implementation with a proxy dispatcher', async () => {
    const response = { ok: true } as Response
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubEnv('HTTPS_PROXY', 'http://model-proxy:7890')
    vi.stubGlobal('fetch', fetchMock)

    await expect(modelFetch('https://api.example.com/v1/chat/completions', { method: 'POST' })).resolves.toBe(response)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]).toHaveProperty('dispatcher')
  })
})
