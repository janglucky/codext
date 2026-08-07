import type { AppSettings, ModelConfig, ModelProfile } from './types'

export const LEGACY_MODEL_ID = 'default-model'
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384

export function getModelProfiles(settings: AppSettings): ModelProfile[] {
  if (settings.models?.length) return settings.models
  return [{ id: settings.defaultModelId || LEGACY_MODEL_ID, name: settings.model.model || '默认模型', provider: 'OpenAI 兼容', ...settings.model }]
}

export function getDefaultModelProfile(settings: AppSettings): ModelProfile {
  const profiles = getModelProfiles(settings)
  return profiles.find((profile) => profile.id === settings.defaultModelId) ?? profiles[0]
}

export function resolveModelProfile(settings: AppSettings, modelId?: string): ModelProfile {
  const profiles = getModelProfiles(settings)
  return profiles.find((profile) => profile.id === modelId) ?? getDefaultModelProfile(settings)
}

export function modelConfig(profile: ModelProfile): ModelConfig {
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    maxRetries: profile.maxRetries,
    contextWindowTokens: profile.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  }
}

export function modelDisplayName(profile: ModelProfile): string {
  return profile.model.trim() || profile.name.trim() || '未配置模型'
}
