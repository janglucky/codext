import type { TaskStep } from './types'

const HIDDEN_INTERNAL_REASON_TITLES = new Set([
  '已规划工具执行顺序',
  '已补全工具参数',
  '修复工具调用参数',
  '工具调用响应不完整',
  '模型响应为空，正在恢复',
  '模型连接中断，正在恢复',
  '模型响应无效，正在恢复',
  '模型尚未执行所需工具',
  '模型输出格式不正确',
  '整理已有结果',
  '流式响应停顿，改用非流式重试',
  '模型响应中断，正在重试'
])

/** Internal model/protocol recovery is not actionable user-facing progress. */
export function isHiddenInternalAgentStep(step: Pick<TaskStep, 'phase' | 'title'>): boolean {
  return step.phase === 'reason' && HIDDEN_INTERNAL_REASON_TITLES.has(step.title)
}
