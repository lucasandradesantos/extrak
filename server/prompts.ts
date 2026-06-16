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
10. Questões em aberto (liste os gaps de severidade média/baixa não resolvidos)

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

  const abertosNaoAltos = gaps.filter(
    (g) => g.status !== "resolvido" && !respostas?.[g.id]?.trim()
  );
  if (abertosNaoAltos.length > 0) {
    parts.push(
      "\n\n# Gaps ainda em aberto (use [A DEFINIR — depende de ...] nas seções afetadas)\n"
    );
    for (const gap of abertosNaoAltos) {
      parts.push(
        `\n- [${gap.severidade}] [${gap.localizacao}] ${gap.titulo}: ${gap.descricao}`
      );
    }
  }

  parts.push("\n\nEscreva agora o PRD completo em markdown seguindo a regra de ouro.");

  return parts.join("\n");
}
