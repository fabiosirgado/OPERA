# OPERA Leads: configurar o Make

Dois cenários no Make, na zona UE (o endereço da conta começa por `eu1.make.com` ou `eu2.make.com`). Os dois enviam as entradas para a mesma função da OPERA. Toda a lógica (IA, duplicados, que cliente é) fica do lado da OPERA; o Make só entrega.

**Endereço da função:**

| Ambiente | Endereço |
|---|---|
| Testes | `https://zorfupxbkluiswmhoqnq.supabase.co/functions/v1/leads-inbound` |
| Produção | `https://tdxooskqhpncylwmakvv.supabase.co/functions/v1/leads-inbound` (depois de a Fase 5 ir para produção) |

**Chave:** está no Supabase, em Project Settings, Vault, com o nome `leads_inbound_secret`. Cada ambiente tem a sua. Vai no cabeçalho `x-opera-secret` de cada pedido e nunca se escreve em mais lado nenhum.

## Cenário 1: emails dos portais (criado a 2026-10-23, no opera-testes)

Cenário **"OPERA Leads (testes), emails dos portais"** (id 8126750), criado pelo conector do Make, ativo:

1. **Webhooks, Custom mailhook** "OPERA Leads, emails dos portais (testes)": recebe em `21ycigf9uyb9uf34e3jf7h48wd9uvksv@hook.eu1.make.com`. Este endereço está guardado no ecrã Entradas automáticas do opera-testes.
2. **JSON, Transform to JSON** dos cabeçalhos do email (para a OPERA ler o `X-Forwarded-For` do Gmail).
3. **HTTP, Make a request**, POST para a função, com o cabeçalho `x-opera-secret`. O corpo vai como **formulário** (`type`, `from`, `to`, `cc`, `subject`, `text`, `html`, `headers_json`): o Make escapa sozinho as aspas e as mudanças de linha, o que num JSON escrito à mão parte o pedido.
4. **Em caso de erro**, o módulo **Break** guarda a execução e volta a tentar 3 vezes, de 15 em 15 minutos. O Make avisa por email quando um cenário falha.
5. **Dados confidenciais** ligado: os registos de execução do Make não mostram o conteúdo dos emails.

Cada email gasta 3 operações do Make. Os anexos nunca chegam à OPERA.

O cenário do opera-testes usa uma chave própria (só a impressão digital está na base de dados). Para a produção, cria-se o mesmo cenário com o endereço de produção e a chave `leads_inbound_secret` do Vault de produção.

**Para cada cliente:** no ecrã Entradas automáticas, juntar ao cartão do cliente o endereço de onde vêm os emails reencaminhados (normalmente o email da agência). Depois enviar-lhe as instruções (botão "Instruções para o cliente"). Quando ele adicionar o reencaminhamento no Gmail, o código de confirmação aparece no topo do ecrã, para lho enviarem.

**Teste real (2026-10-23):** um email do Imovirtual reencaminhado a partir de um endereço da Zome chegou à OPERA. A IA tirou o nome, o telefone, o email, a referência e a mensagem. Como o endereço ainda não estava em nenhum cliente, ficou em "Entradas sem cliente", como previsto. Depois de atribuído, a lead entrou em Nova lead imóveis.

## Cenário 2: formulários Meta

1. **Novo cenário.** Primeiro módulo: **Facebook Lead Ads, Watch Leads**. Ligar a conta do Facebook com acesso às páginas dos clientes e escolher a página.
2. Segundo módulo: **HTTP, Make a request**, com a mesma URL, cabeçalhos e Parse response do cenário 1. Conteúdo:
   ```json
   { "type": "meta", "page_id": "{{1.page_id}}", "form_id": "{{1.form_id}}", "lead_id": "{{1.id}}",
     "created_time": "{{1.created_time}}", "name": "{{1.full_name}}", "phone": "{{1.phone_number}}",
     "email": "{{1.email}}", "answers": [ { "q": "Pergunta do formulário", "a": "{{1.resposta}}" } ] }
   ```
   Em alternativa ao nome, telefone e email soltos, pode ir a lista `field_data` tal como o Facebook a entrega; a OPERA percebe os dois formatos.
3. Os mesmos alertas do cenário 1 (error handler e filtro `alert`).
4. **No ecrã Entradas automáticas**, juntar ao cartão do cliente o id da página (e, se a página tiver formulários de vários clientes, o id do formulário). É assim que a OPERA sabe de que cliente é a lead; não é preciso um cenário por cliente.
5. O módulo Watch Leads do Make trabalha com uma página de cada vez. Para outra página, clona-se o cenário e muda-se só a página no primeiro módulo; tudo o resto fica igual.

## Testar

* Enviar um email de teste de um portal (ou reencaminhar um antigo) para o endereço do mailhook, a partir de um endereço que esteja no cartão de um cliente. Deve aparecer em "Últimas entradas" em poucos segundos.
* No Facebook, a ferramenta **Lead Ads Testing Tool** cria uma lead de teste na página.
* Se o Make repetir um envio, a OPERA não cria a lead duas vezes.
