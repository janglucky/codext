export function normalizeTechnicalPunctuation(value: string): string {
  return value
    .replace(/([A-Za-z0-9_/@\\-])。(?=[A-Za-z0-9_/@\\-])/g, '$1.')
    .replace(/([A-Za-z0-9_])，(?=[A-Za-z0-9_])/g, '$1,')
    .replace(/([A-Za-z0-9_])；(?=[A-Za-z0-9_])/g, '$1;')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*)：(?=\/\/)/g, '$1:')
    .replace(/([A-Za-z])：(?=[/\\])/g, '$1:')
    .replace(/([A-Za-z0-9_])：(?=[A-Za-z0-9_])/g, '$1:')
}
