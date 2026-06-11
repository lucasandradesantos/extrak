# FigJam → PRD

Web app local que transforma um board FigJam em um PRD confiável, passando por um pipeline com loop de reprocessamento:

1. **URL → JSON**: extrai a `fileKey` da URL e chama a REST API do Figma.
2. **JSON → Discovery (parser determinístico)**: um parser em código puro (sem IA) percorre a árvore de SECTIONs e extrai apenas `{hierarquia + texto}`. Isso reduz custo e elimina alucinação sobre layout.
3. **Crítica (IA)**: o Claude analisa o Discovery e devolve os _gaps_ em **JSON estruturado** (com IDs estáveis), agrupados por severidade.
4. **Devolutiva + reprocessar (Modelo B)**: cada gap tem um campo de resposta na própria tela. Ao reprocessar, só os gaps respondidos entram no contexto e o app mostra honestamente "X resolvidos, Y novos, Z abertos" comparando IDs estáveis.
5. **PRD final**: habilitado apenas quando não há gaps de severidade alta em aberto. Onde a informação ainda não existe, o PRD escreve `[A DEFINIR — depende de X]` em vez de inventar.

## Pré-requisitos

- Node.js 18+
- Personal Access Token do Figma com escopo `file_content:read`
- Chave da API Anthropic (Claude)

## Configuração

1. Copie o arquivo de ambiente:

```bash
cp .env.example .env
```

2. Edite `.env` e defina suas chaves:

```env
FIGMA_TOKEN=seu_token_figma_aqui
ANTHROPIC_API_KEY=sua_chave_anthropic_aqui
# Opcional (padrão: claude-sonnet-4-20250514)
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

- Token do Figma: [Figma → Settings → Personal access tokens](https://www.figma.com/settings).
- Chave Anthropic: [console.anthropic.com](https://console.anthropic.com/settings/keys).

> **Segurança:** nunca commite o arquivo `.env`. Se uma chave foi exposta publicamente, revogue-a imediatamente e gere uma nova.

## Executar

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Uso

1. Abra http://localhost:5173
2. Cole a URL do board FigJam (ex: `https://www.figma.com/board/abc123/Nome-do-Board`) ou a file key.
3. Clique em **Extrair** e navegue pelas abas:
   - **Conteúdo extraído** — Discovery em texto, com "Copiar tudo".
   - **JSON bruto** — JSON completo da API Figma.
   - **Análise (IA)** — clique em **Analisar com IA**; revise os gaps por severidade; responda os que puder e clique em **Reprocessar** para ver o diff.
   - **PRD** — clique em **Gerar PRD** (liberado quando não há gaps de severidade alta em aberto); copie ou baixe o `.md`.

## API

### `POST /api/export`

```json
{ "url": "https://www.figma.com/board/.../..." }
```

Retorna `metadata`, `parsed` (Discovery) e `raw` (JSON Figma).

### `POST /api/analyze`

Primeira análise:

```json
{ "discovery": "texto estruturado do Discovery" }
```

Reprocessamento (anexa respostas e devolve o diff por IDs estáveis):

```json
{
  "discovery": "...",
  "gaps": [ /* gaps anteriores */ ],
  "respostas": { "<gapId>": "resposta do usuário" }
}
```

Retorna `{ gaps, diff? }`, onde cada gap tem `id`, `chave`, `categoria`, `severidade`, `localizacao`, `titulo`, `descricao`, `sugestao` e `status`.

### `POST /api/prd`

```json
{
  "discovery": "...",
  "gaps": [ /* gaps atuais */ ],
  "respostas": { "<gapId>": "..." },
  "boardName": "Nome do board"
}
```

Retorna `{ prd }` em markdown. Responde `409` se houver gaps de severidade alta em aberto.

## Arquitetura

- **Etapa 2.5 (parser determinístico):** `server/parse-figjam.ts` — nunca passamos o JSON cru para a IA.
- **IDs estáveis:** `server/gaps.ts` calcula `id = sha1(chave)` (`localizacao | categoria | titulo`), nunca por ordem de aparição, para que o reprocessar não embaralhe os gaps.
- **Prompts:** `server/prompts.ts` concentra os prompts das etapas 3 e 5 (substitua pelos seus prompts definitivos aqui).
- **Estado:** o loop de gaps vive em memória no navegador (sem banco). Recarregar a página zera a análise.

## Build para produção

```bash
npm run build
npm start
```
