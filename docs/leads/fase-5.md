# OPERA Leads: Fase 5 (entradas automáticas)

Tudo isto está aplicado só no projeto Supabase de **testes**. A produção não foi tocada.

## Decisões
* **Emails dos portais pelo Make** (opção C, decidida a 2026-10-23): os clientes reencaminham para um endereço do Make, sem domínio próprio nem registos DNS. A OPERA sabe de que cliente é cada email pelo endereço onde o portal o entregou, guardado no cartão do cliente.
* **Nenhuma tarefa automática:** as leads do Meta e dos portais entram sem tarefa, e uma lead repetida só recebe o evento "Novo contacto recebido".
* **Função no Supabase (UE)** em vez das Netlify Functions, como nas fases anteriores.

## Feito
**Função `leads-inbound`** (Supabase, UE), chamada pelo Make:
* Só aceita pedidos com a chave do Make.
  * A chave é criada ao acaso no Vault do Supabase e nunca está no código.
  * Os testes usam uma chave própria, de que só a impressão digital fica na base de dados.
* **Guarda primeiro, processa depois:** o conteúdo bruto fica no registo de entradas antes de tudo, por isso uma falha nunca perde uma lead. Se algo falhar, devolve um erro ao Make, que avisa o Fábio por email.
* **Meta:** a lead entra em Nova Lead Meta, com as respostas do formulário numa nota. Chegam o nome, o telefone, o email, a hora na origem e o id do Facebook.
  * O mesmo pedido repetido pelo Make não cria outra lead.
  * O cliente é encontrado pela página e pelo formulário, que se registam no ecrã. Um só cenário serve todos os clientes de uma página.
* **Emails dos portais:**
  * A IA lê só o assunto e o texto do email e tira o nome, telefone, email, mensagem, imóvel, referência e portal. Usa o Claude Opus 5.5 com esforço baixo e uma resposta em JSON com formato fixo.
  * A lead entra em Nova lead imóveis, com a mensagem numa nota e a referência no histórico.
  * Sem telefone nem email, a lead entra na mesma, com uma nota afixada a pedir revisão. O email original fica disponível 30 dias.
  * Se a IA não estiver disponível, a função tira o telefone e o email pelo padrão e marca a lead para revisão.
* **Leads repetidas** (mesmo telefone ou email no mesmo cliente): não se cria outra lead; junta-se o evento "Novo contacto recebido", sem tarefa.
* **Códigos de confirmação do Gmail:** são reconhecidos e aparecem no topo do ecrã, com o botão de copiar, para a OPERA enviar ao cliente.

**Ecrã "Entradas automáticas"** (equipa OPERA):
* **Endereço de receção** do Make, que só o admin muda e que aparece nas instruções aos clientes.
* **Códigos do Gmail por enviar.**
* **Entradas sem cliente:** escolhe-se o cliente e a lead é criada.
* **Um cartão por cliente:** formulários Meta, endereços dos portais, última entrada de cada canal e instruções de reencaminhamento para o Gmail e o Outlook.
* **Últimas 50 entradas**, com o resultado de cada uma e o email original. Ver o original fica no registo de atividade.

**RGPD:** o conteúdo bruto e os dados extraídos são apagados ao fim de 30 dias, numa tarefa diária. Os clientes não veem nada deste ecrã nem do registo de entradas.

## Testes
* **11 testes novos (81 no total, todos a passar):**
  * a chave;
  * Meta: lead nova sem tarefa, pedido repetido e lead repetida;
  * formulário desconhecido e atribuição à mão;
  * email reencaminhado pelo Gmail, email sem contactos, endereço desconhecido;
  * código do Gmail;
  * o que o ecrã mostra;
  * os clientes sem acesso.
* **Verificado no browser** como gestor, em computador e telemóvel: entradas de exemplo do Cliente Teste A, atribuição de uma entrada sem cliente e email original.

## O que falta do teu lado
1. **Chave da Anthropic** como segredo `ANTHROPIC_API_KEY` das Edge Functions, primeiro no opera-testes. Pode ser a chave nova, depois de rodares a antiga. Enquanto não existir, os emails entram com o telefone e o email tirados pelo padrão e ficam marcados para revisão.
2. **Make:** criar os dois cenários seguindo o [guia do Make](make.md). Eu acompanho passo a passo.
3. **Teste real:** reencaminhar um email verdadeiro de um portal antes de fecharmos a fase.

## Variáveis novas
| Onde | Nome | Valor |
|---|---|---|
| Supabase, Edge Functions, Secrets (testes e depois produção) | `ANTHROPIC_API_KEY` | chave da API da Anthropic |
| Make, cabeçalho `x-opera-secret` | chave do Vault `leads_inbound_secret` | já criada pela migração, uma por ambiente |
