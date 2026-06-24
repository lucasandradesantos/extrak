export interface QaDocValidation {
  complete: boolean;
  issues: string[];
}

/** Valida se o documento de QA está completo o suficiente para envio ao cliente. */
export function validateQaTestCasesDoc(content: string): QaDocValidation {
  const issues: string[] = [];
  const trimmed = content.trim();

  if (!trimmed) {
    return { complete: false, issues: ["Documento vazio."] };
  }

  if (!/^##\s+1\.\s+Contexto/m.test(trimmed)) {
    issues.push("Seção 1 (Contexto) ausente.");
  }
  if (!/^##\s+2\.\s+Mapa/m.test(trimmed)) {
    issues.push("Seção 2 (Mapa de módulos) ausente.");
  }
  if (!/^##\s+3\.\s+Premissas/m.test(trimmed)) {
    issues.push("Seção 3 (Premissas e Pontos em Aberto) ausente.");
  }
  if (!/^##\s+4\.\s+Casos de Teste/m.test(trimmed)) {
    issues.push("Seção 4 (Casos de Teste) ausente.");
  }
  if (!/^##\s+5\./m.test(trimmed)) {
    issues.push("Seção 5 (Checklist de cobertura) ausente.");
  }

  const ctCount = [...trimmed.matchAll(/###\s+CT\d+/gi)].length;
  if (ctCount === 0) {
    issues.push("Nenhum caso de teste (CT###) encontrado.");
  }

  const hasSec3 = /^##\s+3\.\s+Premissas/m.test(trimmed);
  const hasSec4 = /^##\s+4\.\s+Casos/m.test(trimmed);
  if (hasSec3 && !hasSec4) {
    issues.push("Geração interrompida após a seção 3 — faltam os casos de teste.");
  }

  const lastLine = trimmed.split("\n").pop()?.trim() ?? "";
  if (
    lastLine &&
    !/^##/.test(lastLine) &&
    !/^---$/.test(lastLine) &&
    !/[.!?;:)\]]$/.test(lastLine) &&
    !/^\|/.test(lastLine) &&
    /^\s*-\s+\S/.test(lastLine) &&
    lastLine.length < 120
  ) {
    issues.push("Documento parece truncado (última linha incompleta).");
  }

  return { complete: issues.length === 0, issues };
}
