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
