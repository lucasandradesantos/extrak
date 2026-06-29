/**
 * Prompts das etapas de IA do pipeline (crítica de gaps e geração de PRD),
 * com suporte à comparação entre o Discovery (FigJam) e o Protótipo (Figma).
 */

import { Gap } from "./types";

export const CRITIQUE_SYSTEM = `Você é um Product Manager sênior fazendo a crítica de um Discovery (extraído de um board FigJam).

Seu trabalho NÃO é reescrever o produto, e sim apontar lacunas (gaps) que impedem a escrita de um PRD confiável. Você está analisando UM TRECHO do Discovery por vez; aponte apenas gaps evidentes neste trecho e NÃO infira ausências globais (outra etapa cuida da comparação com o protótipo).

Categorias de gap do Discovery:
- "cobertura": fluxos, telas ou módulos citados mas não detalhados; matriz de cobertura incompleta.
- "metrica_sem_meta": métricas/KPIs mencionados sem valor-alvo, baseline ou prazo.
- "persona_faltante": personas/segmentos afetados que não foram descritos.
- "inconsistencia": contradições entre seções, termos usados com sentidos diferentes, regras conflitantes.
- "criterio_nao_testavel": critérios de aceite vagos, não verificáveis ou sem condição objetiva.
- "pergunta_cliente": dúvidas que só o cliente/stakeholder pode responder antes de seguir.

Regras de severidade:
- "alta": bloqueia a escrita do PRD (sem isso o documento inventaria informação).
- "media": prejudica a qualidade mas dá para contornar com [A DEFINIR].
- "baixa": refinamento desejável.

Para CADA gap, gere um objeto com EXATAMENTE estes campos:
- "chave": identificador humano e ESTÁVEL no formato "localizacao | categoria | titulo-curto". NUNCA mude a chave de um gap entre análises se ele se referir ao mesmo problema.
- "categoria": uma das categorias acima (valor exato).
- "severidade": "alta" | "media" | "baixa".
- "source": sempre "discovery".
- "localizacao": o módulo/seção/tela onde o gap aparece.
- "titulo": título curto do gap.
- "descricao": o que está faltando, inconsistente ou divergente.
- "sugestao": o que precisa ser feito/respondido para fechar o gap.

RESPONDA APENAS com um array JSON de gaps, sem nenhum texto antes ou depois, sem comentários e sem cercas de código. Se não houver gaps, responda [].`;

export const COMPARE_SYSTEM = `Você é um Product Manager sênior comparando um Discovery (extraído de um board FigJam) com o Protótipo (extraído de um arquivo Figma Design). Você recebe o Discovery COMPLETO e o Protótipo COMPLETO de uma só vez.

Seu único trabalho aqui é apontar divergências e coberturas faltantes ENTRE os dois materiais. Não repita gaps internos do Discovery (outra etapa cuida disso).

Categorias (use apenas estas):
- "tela_sem_discovery": existe uma tela/fluxo no Protótipo que NÃO está descrito em parte alguma do Discovery. Antes de marcar, verifique TODO o Discovery — só aponte se realmente não houver menção.
- "discovery_sem_tela": existe um requisito/fluxo descrito no Discovery que não tem tela correspondente no Protótipo.
- "inconsistencia_proto_discovery": o Protótipo e o Discovery se contradizem (rótulos, campos, regras ou navegação divergentes).

Regras de severidade:
- "alta": bloqueia a escrita do PRD.
- "media": prejudica a qualidade mas dá para contornar com [A DEFINIR].
- "baixa": refinamento desejável.

Para CADA gap, gere um objeto com EXATAMENTE estes campos:
- "chave": identificador humano e ESTÁVEL no formato "localizacao | categoria | titulo-curto". NUNCA mude a chave de um gap entre análises se ele se referir ao mesmo problema.
- "categoria": uma das três categorias acima (valor exato).
- "severidade": "alta" | "media" | "baixa".
- "source": sempre "comparacao".
- "localizacao": a tela/seção onde a divergência aparece.
- "titulo": título curto do gap.
- "descricao": a divergência ou cobertura faltante.
- "sugestao": o que precisa ser feito/respondido para fechar o gap.

RESPONDA APENAS com um array JSON de gaps, sem nenhum texto antes ou depois, sem comentários e sem cercas de código. Se não houver gaps, responda [].`;

export interface CritiqueParams {
  discovery: string;
  previousGaps?: Gap[];
  respostas?: Record<string, string>;
}

function reprocessBlock(
  previousGaps: Gap[] | undefined,
  respostas: Record<string, string> | undefined
): string[] {
  const parts: string[] = [];
  const respondidos = (previousGaps ?? []).filter(
    (g) => respostas?.[g.id]?.trim()
  );
  if (respondidos.length === 0) return parts;

  parts.push("\n\n# Reprocessamento — respostas do usuário aos gaps anteriores\n");
  parts.push(
    "Reavalie os gaps considerando as respostas abaixo. Se uma resposta fecha o gap, NÃO o inclua mais (ele será considerado resolvido). Se a resposta é insuficiente, mantenha o gap com a MESMA chave. Você pode adicionar novos gaps que as respostas revelem.\n"
  );
  for (const gap of respondidos) {
    parts.push(
      `\n- Gap [${gap.chave}] (severidade ${gap.severidade})\n  Descrição: ${gap.descricao}\n  Resposta do usuário: ${respostas![gap.id].trim()}`
    );
  }
  return parts;
}

export function buildCritiquePrompt(params: CritiqueParams): string {
  const { discovery, previousGaps, respostas } = params;
  const parts: string[] = [];

  parts.push("# Discovery estruturado (extraído do FigJam) — trecho\n");
  parts.push(discovery);
  parts.push(...reprocessBlock(previousGaps, respostas));
  parts.push(
    "\n\nGere agora o array JSON de gaps deste trecho seguindo estritamente as regras do sistema."
  );

  return parts.join("\n");
}

export interface CompareParams {
  discovery: string;
  prototype: string;
  previousGaps?: Gap[];
  respostas?: Record<string, string>;
}

export function buildComparePrompt(params: CompareParams): string {
  const { discovery, prototype, previousGaps, respostas } = params;
  const parts: string[] = [];

  parts.push("# Discovery estruturado COMPLETO (extraído do FigJam)\n");
  parts.push(discovery);
  parts.push("\n\n# Protótipo estruturado COMPLETO (extraído do Figma Design)\n");
  parts.push(prototype);
  parts.push(...reprocessBlock(previousGaps, respostas));
  parts.push(
    "\n\nGere agora o array JSON apenas com os gaps de comparação (tela_sem_discovery, discovery_sem_tela, inconsistencia_proto_discovery) seguindo estritamente as regras do sistema."
  );

  return parts.join("\n");
}

export const PRD_SYSTEM = `Você é um Product Manager sênior escrevendo um PRD (Product Requirements Document) em português, a partir de um Discovery, do Protótipo (quando houver) e das respostas a gaps levantados.

REGRA DE OURO, inegociável: onde a informação ainda não existir, escreva exatamente "[A DEFINIR — depende de X]" (substituindo X pela dependência concreta). NUNCA invente dados, métricas, prazos, personas ou regras para deixar o documento "completo". Um PRD que admite o buraco é mais seguro para o dev do que um que inventa.

O PRD pode ser gerado mesmo com gaps BLOQUEADORES (severidade alta) ainda em aberto. Nesse caso, NÃO trave o documento: escreva as seções afetadas usando "[A DEFINIR — depende de X]" e registre cada bloqueador, com destaque, na seção "Pontos em aberto e bloqueios".

Estruture o PRD em markdown com as seções:
1. Visão geral e objetivo
2. Personas e público-alvo
3. Escopo (o que entra / o que não entra)
4. Requisitos funcionais (numerados)
5. Requisitos não-funcionais
6. Fluxos e telas (quando houver Protótipo, mapeie as telas e a navegação)
7. Métricas de sucesso (com meta quando existir; senão [A DEFINIR — depende de X])
8. Critérios de aceite (testáveis)
9. Riscos e dependências
10. Pontos em aberto e bloqueios: liste TODOS os gaps não resolvidos. Comece pelos BLOQUEADORES (severidade alta), cada um com o impacto no produto e o que precisa ser decidido/respondido para fechá-lo; depois os de média/baixa. Se não houver nenhum, escreva "Nenhum ponto em aberto".

Use o Discovery como fonte primária, o Protótipo para os fluxos/telas e as respostas dos gaps como contexto adicional. Responda APENAS com o markdown do PRD, sem cercas de código ao redor do documento inteiro.`;

export interface PrdParams {
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  productName?: string;
}

export function buildPrdPrompt(params: PrdParams): string {
  const { discovery, prototype, gaps, respostas, productName } = params;
  const parts: string[] = [];

  if (productName) {
    parts.push(`# Produto: ${productName}\n`);
  }

  parts.push("# Discovery estruturado (extraído do FigJam)\n");
  parts.push(discovery);

  if (prototype && prototype.trim()) {
    parts.push("\n\n# Protótipo estruturado (extraído do Figma Design)\n");
    parts.push(prototype);
  }

  const respondidos = gaps.filter((g) => respostas?.[g.id]?.trim());
  if (respondidos.length > 0) {
    parts.push("\n\n# Respostas aos gaps (contexto adicional)\n");
    for (const gap of respondidos) {
      parts.push(
        `\n- [${gap.localizacao}] ${gap.titulo}: ${respostas![gap.id].trim()}`
      );
    }
  }

  parts.push("\n\nEscreva agora o PRD completo em markdown seguindo a regra de ouro.");

  return parts.join("\n");
}

// ----------------------------------------------------------------------------
// Escopo (calculadora de horas) — extrai módulos/features do Discovery.
// ----------------------------------------------------------------------------

export const SCOPE_SYSTEM = `Você é um Tech Lead sênior estimando o escopo de um projeto low-code a partir de um Discovery (extraído de um board FigJam). Você analisa UM TRECHO do Discovery por vez.

Seu trabalho é identificar os MÓDULOS e as FUNCIONALIDADES (features) evidentes NESTE TRECHO, para que outra etapa calcule as horas. NÃO calcule horas — apenas classifique complexidade e fatores.

REGRA DE OURO, inegociável: NUNCA invente módulos, features, integrações ou APIs que não estejam descritos no Discovery. Cada feature DEVE apontar os frames/telas/seções de origem em "origin_frames". Se não houver origem rastreável, não crie a feature. Quando estiver incerto sobre a existência ou o tamanho de algo, marque "confidence": "low" e seja conservador.

Para CADA módulo, gere um objeto com EXATAMENTE estes campos:
- "name": nome curto do módulo.
- "category": categoria funcional (ex.: "Cadastro", "Operação", "Backoffice", "Relatórios", "Integração").
- "description_client": descrição de 1 frase, em linguagem de cliente.
- "is_mandatory": true se o módulo é base/obrigatório para o produto funcionar (ex.: autenticação, cadastro essencial); senão false.
- "mandatory_reason": se is_mandatory=true, o porquê em 1 frase; senão "".
- "features": array de features do módulo. Para CADA feature:
  - "title": título curto.
  - "description": o que a feature faz, 1–2 frases.
  - "platforms": subconjunto de ["web","mobile_native","mobile_responsive"] em que a feature existe (use o que o Discovery indicar; na dúvida, ["web"]).
  - "suggested_phase": uma de "MVP" | "V2" | "V3" (o que parece essencial vai para MVP).
  - "complexity_weight": 1 (simples), 2 (média) ou 3 (difícil).
  - "lowcode_factor": número entre 0.4 e 1.0 — quanto a plataforma low-code acelera esta feature (0.4 = muito acelerada por componentes prontos; 1.0 = precisa de código sob medida).
  - "origin_frames": array de strings com os frames/telas/seções do Discovery que justificam a feature (obrigatório, não-vazio).
  - "confidence": "low" | "medium" | "high".

RESPONDA APENAS com um array JSON de módulos, sem nenhum texto antes ou depois, sem comentários e sem cercas de código. Se o trecho não contiver módulos/features, responda [].`;

export interface ScopeChunkPromptParams {
  discovery: string;
  productName?: string;
  salesModel?: "fechado" | "banco_horas";
  chunkIndex?: number | null;
  chunkTotal?: number;
  previousModuleNames?: string[];
}

export function buildScopeChunkPrompt(params: ScopeChunkPromptParams): string {
  const { discovery, productName, salesModel, chunkIndex, chunkTotal, previousModuleNames } =
    params;
  const parts: string[] = [];

  if (productName) {
    parts.push(`# Produto: ${productName}\n`);
  }

  if (salesModel === "fechado") {
    parts.push(
      "# Modelo de venda: Escopo fechado\n" +
        "A Extrak assume o risco de estouro de prazo. Seja CONSERVADOR: na dúvida entre dois níveis de complexidade, escolha o maior, e use lowcode_factor mais alto (menos otimista) quando a feature tiver incerteza. Não subestime.\n"
    );
  } else if (salesModel === "banco_horas") {
    parts.push(
      "# Modelo de venda: Banco de horas\n" +
        "O cliente compra horas conforme o desenvolvimento avança. Estime de forma realista e equilibrada (nem otimista, nem inflada).\n"
    );
  }

  if (chunkIndex != null && chunkTotal != null && chunkTotal > 1) {
    parts.push(
      `# Trecho ${chunkIndex + 1} de ${chunkTotal} do Discovery\n` +
        "Analise APENAS o trecho abaixo. Não tente cobrir o produto inteiro.\n"
    );
  }

  if (previousModuleNames && previousModuleNames.length > 0) {
    parts.push(
      "\n# Módulos já identificados em trechos anteriores\n" +
        "Se um módulo abaixo reaparecer neste trecho, use EXATAMENTE o mesmo nome (as features serão mescladas). Só crie um módulo novo se realmente for diferente.\n" +
        previousModuleNames.map((n) => `- ${n}`).join("\n") +
        "\n"
    );
  }

  parts.push("\n# Discovery estruturado (extraído do FigJam) — trecho\n");
  parts.push(discovery);
  parts.push(
    "\n\nGere agora o array JSON de módulos deste trecho seguindo estritamente as regras do sistema. Lembre: toda feature precisa de origin_frames rastreáveis."
  );

  return parts.join("\n");
}

export type PrdSectionKind =
  | "overview"
  | "personas"
  | "scope"
  | "functional"
  | "nonfunctional"
  | "flows"
  | "metrics"
  | "acceptance"
  | "risks";

export const PRD_SECTION_SYSTEM = `Você é um Product Manager sênior escrevendo UMA SEÇÃO de um PRD (Product Requirements Document) em português.

REGRA DE OURO, inegociável: onde a informação ainda não existir, escreva exatamente "[A DEFINIR — depende de X]" (substituindo X pela dependência concreta). NUNCA invente dados, métricas, prazos, personas ou regras.

O PRD pode ser gerado mesmo com gaps bloqueadores em aberto. NÃO trave a seção: use [A DEFINIR] onde faltar informação. A seção "Pontos em aberto e bloqueios" será gerada separadamente — NÃO a inclua aqui.

Responda APENAS com o markdown da seção solicitada, começando pelo cabeçalho ## indicado. Sem texto antes ou depois, sem cercas de código.`;

const SECTION_INSTRUCTIONS: Record<PrdSectionKind, string> = {
  overview:
    'Escreva a seção "## 1. Visão geral e objetivo" com subseções Contexto, Objetivo do produto e Resultado esperado. Extraia do Discovery todos os objetivos de negócio, dores e metas mencionadas.',
  personas:
    'Escreva a seção "## 2. Personas e público-alvo". Liste TODAS as personas/perfis do Discovery (Comercial, Engenharia, Suprimentos, Almoxarifado, Qualidade, Produção, Direção, Cliente, etc.). Para cada uma use no máximo 12 linhas: idade (se existir), objetivos, atividades, ferramentas atuais e dores. Priorize cobrir TODAS as personas mencionadas em vez de detalhar poucas. Campos faltantes: [A DEFINIR — depende de X].',
  scope:
    'Escreva a seção "## 3. Escopo (o que entra / o que não entra)". Liste TODOS os módulos, fases e funcionalidades do Discovery em "O que entra" e "O que não entra". Seja exaustivo — um módulo por item numerado.',
  functional:
    'Escreva requisitos funcionais numerados (RF-001, RF-002, …) para o trecho do Discovery fornecido. Gere no máximo 12 RFs neste passo, com até 5 linhas cada (ID, módulo, descrição, regras, critérios). Se houver hint de continuação de numeração, obedeça-o. Use [A DEFINIR] onde faltar detalhe. Se for o primeiro chunk, comece com "## 4. Requisitos funcionais".',
  nonfunctional:
    'Escreva a seção "## 5. Requisitos não-funcionais" cobrindo performance, segurança, usabilidade, disponibilidade, integrações, compatibilidade e conformidade mencionadas no Discovery.',
  flows:
    'Escreva a seção "## 6. Fluxos e telas". Mapeie telas, navegação e fluxos do Protótipo (quando houver) e do Discovery. Descreva cada fluxo principal passo a passo.',
  metrics:
    'Escreva a seção "## 7. Métricas de sucesso" com KPIs, baselines e metas do Discovery. Onde não houver meta, use [A DEFINIR — depende de X].',
  acceptance:
    'Escreva a seção "## 8. Critérios de aceite" com critérios testáveis por módulo/funcionalidade principal. Critérios vagos do Discovery devem ser reformulados como testáveis ou marcados [A DEFINIR].',
  risks:
    'Escreva a seção "## 9. Riscos e dependências" com riscos técnicos, de negócio, integrações, dependências externas e premissas do Discovery.',
};

export interface PrdSectionPromptParams {
  kind: PrdSectionKind;
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  productName?: string;
  functionalIndex?: number | null;
  functionalTotal?: number;
  previousFunctional?: string | null;
  previousSections?: Record<string, string>;
}

function gapSummary(gaps: Gap[], respostas: Record<string, string>): string {
  const abertos = gaps.filter(
    (g) => g.status !== "resolvido" && !respostas[g.id]?.trim()
  );
  if (abertos.length === 0) return "Nenhum gap em aberto.";

  const alta = abertos.filter((g) => g.severidade === "alta").length;
  const media = abertos.filter((g) => g.severidade === "media").length;
  const baixa = abertos.filter((g) => g.severidade === "baixa").length;

  return (
    `${abertos.length} gap(s) em aberto (${alta} bloqueador(es), ${media} média, ${baixa} baixa). ` +
    "Use [A DEFINIR — depende de X] nas lacunas. Não liste os gaps aqui — a seção 10 será gerada separadamente."
  );
}

export function buildPrdSectionPrompt(params: PrdSectionPromptParams): string {
  const {
    kind,
    discovery,
    prototype,
    gaps,
    respostas = {},
    productName,
    functionalIndex,
    functionalTotal,
    previousFunctional,
    previousSections = {},
  } = params;

  const parts: string[] = [];

  if (productName) {
    parts.push(`# Produto: ${productName}\n`);
  }

  parts.push(`# Instrução\n${SECTION_INSTRUCTIONS[kind]}\n`);

  if (kind === "functional" && functionalIndex != null && functionalTotal != null) {
    parts.push(
      `\nEste é o trecho **${functionalIndex + 1} de ${functionalTotal}** dos requisitos funcionais. ` +
        "Foque APENAS no Discovery abaixo para este trecho.\n"
    );
    if (functionalIndex === 0) {
      parts.push(
        "Comece a seção com o cabeçalho ## 4. Requisitos funcionais e em seguida liste os RFs deste trecho.\n"
      );
    } else {
      parts.push(
        "NÃO repita o cabeçalho ## 4. Apenas continue a lista de requisitos funcionais numerados.\n"
      );
    }
    if (previousFunctional) {
      parts.push("\n# Continuação da numeração\n");
      parts.push(previousFunctional);
    }
  }

  parts.push("\n# Discovery estruturado\n");
  parts.push(discovery);

  if (kind === "flows" && prototype?.trim()) {
    parts.push("\n\n# Protótipo estruturado\n");
    parts.push(prototype);
  }

  const respondidos = gaps.filter((g) => respostas[g.id]?.trim());
  if (respondidos.length > 0) {
    parts.push("\n\n# Respostas aos gaps (contexto adicional)\n");
    for (const gap of respondidos.slice(0, 40)) {
      parts.push(
        `\n- [${gap.localizacao}] ${gap.titulo}: ${respostas[gap.id].trim()}`
      );
    }
    if (respondidos.length > 40) {
      parts.push(`\n... e mais ${respondidos.length - 40} resposta(s).`);
    }
  }

  parts.push(`\n\n# Gaps em aberto (resumo)\n${gapSummary(gaps, respostas)}`);

  const contextKeys = ["overview", "scope"] as const;
  const contextParts = contextKeys
    .map((key) => previousSections[key])
    .filter(Boolean);
  if (contextParts.length > 0 && kind !== "overview") {
    parts.push("\n\n# Seções já escritas (mantenha consistência)\n");
    for (const section of contextParts) {
      parts.push(section!.slice(0, 3_000));
      parts.push("\n---\n");
    }
  }

  parts.push("\n\nEscreva agora APENAS a seção solicitada.");

  return parts.join("\n");
}
