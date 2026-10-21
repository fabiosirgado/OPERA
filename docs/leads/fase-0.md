# OPERA Leads: Fase 0 (preparação)

## O que ficou feito

* Ferramentas instaladas nesta máquina, sem pedir a palavra passe do Mac, em `~/.local/bin`: Node 24 LTS, npm, Supabase CLI e GitHub CLI (`gh`). Os downloads foram verificados com os checksums oficiais. Abre um terminal novo para ficarem disponíveis.
* **Build no Netlify** ([netlify.toml](../../netlify.toml)): `npm run build` copia as páginas atuais para `dist/` tal como estão e compila o OPERA Leads para `dist/leads/`. Um teste confirma que as páginas atuais continuam publicadas e que nada privado vai para o site.
  * Efeito secundário positivo: deixam de ficar públicos o `CRM-DEPLOY.md`, o esquema SQL e o código das funções, que até agora iam para o site.
* **Esqueleto do OPERA Leads** em [leads-app/](../../leads-app/) (Vite e React), com os tokens de cor do protótipo. Por agora mostra só um ecrã provisório que confirma a ligação ao Supabase.
* **Supabase CLI** iniciado em [supabase/](../../supabase/). O `schema.sql` antigo e a migração do feedback passaram para `supabase/legacy/`, só como referência: não refletem a base de dados real (faltam `client_invites`, `financeiro_*`, `profiles.permissions`, etc.). A base das migrações vai ser o esquema real, copiado da produção.
* Protótipo guardado em [docs/prototipo/opera-leads.html](../prototipo/opera-leads.html).

## O que preciso que faças

### 1. Supabase de produção
1. Em **Settings → General**, diz me a **região** do projeto `tdxooskqhpncylwmakvv`.
2. Em **Billing**, confirma se o plano é **Pro** (o documento pede backups diários).

### 2. Projeto Supabase de testes
1. Cria um projeto novo chamado `opera-testes`, na região **Central EU (Frankfurt)**.
2. Guarda a palavra passe da base de dados num gestor de palavras passe. Não ma envies.
3. Em **Settings → API**, envia me o **Project URL** e a **publishable key**. São públicas, por isso podes mandá-las no chat.

### 3. Ligar a Supabase CLI (no teu terminal, não no chat)
```bash
supabase login
```
```bash
cd ~/Desktop/OPERA-repo && supabase link --project-ref tdxooskqhpncylwmakvv
```
O `link` pede a palavra passe da base de dados de produção. A partir daí consigo ler o esquema real.

### 4. Docker Desktop
A cópia do esquema real (`supabase db pull`) e a base de dados local de testes precisam do Docker. Instala o **Docker Desktop para Mac (Apple Silicon)** em docker.com. É gratuito para empresas com menos de 250 pessoas.

### 5. GitHub CLI (no teu terminal)
```bash
gh auth login
```
Escolhe GitHub.com e o login pelo browser. Serve para eu abrir os pull requests.

### 6. Netlify
1. Em **Project configuration → Environment variables**, envia me só os **nomes** das variáveis que existem.
2. Cria estas duas variáveis, com valores diferentes conforme o contexto:

   | Variável | Production | Deploy Previews e Branch deploys |
   |---|---|---|
   | `VITE_SUPABASE_URL` | URL do projeto de produção | URL do `opera-testes` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | chave publicável de produção | chave publicável do `opera-testes` |

3. Em **Build & deploy → Build settings**, confirma que "Base directory" está vazio. O `netlify.toml` passa a definir o comando de build e a pasta publicada.
4. Em **Functions → Region**, diz me que regiões aparecem. Por defeito as Functions correm nos EUA (Ohio). Se a UE só existir num plano pago, decidimos juntos.

Nota: os deploys de pré visualização exigem login na equipa Netlify. Tu consegues abrir esses deploys; um cliente não.
