# OPERA CRM — como pôr isto a funcionar

Esta pasta (`OPERA site/`) tem os ficheiros novos prontos a colocar no
repositório `fabiosirgado/OPERA`:

```
crm/
  index.html      <- a app (React + Supabase, carregados por CDN, sem build)
  app.jsx         <- toda a lógica e UI
  config.js       <- URL + chave do Supabase (preencher)
  demo.html       <- pré-visualização local com dados de exemplo (NÃO subir)
  app.demo.jsx    <- versão de app.jsx com "base de dados" em memória (NÃO subir)
supabase/
  schema.sql      <- schema completo a correr no Supabase (SQL Editor)
```

`demo.html` e `app.demo.jsx` foram só para testar visualmente a app sem
precisar de um Supabase real — já cliquei em todos os ecrãs com eles e
está tudo a funcionar (ver secção "Já testei — resultado" no fim deste
ficheiro). Não têm de ir para o GitHub/Netlify; deixa-os de fora do
commit ou apaga-os quando quiseres.

Ainda não subi nada disto para o GitHub porque esta máquina não tem o
Node/npm nem o `git` funcional (falta instalar as "Command Line Tools"
do Xcode) — por isso os passos abaixo incluem também isso. Consegui,
no entanto, correr e testar a app localmente com um pequeno servidor
em Perl (ver última secção).

## 1. Criar o projeto Supabase

1. Cria um projeto novo em https://supabase.com/dashboard
2. **SQL Editor** → cola o conteúdo de `supabase/schema.sql` inteiro → **Run**
3. **Authentication → Providers** → ativa **Email**, com **"Magic Link"**
   ativado (não precisa de password)
4. **Authentication → URL Configuration** → em "Redirect URLs" adiciona o
   URL final onde a app vai ficar, por exemplo
   `https://<o-teu-site>.netlify.app/crm/` (podes ajustar depois de fazer
   o primeiro deploy)
5. **Database → Replication** → ativa replicação nas tabelas `pedidos` e
   `pedido_mensagens` (necessário para os alertas em tempo real de
   "novo pedido" e do chat)
6. **Settings → API** → copia o **Project URL** e a **anon public key**

## 2. Preencher `crm/config.js`

Abre `crm/config.js` e substitui:

```js
window.OPERA_CONFIG = {
  SUPABASE_URL: "https://SEU-PROJETO.supabase.co",
  SUPABASE_ANON_KEY: "SUA-ANON-KEY-AQUI",
};
```

pelos valores copiados no passo anterior. A "anon key" é pública por
natureza (protegida pelas políticas RLS do schema) — não há problema em
ficar visível no browser / no repositório.

## 3. Levar os ficheiros para o GitHub (`fabiosirgado/OPERA`)

Esta máquina não tem `git` a funcionar (pede as Command Line Tools do
Xcode). Duas opções:

**Opção A — instalar o git (mais rápido para o futuro)**
```bash
xcode-select --install
```
Segue o instalador (uns minutos). Depois, dentro da pasta onde tens o
clone do repositório `OPERA` (ou clona-o de novo com
`git clone https://github.com/fabiosirgado/OPERA.git`), copia para lá as
pastas `crm/` e `supabase/` mais o `CRM-DEPLOY.md` desta pasta, e faz:
```bash
git add crm supabase CRM-DEPLOY.md
git commit -m "Add OPERA CRM (Supabase-backed)"
git push
```

**Opção B — sem git, direto no GitHub (mais simples agora)**
1. Vai a https://github.com/fabiosirgado/OPERA
2. **Add file → Upload files**
3. Arrasta a pasta `crm` e a pasta `supabase` desta pasta (`OPERA site/`)
   — o GitHub mantém a estrutura de subpastas ao arrastar
4. Commit direto na branch principal (ou cria um branch/PR, como
   preferires)

## 4. Deploy no Netlify

Se o site já está ligado ao Netlify via este repositório, o deploy é
automático a seguir ao push/merge — não é preciso build (não há
`package.json`), o Netlify serve os ficheiros estáticos tal como estão.
A app fica disponível em `https://<o-teu-site>.netlify.app/crm/`.

## 5. Primeiro login da equipa

1. Abre `https://<o-teu-site>.netlify.app/crm/`
2. Entra com o teu email (Fábio) — recebes um link mágico por email
3. Depois desse primeiro login, no **SQL Editor** do Supabase corre:
   ```sql
   update public.profiles
   set role = 'equipa', full_name = 'Fábio Sirgado'
   where email = 'o-teu-email-de-login@...';
   ```
4. Repete para a Nicole e restantes membros da equipa
5. Volta a entrar na app (ou faz refresh) — agora entras no painel da
   Equipa

## 6. Dar acesso a um cliente

1. O contacto do cliente entra em `.../crm/` e faz login com o email
   dele (fica automaticamente `role='cliente'`, mas sem cliente
   associado)
2. Um membro da equipa vai a **Clientes → (o cliente) → "Acesso ao
   portal"** e associa a conta na lista "Associar conta registada…"
3. A partir daí, sempre que esse email entrar, vê o Portal do Cliente
   com os pedidos desse cliente

## Notas / limitações conhecidas

- Sem build step, tal como o resto do site (`index.html`,
  `growth.html`, etc.) — o JSX é compilado no browser via Babel
  standalone. Funciona bem para o volume de utilizadores desta app; se
  no futuro quiseres migrar para Vite/build normal, a lógica em
  `app.jsx` transfere quase 1:1.
- Antes de anunciar à equipa, faz mesmo assim um teste com o Supabase
  real (o que testei com `demo.html` usa dados falsos em memória, não
  o Supabase): cria o projeto, corre o schema, preenche o `config.js`,
  abre `crm/index.html` (local ou já no Netlify) e confirma o login
  por magic link, o upload de anexos e o Realtime — são as três coisas
  que só um Supabase real pode validar.

## Já testei — resultado

Consegui montar um pequeno servidor local (Perl, já que não há
Node/npm nesta máquina) e correr a app dentro de um browser real.
Testado com sucesso:
- `index.html` (app real): carrega sem erros, ecrã de login funciona,
  e o pedido de magic link falha de forma graciosa quando o Supabase
  não está configurado (mostra erro em vez de rebentar).
- `demo.html` (dados de exemplo, sem Supabase): Dashboard com métricas
  calculadas corretamente; kanban do CRM Comercial com drag simulado,
  aviso de negócio parado (⚠️ Xd na etapa); abrir um negócio sem
  cliente associado cria a ficha de cliente automaticamente; a nova
  secção "Acesso ao portal" lista e associa contas corretamente; painel
  Operacional com badge "NOVO", contadores de tarefas/notas/mensagens
  e prazos em atraso a vermelho; adicionar tarefa, nota e mensagem no
  painel interno do pedido; Portal do Cliente mostra só os pedidos do
  cliente certo, cria um pedido novo, e esse pedido aparece de imediato
  do lado da Equipa (contador do Dashboard e badge "Operacional"
  atualizam). Não testei upload de anexos nem Storage — isso só faz
  sentido com o Supabase real.
