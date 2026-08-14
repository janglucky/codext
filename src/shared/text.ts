export function normalizeTechnicalPunctuation(value: string): string {
  return value
    .replace(/([A-Za-z0-9_/@\\-])。(?=[A-Za-z0-9_/@\\-])/g, '$1.')
    .replace(/([A-Za-z0-9_])，(?=[A-Za-z0-9_])/g, '$1,')
    .replace(/([A-Za-z0-9_])；(?=[A-Za-z0-9_])/g, '$1;')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*)：(?=\/\/)/g, '$1:')
    .replace(/([A-Za-z])：(?=[/\\])/g, '$1:')
    .replace(/([A-Za-z0-9_])：(?=[A-Za-z0-9_])/g, '$1:')
}

/** Remove internal ReAct turn labels before model thoughts reach user-facing UI. */
export function hideReactObservationReferences(value: string): string {
  return value
    .replace(/[（(]\s*Observation\s*#\s*\d+\s*[）)]/gi, '')
    .replace(/\s*\bObservation\s*#\s*\d+\b\s*/gi, '工具结果')
    .replace(/\s+([，。；、,.!?！？])/g, '$1')
}

/** Return true for host-only recovery markers that must never reach chat UI. */
export function isInternalAgentPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  if (normalized === '[REACT_PROTOCOL_DRIFT]') return true
  return /^\[(?:上一条(?:工具调用|\s*[^\]\r\n]*?Action|响应)|该(?:工具调用|命令)|模型重复调用)[^\]\r\n]*(?:未执行|未再次执行|未作为\s*Final|停止重复执行)[^\]\r\n]*\]$/i.test(normalized)
}
