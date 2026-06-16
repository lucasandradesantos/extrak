# FigJam → PRD (SaaS)

Plataforma SaaS multi-time que transforma um board FigJam (Discovery) — opcionalmente combinado com um protótipo Figma — em um PRD confiável. A IA critica o material, encontra gaps (inclusive comparando Discovery × Protótipo) e gera um PRD que admite honestamente o que ainda não foi definido.

## Principais características

- Autenticação por email/senha com **Supabase Auth**. Não há cadastro público: contas são criadas por administradores.
- **Multi-time**: cada usuário pertence a um time e vê apenas os projetos do seu time. Papéis: `super_admin`, `team_admin`, `member`.
- **Painel de admin** no app para criar times e usuários.
- Extração de **Discovery (FigJam)** e **Protótipo (Figma Design)** usando uma **única chave da API Figma** no servidor — nenhum usuário informa credenciais.
- Análise da IA (Claude) com **chave única no servidor**, comparando Discovery e Protótipo.
- Persistência completa no **Supabase** (projetos, fontes extraídas, análises, gaps, PRDs).
- Análise pesada processada **em passos** (chunks), robusta ao limite de 60s da Vercel Hobby.

## Pré-requisitos

- Node.js 18+
- Projeto Supabase (já provisionado: `Extrak`)
- Personal Access Token do Figma com escopo `file_content:read`
- Chave da API Anthropic (Claude)

## Configuração

### 1. Variáveis de ambiente do servidor (`.env`)

```env
FIGMA_TOKEN=seu_token_figma
ANTHROPIC_API_KEY=sua_chave_anthropic
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

SUPABASE_URL=https://SEU_PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key   # SECRETA (Supabase Dashboard > Project Settings > API)
ADMIN_BOOTSTRAP_SECRET=um_segredo_forte          # usado uma única vez para criar o 1º super-admin
```

### 2. Variáveis de ambiente do frontend (`client/.env`)

```env
VITE_SUPABASE_URL=https://SEU_PROJETO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx   # chave publishable (pública)
```

### 3. Desabilitar o cadastro público no Supabase

No Supabase Dashboard → Authentication → Providers/Settings, **desative o signup público** (os usuários são criados apenas pelo admin).

## Executar (local)

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Primeiro acesso (bootstrap do super-admin)

Com o servidor rodando e nenhum super-admin existente, crie o primeiro administrador (uma única vez):

```bash
curl -X POST http://localhost:3001/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"secret":"SEU_ADMIN_BOOTSTRAP_SECRET","email":"voce@empresa.com","password":"senhaForte123","full_name":"Seu Nome"}'
```

Depois faça login no app e use o painel **Admin** para criar times e demais usuários.

## Fluxo de uso

1. Login com email/senha.
2. **Admin** cria times e usuários (cada usuário associado a um time).
3. Em **Projetos**, crie um projeto informando a URL do Discovery (FigJam) e, opcionalmente, a do Protótipo (Figma).
4. Na página do projeto:
   - **Discovery / Protótipo**: conteúdo estruturado extraído.
   - **Análise (IA)**: roda a crítica em passos (barra de progresso), lista os gaps por severidade; responda os gaps e clique em **Reprocessar**.
   - **PRD**: liberado quando não há gaps de severidade alta em aberto; copie ou baixe o `.md`.

## Deploy na Vercel

O frontend (`client/`) é publicado como site estático e o backend Express roda como serverless function (`api/`). O `vercel.json` já cuida do install, build, roteamento de `/api/*` e fallback de SPA.

Configure no painel da Vercel (Settings → Environment Variables) **todas** as variáveis do servidor e do frontend listadas acima:

- `FIGMA_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_BOOTSTRAP_SECRET`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`

> Limite de tempo: no plano Hobby cada função serverless tem teto de 60s. A análise roda em passos para caber nesse limite; boards muito grandes podem exigir o plano Pro (até 300s).

## Arquitetura

- **Banco/Auth:** Supabase. Tabelas em `public` (`teams`, `profiles`, `projects`, `project_sources`, `analyses`, `gaps`, `prds`, `analysis_jobs`) com RLS por time e helpers `SECURITY DEFINER` em schema privado.
- **Servidor (`server/`):** Express. Middleware valida o JWT do Supabase e carrega o perfil. Rotas:
  - `/api/admin/*` — bootstrap, times e usuários (Admin API + service_role).
  - `/api/projects` — CRUD de projetos por time, com extração do Figma.
  - `/api/projects/:id/analyze` + `/analyze/step` — análise em passos.
  - `/api/projects/:id/gaps` (PATCH) e `/api/projects/:id/prd` (POST).
- **Extração:** `server/parse-figjam.ts` (Discovery) e `server/parse-figma-design.ts` (telas/textos/fluxos do protótipo).
- **IDs estáveis:** `server/gaps.ts` calcula `gap_hash = sha1(chave)`, mantendo o gap entre reprocessamentos.
- **Prompts:** `server/prompts.ts` concentra as etapas de crítica (com comparação Discovery × Protótipo) e de PRD.
- **Frontend (`client/`):** React + react-router; páginas de login, dashboard, projeto e admin; sessão via `@supabase/supabase-js`.
