/**
 * Pacote de Specs: documentos derivados do Discovery + Protótipo + gaps,
 * pensados para alimentar uma IDE com IA (estilo spec-driven do ralph-orchestrator).
 * Cada documento é gerado por uma chamada de IA independente.
 */

import { Gap } from "./types";

export type SpecDocGroup = "spec" | "qa";

export type SpecDocKind =
  | "requirements"
  | "architecture"
  | "data_model"
  | "design_system"
  | "implementation_plan"
  | "business_model"
  | "agents"
  | "open_questions"
  | "qa_test_cases";

export interface SpecDocMeta {
  kind: SpecDocKind;
  /** Ambiente a que o documento pertence: pacote de specs ou QA. */
  group: SpecDocGroup;
  label: string;
  filename: string;
  /** Instrução específica do documento, anexada ao sistema. */
  instruction: string;
  /** Prompt de sistema próprio; se ausente, usa SPEC_DOC_SYSTEM. */
  system?: string;
  /** Documento depende do protótipo para fazer sentido pleno. */
  needsPrototype?: boolean;
}

export const SPEC_DOC_ORDER: SpecDocKind[] = [
  "requirements",
  "architecture",
  "data_model",
  "design_system",
  "implementation_plan",
  "business_model",
  "agents",
  "open_questions",
];

export const QA_DOC_ORDER: SpecDocKind[] = ["qa_test_cases"];

export function docOrderForGroup(group: SpecDocGroup): SpecDocKind[] {
  return group === "qa" ? QA_DOC_ORDER : SPEC_DOC_ORDER;
}

export const QA_TEST_CASES_SYSTEM = `Você é um(a) Analista de Qualidade Sênior (QA). Sua tarefa é criar um documento de Casos de Teste funcionais (manuais, caixa-preta) para o produto, baseado EXCLUSIVAMENTE no material fornecido: o Discovery (extraído de um board FigJam), o Protótipo (extraído de um Figma Design, quando houver), os gaps levantados, as respostas a esses gaps e o PRD (quando fornecido).

# Regras e restrições (obrigatório)
- Foco: testes funcionais (caixa-preta).
- NÃO avaliar performance.
- NÃO automatizar testes.
- NÃO sugerir ferramentas, frameworks, pipelines ou estratégias de automação.
- Documento para o cliente: o entregável será enviado ao cliente.
  - NÃO incluir menções a estrutura interna de testes (automação, E2E, scripts), ferramentas, variáveis de ambiente, IA ou serviços internos.
  - Quando o teste depender de e-mail, indicar apenas que o testador deve verificar o envio/recebimento pela caixa de entrada ou pelo mecanismo disponível no ambiente, sem citar ferramentas internas.
- Se algo não estiver claro no material, registrar como Ponto em aberto e criar o teste com assunções explícitas e objetivas. NUNCA invente regras de negócio que não estejam no material.

Considerar também: validações de campos; mensagens de erro/sucesso; estados vazios; filtros/ordenação/paginação (se existirem); perfis/permissões (se existirem); fluxos alternativos e exceções.

# Massa de Teste (criar e excluir) — obrigatório
Sempre que uma Pré-Condição depender de dados existentes, NÃO escreva "ter X cadastrado" como se já existisse. Em vez disso:
1) Solicite a criação da massa dentro do próprio caso de teste, com passo a passo prático para cadastrar/gerar os dados ANTES dos passos principais.
2) Exija limpeza ao final, descrevendo como excluir/desfazer tudo que foi criado naquele CT, com passo a passo.
- Em Pré-Condições: descreva o necessário e inclua um bloco "Como criar a massa (passo a passo)".
- Em Pós-Condições: inclua um bloco "Como remover a massa criada (passo a passo)".
- A massa deve ser mínima, isolada e rastreável (use identificadores únicos, ex.: sufixo QA_CT001_AAAAMMDD_HHMM; evite reaproveitar dados de outros CTs).
- Se o material não explicar como cadastrar/excluir: registre em Pontos em aberto e crie o passo a passo com assunções explícitas.
- Se o ambiente tiver restrições (ex.: só inativar): documente a alternativa e registre como Ponto em aberto se não confirmado.

# Estrutura obrigatória do documento
1. Título + Contexto rápido (nome da funcionalidade/produto e objetivo do documento)
2. Mapa de módulos/funcionalidades identificadas (lista do que existe)
3. Premissas e Pontos em aberto (tudo que não foi possível confirmar pelo material)
4. Casos de Teste (formato tradicional): numerar sequencialmente CT001, CT002...; agrupar por módulo (seções)
5. Checklist de cobertura por módulo (recomendado)

# Template obrigatório para CADA Caso de Teste (não altere os títulos)
### CT### - [Nome do Caso de Teste]
#### Objetivo
Descrever claramente o que será validado.
#### Pré-Condições
Listar tudo que precisa estar verdadeiro antes do teste. Quando depender de massa de teste, incluir obrigatoriamente o bloco "Como criar a massa (passo a passo)" com nomes/valores exemplo e identificador único.
#### Dados de Teste
Incluir exemplos quando necessário (e-mail válido/inválido, CPF, datas, limites de caracteres etc.). Se o CT depender de receber/ler e-mail, indicar que o testador deve ter acesso à caixa de entrada do e-mail informado ou ao mecanismo de verificação disponível no ambiente, sem mencionar ferramentas/automação/serviços internos. Se não aplicável, escreva N/A.
#### Passos
Use uma tabela markdown com colunas: Id | Ação | Resultado Esperado.
#### Pós-Condições
O que deve ficar como resultado após o teste. Quando massa tiver sido criada, incluir obrigatoriamente o bloco "Como remover a massa criada (passo a passo)". Se a remoção não for possível, indicar alternativa (ex.: inativar) e registrar em Pontos em aberto. Se não aplicável, escreva N/A.
#### Critérios de Aceite do Teste
Definir objetivamente quando o teste é considerado aprovado.

# Regras de qualidade dos testes
- Cada CT deve ser objetivo, reprodutível, verificável e independente.
- Cobrir ao menos: fluxo feliz; validações; fluxos alternativos; negativos/erro; permissões (quando aplicável); estados vazios e mensagens.
- Evitar duplicidade: se variar apenas dados, explicitar isso em Dados de Teste.

Antes de escrever os testes: (1) liste o que foi identificado no material; (2) liste dependências de dados por módulo (o que exige massa); (3) só então gere os Casos de Teste no padrão acima, garantindo que toda dependência de dado tenha criação de massa documentada e toda massa criada tenha remoção/limpeza documentada.

Escreva 100% em português e 100% em markdown. Responda APENAS com o markdown do documento, sem cercas de código ao redor do documento inteiro e sem comentários fora do conteúdo.`;

export const SPEC_DOCS: Record<SpecDocKind, SpecDocMeta> = {
  requirements: {
    kind: "requirements",
    group: "spec",
    label: "Requisitos",
    filename: "requirements.md",
    instruction:
      'Gere um documento de REQUISITOS testáveis. Estruture em: Requisitos Funcionais (cada um com ID "RF-001", título, descrição, e critérios de aceite verificáveis em formato dado/quando/então) e Requisitos Não-Funcionais ("RNF-001": desempenho, segurança, acessibilidade, etc.). Agrupe por módulo/fluxo. Cada requisito deve ser rastreável ao Discovery/Protótipo.',
  },
  architecture: {
    kind: "architecture",
    group: "spec",
    label: "Arquitetura técnica",
    filename: "architecture.md",
    instruction:
      "Gere um documento de ARQUITETURA TÉCNICA para implementação. Inclua: visão geral da solução, stack sugerida (com justificativa), divisão em módulos/camadas, principais componentes e responsabilidades, integrações externas, APIs/endpoints previstos (alto nível), autenticação/autorização e decisões técnicas (com trade-offs). Onde a decisão depender de algo não definido, use [A DEFINIR — depende de X].",
  },
  data_model: {
    kind: "data_model",
    group: "spec",
    label: "Modelo de dados",
    filename: "data-model.md",
    instruction:
      "Gere o MODELO DE DADOS. Liste as entidades com seus campos (nome, tipo, obrigatoriedade, descrição), chaves e os relacionamentos entre elas (1:1, 1:N, N:N). Inclua um diagrama em Mermaid (erDiagram) representando as entidades e relações. Derive tudo do Discovery/Protótipo; não invente entidades sem evidência.",
  },
  design_system: {
    kind: "design_system",
    group: "spec",
    label: "Design System",
    filename: "design-system.md",
    needsPrototype: true,
    instruction:
      "Gere a base de um DESIGN SYSTEM a partir dos tokens/estilos extraídos do Figma (cores hex, tipografia, componentes publicados) e dos wireframes. Inclua: tokens (cores, tipografia, espaçamentos) usando valores literais quando presentes na seção de tokens extraídos; inventário de componentes de UI recorrentes (com estados/variações); padrões de layout e navegação; e diretrizes de acessibilidade. Se um valor não estiver nos tokens nem inferível, marque [A DEFINIR — depende de X].",
  },
  implementation_plan: {
    kind: "implementation_plan",
    group: "spec",
    label: "Plano de implementação",
    filename: "implementation-plan.md",
    instruction:
      'Gere um PLANO DE IMPLEMENTAÇÃO INCREMENTAL para uma IDE com IA executar passo a passo. Quebre em fases e, dentro de cada fase, em tarefas pequenas e independentes no formato de checklist ("- [ ] TASK-001: ..."), cada uma com: objetivo, arquivos/áreas afetadas, dependências de outras tasks e critérios de pronto (gates: testes/lint/typecheck). Ordene por dependência, começando pela fundação (setup, modelo de dados, auth) até as features. Priorize entregar valor cedo.',
  },
  business_model: {
    kind: "business_model",
    group: "spec",
    label: "Modelo de negócio",
    filename: "business-model.md",
    instruction:
      "Gere um documento de MODELO DE NEGÓCIO com base no Discovery. Cubra: problema e proposta de valor, público-alvo/segmentos, principais funcionalidades e seu valor, possíveis fontes de receita/monetização (se houver indícios), métricas de negócio e diferenciais. Onde não houver informação no material, use [A DEFINIR — depende de X]; não invente números.",
  },
  agents: {
    kind: "agents",
    group: "spec",
    label: "AGENTS.md (instruções p/ IA)",
    filename: "AGENTS.md",
    instruction:
      "Gere um AGENTS.md com instruções para o agente de IA que vai desenvolver este projeto numa IDE. Inclua: contexto do produto em 1 parágrafo, convenções de código e estrutura de pastas sugeridas, como rodar/testar/buildar (assumindo a stack proposta na arquitetura), os gates de qualidade que devem passar antes de concluir uma tarefa (testes, lint, typecheck), e regras de ouro (não inventar requisitos, consultar os specs em caso de dúvida, marcar pendências). Seja direto e acionável.",
  },
  open_questions: {
    kind: "open_questions",
    group: "spec",
    label: "Perguntas em aberto",
    filename: "open-questions.md",
    instruction:
      "Gere um documento de PERGUNTAS EM ABERTO consolidando os gaps não resolvidos. Agrupe por severidade (Bloqueadores/alta primeiro, depois média e baixa) e, dentro de cada grupo, por módulo/localização. Para cada item: o que está em aberto, o impacto no desenvolvimento e a pergunta objetiva que precisa ser respondida (e por quem, quando inferível). Se não houver gaps em aberto, diga isso claramente.",
  },
  qa_test_cases: {
    kind: "qa_test_cases",
    group: "qa",
    label: "Casos de Teste (Funcionais)",
    filename: "test-cases.md",
    system: QA_TEST_CASES_SYSTEM,
    instruction:
      "Gere o documento de Casos de Teste funcionais (manuais, caixa-preta) seguindo ESTRITAMENTE a estrutura e o template do sistema, agrupando os casos por módulo/funcionalidade.",
  },
};

export const SPEC_DOC_SYSTEM = `Você é um(a) Product Manager e Tech Lead sênior gerando documentação para um time desenvolver um produto numa IDE com IA (desenvolvimento orientado a especificação).

Baseie-se SOMENTE no material fornecido: o Discovery (extraído de um board FigJam), o Protótipo (extraído de um Figma Design, quando houver), os gaps levantados, as respostas a esses gaps e o PRD (quando fornecido).

REGRA DE OURO, inegociável: onde a informação ainda não existir, escreva exatamente "[A DEFINIR — depende de X]" (substituindo X pela dependência concreta). NUNCA invente dados, números, regras, entidades, telas ou decisões para deixar o documento "completo". Documentação que admite o buraco é mais segura para o time do que uma que inventa.

Escreva em português, em markdown bem estruturado, pronto para ser commitado num repositório. Responda APENAS com o markdown do documento, sem cercas de código ao redor do documento inteiro e sem comentários fora do conteúdo.`;

export interface SpecDocParams {
  kind: SpecDocKind;
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  prd?: string | null;
  productName?: string;
}

export function buildSpecDocPrompt(params: SpecDocParams): string {
  const { kind, discovery, prototype, gaps, respostas, prd, productName } = params;
  const meta = SPEC_DOCS[kind];
  const parts: string[] = [];

  parts.push(`# Tarefa: gerar o documento "${meta.label}" (${meta.filename})\n`);
  parts.push(meta.instruction);

  if (productName) {
    parts.push(`\n\n# Produto: ${productName}`);
  }

  parts.push("\n\n# Discovery estruturado (extraído do FigJam)\n");
  parts.push(discovery);

  if (prototype && prototype.trim()) {
    parts.push("\n\n# Protótipo estruturado (extraído do Figma Design)\n");
    parts.push(prototype);
  } else if (meta.needsPrototype) {
    parts.push(
      "\n\n# Protótipo: NÃO disponível. Baseie-se no Discovery e marque [A DEFINIR — depende do protótipo] onde a informação visual for necessária."
    );
  }

  if (prd && prd.trim()) {
    parts.push("\n\n# PRD já gerado (use como fonte de verdade e mantenha coerência)\n");
    parts.push(prd);
  }

  const respondidos = gaps.filter((g) => respostas?.[g.id]?.trim());
  if (respondidos.length > 0) {
    parts.push("\n\n# Respostas a gaps (contexto adicional)\n");
    for (const gap of respondidos) {
      parts.push(`\n- [${gap.localizacao}] ${gap.titulo}: ${respostas![gap.id].trim()}`);
    }
  }

  const abertos = gaps.filter(
    (g) => g.status !== "resolvido" && !respostas?.[g.id]?.trim()
  );
  if (abertos.length > 0) {
    parts.push(
      "\n\n# Gaps ainda em aberto (use [A DEFINIR — depende de ...] onde dependerem destes pontos)\n"
    );
    for (const gap of abertos) {
      parts.push(
        `\n- [${gap.severidade}] [${gap.localizacao}] ${gap.titulo}: ${gap.descricao}`
      );
    }
  }

  parts.push(`\n\nGere agora o documento "${meta.label}" em markdown, seguindo a regra de ouro.`);

  return parts.join("\n");
}
