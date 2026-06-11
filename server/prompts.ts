/**
 * Prompts das etapas de IA do pipeline.
 *
 * Estes são prompts padrão, baseados nas categorias de crítica do produto.
 * Substitua o conteúdo de CRITIQUE_SYSTEM e PRD_SYSTEM pelos seus prompts
 * definitivos sem precisar tocar no resto do servidor.
 */

import { Gap } from "./types";

export const CRITIQUE_SYSTEM = `Você é um Product Manager sênior fazendo a crítica de um Discovery extraído de um board FigJam.

Seu trabalho NÃO é reescrever o produto, e sim apontar lacunas (gaps) que impedem a escrita de um PRD confiável. Analise o Discovery sob estas 6 categorias:

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
- "categoria": uma das 6 acima (valor exato).
- "severidade": "alta" | "media" | "baixa".
- "localizacao": o módulo/seção do board onde o gap aparece (use os caminhos do Discovery).
- "titulo": título curto do gap.
- "descricao": o que está faltando ou inconsistente.
- "sugestao": o que precisa ser feito/respondido para fechar o gap.

RESPONDA APENAS com um array JSON de gaps, sem nenhum texto antes ou depois, sem comentários e sem cercas de código. Se não houver gaps, responda [].`;

export function buildCritiquePrompt(
  discovery: string,
  previousGaps?: Gap[],
  respostas?: Record<string, string>
): string {
  const parts: string[] = [];

  parts.push("# Discovery estruturado (extraído do FigJam)\n");
  parts.push(discovery);

  const respondidos = (previousGaps ?? []).filter(
    (g) => respostas?.[g.id]?.trim()
  );

  if (respondidos.length > 0) {
    parts.push(
      "\n\n# Reprocessamento — respostas do usuário aos gaps anteriores\n"
    );
    parts.push(
      "Reavalie os gaps considerando as respostas abaixo. Se uma resposta fecha o gap, NÃO o inclua mais (ele será considerado resolvido). Se a resposta é insuficiente, mantenha o gap com a MESMA chave. Você pode adicionar novos gaps que as respostas revelem.\n"
    );
    for (const gap of respondidos) {
      parts.push(
        `\n- Gap [${gap.chave}] (severidade ${gap.severidade})\n  Descrição: ${gap.descricao}\n  Resposta do usuário: ${respostas![gap.id].trim()}`
      );
    }
  }

  parts.push(
    "\n\nGere agora o array JSON de gaps remanescentes seguindo estritamente as regras do sistema."
  );

  return parts.join("\n");
}

export const PRD_SYSTEM = `Você é um Product Manager sênior escrevendo um PRD (Product Requirements Document) em português, a partir de um Discovery e das respostas a gaps levantados.

REGRA DE OURO, inegociável: onde a informação ainda não existir, escreva exatamente "[A DEFINIR — depende de X]" (substituindo X pela dependência concreta). NUNCA invente dados, métricas, prazos, personas ou regras para deixar o documento "completo". Um PRD que admite o buraco é mais seguro para o dev do que um que inventa.

Estruture o PRD em markdown com as seções:
1. Visão geral e objetivo
2. Personas e público-alvo
3. Escopo (o que entra / o que não entra)
4. Requisitos funcionais (numerados)
5. Requisitos não-funcionais
6. Métricas de sucesso (com meta quando existir; senão [A DEFINIR — depende de X])
7. Critérios de aceite (testáveis)
8. Riscos e dependências
9. Questões em aberto (liste os gaps de severidade média/baixa não resolvidos)

Use o Discovery como fonte primária e as respostas dos gaps como contexto adicional. Responda APENAS com o markdown do PRD, sem cercas de código ao redor do documento inteiro.`;

export function buildPrdPrompt(
  discovery: string,
  gaps: Gap[],
  respostas?: Record<string, string>,
  boardName?: string
): string {
  const parts: string[] = [];

  if (boardName) {
    parts.push(`# Produto: ${boardName}\n`);
  }

  parts.push("# Discovery estruturado (extraído do FigJam)\n");
  parts.push(discovery);

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
