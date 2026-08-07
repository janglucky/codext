import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, getDefaultModelProfile, getModelProfiles, modelConfig, resolveModelProfile } from '../src/shared/models'
import type { AppSettings } from '../src/shared/types'

const baseSettings: AppSettings = {
  model: { baseUrl: 'https://legacy.example/v1', apiKey: 'legacy', model: 'legacy-model', timeoutMs: 300000, maxRetries: 1 },
  skillsEnabled: true,
  navigation: { fileApplicationPath: '', browserApplicationPath: '' }
}

describe('model profiles', () => {
  it('migrates a legacy single model into one profile', () => {
    const profiles = getModelProfiles(baseSettings)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ id: 'default-model', name: 'legacy-model', provider: 'OpenAI 兼容', model: 'legacy-model' })
    expect(getDefaultModelProfile(baseSettings).model).toBe('legacy-model')
    expect(modelConfig(profiles[0])).toMatchObject({ contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS })
  })

  it('resolves a conversation model and falls back to default', () => {
    const settings: AppSettings = {
      ...baseSettings,
      models: [
        { id: 'one', name: '一个', provider: '厂商一', ...baseSettings.model, model: 'one-model' },
        { id: 'two', name: '两个', provider: '厂商二', ...baseSettings.model, model: 'two-model' }
      ],
      defaultModelId: 'two'
    }
    expect(resolveModelProfile(settings, 'one').model).toBe('one-model')
    expect(resolveModelProfile(settings, 'one').provider).toBe('厂商一')
    expect(resolveModelProfile(settings, 'missing').model).toBe('two-model')
  })
})
