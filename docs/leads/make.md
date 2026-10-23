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

**Cópia de teste (desde 2026-10-23):** o cenário que já existia, **"OPERA, Meta > Pipedrive (Leads META)"** (id 7548097), ganhou um módulo no fim.
* O módulo **HTTP, Make a request** envia cada lead também para o opera-testes, como formulário: `type=meta`, `form_id`, `lead_id`, `created_time`, `name`, `phone`, `email` e `message` (as respostas, já em texto).
* **O Pipedrive fica igual:** os módulos 1 a 4 não mudaram. O módulo novo só corre depois da nota do Pipedrive e tem o tratamento de erro **Ignore**, por isso uma falha da OPERA nunca afeta o Pipedrive.
* **Para tirar a cópia:** apagar o módulo 5 no Make.
* **Cliente:** no opera-testes as leads entram no cliente **"OPERA (testes)"**, identificadas pelo formulário. Os 15 formulários deste cenário estão registados no cartão desse cliente.
* **Formulários novos:** um formulário que não esteja registado fica em "Entradas sem cliente".
* **Atenção RGPD:** isto põe leads reais no ambiente de testes. Devem ser apagadas quando o teste acabar ou quando a produção estiver ligada.

**Na produção:** o gatilho do Meta no Make só envia o id do formulário, não o da página, por isso a OPERA identifica o cliente pelo formulário. No cartão de cada cliente registam-se os formulários (ou a página inteira, quando o pedido traz a página). Os outros cenários do Meta (por exemplo o do Bruno) recebem o mesmo módulo no fim, com o endereço e a chave de produção.

## Testar

* Enviar um email de teste de um portal (ou reencaminhar um antigo) para o endereço do mailhook, a partir de um endereço que esteja no cartão de um cliente. Deve aparecer em "Últimas entradas" em poucos segundos.
* No Facebook, a ferramenta **Lead Ads Testing Tool** cria uma lead de teste na página.
* Se o Make repetir um envio, a OPERA não cria a lead duas vezes.
