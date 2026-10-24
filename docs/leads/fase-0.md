# OPERA Leads: Fase 0 (preparação)

## Feito

* **Ferramentas** instaladas em `~/.local/bin`, sem pedir a palavra passe do Mac: Node 24 LTS, npm, Supabase CLI e GitHub CLI. Os downloads foram verificados com os checksums oficiais.
* **Build no Netlify** ([netlify.toml](../../netlify.toml)): copia as páginas atuais para `dist/` tal como estão e compila o OPERA Leads para `dist/leads/`. Um teste confirma que nada privado vai para o site.
  * Deixam de ser públicos o `CRM-DEPLOY.md`, o esquema SQL antigo e o código das funções, que até agora iam para o site.
* **Esqueleto do OPERA Leads** em [leads-app/](../../leads-app/), com Vite, React e as cores do protótipo.
* **Supabase**
  * Produção: `tdxooskqhpncylwmakvv`, região eu-west-1 (Irlanda).
  * Testes: `opera-testes` (`zorfupxbkluiswmhoqnq`), região eu-west-1, plano Free, 0 €. Os deploys de pré visualização e de branch usam este projeto.
  * O esquema real da produção ficou em [supabase/migrations/](../../supabase/migrations/). Já foi aplicado no projeto de testes e confirmado igual à produção.
  * O `schema.sql` antigo passou para `supabase/legacy/`, só como referência.
* **Correções de segurança na produção** (aprovadas pelo Fábio a 2026-10-21):
  * As funções internas deixaram de poder ser chamadas pela API, com ou sem login.
  * A leitura de documentos por IA confirma que o documento é de quem a pede.
* Protótipo guardado em [docs/prototipo/opera-leads.html](../prototipo/opera-leads.html).

## Variáveis de ambiente novas

`VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`, definidas no `netlify.toml` para cada contexto. Ambas são públicas e não há segredos novos nesta fase.

## Pendente (do lado do Fábio)

1. **Chaves da Anthropic e do Resend:** estão escritas em funções da base de dados de produção. É preciso criar chaves novas e apagar as antigas. Depois disso, as funções passam a ler as chaves do Supabase Vault.
2. **Plano Pro do Supabase:** a organização está no plano Free, que não tem backups diários. O documento do projeto pede Pro.
3. **Proteção contra palavras passe vazadas:** ativar em Authentication → Policies no Supabase.

## Notas

* **Histórico de migrações da produção:** só regista as duas correções. Antes do primeiro `supabase db push` para a produção, é preciso marcar a base como já aplicada, com `supabase migration repair --status applied 20261021000000`.
* **Projeto de testes:** a leitura de documentos do Financeiro não funciona lá de propósito, porque as chaves de API não foram copiadas e o link aceite é o da produção.
* **Deploys de pré visualização:** exigem login na equipa Netlify. Um cliente não os consegue abrir.
* **Repositório público:** os emails da equipa foram substituídos por marcadores no ficheiro do esquema.
