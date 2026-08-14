import { describe, expect, it } from 'vitest'
import { isHiddenInternalAgentStep } from '../src/shared/agent-steps'

describe('agent step visibility', () => {
  it('hides model and protocol recovery details', () => {
    const hiddenTitles = [
      '修复工具调用参数',
      '工具调用响应不完整',
      '模型响应无效，正在恢复',
      '模型输出格式不正确',
      '流式响应停顿，改用非流式重试',
      '整理已有结果'
    ]

    for (const title of hiddenTitles) {
      expect(isHiddenInternalAgentStep({ phase: 'reason', title })).toBe(true)
    }
  })

  it('keeps thoughts, user decisions, compression, actions and tool failures visible', () => {
    expect(isHiddenInternalAgentStep({ phase: 'reason', title: '思考过程' })).toBe(false)
    expect(isHiddenInternalAgentStep({ phase: 'reason', title: '用户已选择方案' })).toBe(false)
    expect(isHiddenInternalAgentStep({ phase: 'reason', title: '已完成上下文压缩' })).toBe(false)
    expect(isHiddenInternalAgentStep({ phase: 'act', title: '正在执行工具：run_command' })).toBe(false)
    expect(isHiddenInternalAgentStep({ phase: 'act', title: 'Observation #3：run_command' })).toBe(false)
  })
})
