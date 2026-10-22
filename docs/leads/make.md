# OPERA Leads: configurar o Make

Dois cenários no Make, na zona UE (o endereço da conta começa por `eu1.make.com` ou `eu2.make.com`). Os dois enviam as entradas para a mesma função da OPERA. Toda a lógica (IA, duplicados, que cliente é) fica do lado da OPERA; o Make só entrega.

**Endereço da função:**

| Ambiente | Endereço |
|---|---|
| Testes | `https://zorfupxbkluiswmhoqnq.supabase.co/functions/v1/leads-inbound` |
| Produção | `https://tdxooskqhpncylwmakvv.supabase.co/functions/v1/leads-inbound` (depois de a Fase 5 ir para produção) |

**Chave:** está no Supabase, em Project Settings, Vault, com o nome `leads_inbound_secret`. Cada ambiente tem a sua. Vai no cabeçalho `x-opera-secret` de cada pedido e nunca se escreve em mais lado nenhum.

## Cenário 1: emails dos portais

1. **Novo cenário.** Primeiro módulo: **Webhooks, Custom mailhook**. Criar o mailhook com o nome "OPERA Leads portais". O Make mostra um endereço parecido com `abc123@hook.eu1.make.com`.
2. **Guardar esse endereço** no ecrã **Entradas automáticas** da OPERA Leads (campo "Endereço de receção dos emails", só o admin). É o endereço que aparece nas instruções aos clientes.
3. Segundo módulo: **HTTP, Make a request**:
   * URL: o endereço da função (tabela acima). Method: `POST`.
   * Headers: `x-opera-secret` com a chave, e `Content-Type` com `application/json`.
   * Body type: Raw, Content type JSON. Conteúdo, mapeando os campos do mailhook:
     ```json
     { "type": "email", "from": "{{1.sender}}", "to": "{{1.recipients}}", "subject": "{{1.subject}}",
       "text": "{{1.text}}", "html": "{{1.html}}", "headers": "{{1.headers}}" }
     ```
     Os nomes exatos dos campos aparecem no Make depois de chegar o primeiro email; escolhem-se na lista. O texto e o HTML devem ir com a função `toJSON`, para as aspas e mudanças de linha não partirem o JSON.
   * Parse response: Sim.
4. **Alertas:** botão direito no módulo HTTP, **Add error handler**, módulo **Email, Send an email** para o Fábio, com o assunto "OPERA Leads: entrada falhou". A entrada fica sempre guardada na OPERA, mesmo quando falha.
5. Depois do módulo HTTP, um **filtro** com a condição `alert` igual a `true`, seguido de outro **Send an email**: "OPERA Leads: entrada sem cliente". Isto acontece quando chega um email de um endereço que ainda não está no cartão de nenhum cliente.
6. Ligar o cenário (Scheduling: Immediately).

**Para cada cliente:** no ecrã Entradas automáticas, juntar ao cartão do cliente o endereço onde ele recebe os emails dos portais. Depois enviar-lhe as instruções (botão "Instruções para o cliente"). Quando ele adicionar o reencaminhamento no Gmail, o código de confirmação aparece no topo do ecrã, para lho enviarem.

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
