# OPERA Leads: Fase 6 (CloudTalk)

Tudo isto está aplicado só no projeto Supabase de **testes**. A produção não foi tocada. A CloudTalk está ligada ao opera-testes (chaves e webhook criados a 2026-10-23).

## Como funciona
**Botão Ligar** (ficha da lead e ecrã Hoje):
* A função `leads-cloudtalk` (Supabase, UE) cria ou atualiza o contacto na CloudTalk com o nome **"Nome · Cliente"** (por exemplo "Marta Lopes · Teixeira & Felizardo"), para se reconhecer quem devolve a chamada.
* Depois pede a chamada: a CloudTalk liga primeiro ao agente de quem carregou (até 20 segundos) e, quando ele atende, liga à lead.
* A chamada fica logo registada na lead. Conta para o Time to Lead, sobe as tentativas, conclui a tarefa de chamada mais antiga e tira a lead das etapas de entrada.
* **O agente** é encontrado pelo email: o login na OPERA Leads e o agente na CloudTalk têm de ter o mesmo email. Fica guardado na primeira chamada.
* **Telefone:** vai em formato internacional; os números portugueses de 9 dígitos ganham o +351.
* **Sem as chaves da CloudTalk**, o botão continua a ligar pelo telefone, como antes.

**Fim de chamada** (webhook `call.ended`, assinado pela CloudTalk):
* Junta à chamada registada pelo botão a duração e o resultado: atendida quando houve tempo de conversa, não atendida quando não houve.
* **Chamada feita diretamente na CloudTalk:** fica registada na lead com o mesmo telefone.
* **Mesmo telefone em mais de um cliente:** usa a lead com atividade mais recente e deixa uma nota afixada, "Confirmar a chamada", com os outros clientes.
* **O que se ignora:** as chamadas recebidas (a OPERA só faz chamadas de saída) e os números que não são de nenhuma lead.
* **Eventos repetidos:** a CloudTalk pode enviar o mesmo evento mais de uma vez; cada evento só é tratado uma vez.

**Gravação** (webhook `call.recording_ready`):
* A chamada fica marcada como gravada e aparece "Ouvir gravação" no histórico.
* O áudio vem da CloudTalk através da função, só para a equipa OPERA. Quem ouviu fica no registo de atividade.
* A ligação à gravação nunca vai para o browser com a chave da CloudTalk.

**RGPD:** o conteúdo dos eventos da CloudTalk é apagado ao fim de 30 dias. A gravação fica na CloudTalk; o aviso de gravação no início das chamadas já está no ecrã Privacidade e RGPD.

## Testes
* **7 testes novos** (89 no total, todos a passar):
  * botão Ligar sem chaves e cliente sem acesso;
  * fim de chamada junto à chamada pedida e evento repetido;
  * chamada feita diretamente na CloudTalk;
  * telefone em dois clientes;
  * chamadas recebidas e números sem lead;
  * gravação;
  * assinaturas inválidas e permissões.
* **Verificado no browser:** chamada atendida de 3 minutos com "Ouvir gravação" na ficha de uma lead do Cliente Teste A.
* **Chamada real (2026-10-23), no opera-testes, com a conta da CloudTalk da OPERA:**
  * O botão Ligar criou o contacto "Teste CloudTalk (Fábio) · Cliente Teste A" e pediu a chamada. A CloudTalk ligou primeiro ao agente e depois ao telemóvel.
  * A chamada ficou logo na lead, que passou para Follow Up OPERA.
  * A CloudTalk enviou `call.ended` e `call.recording_ready`, assinados, e a assinatura foi verificada. A chamada ficou "atendida", com 5 segundos de conversa e 11 no total.
  * A gravação ouviu-se na ficha da lead.

## Ligar a CloudTalk (feito no opera-testes; repetir para a produção, com uma conta de admin)
1. **Chaves da API:** Settings, API Keys, criar uma chave. Guardar no Supabase (Edge Functions, Secrets) como `CLOUDTALK_API_KEY_ID` e `CLOUDTALK_API_KEY_SECRET`.
2. **Webhook:** Settings, Webhooks (precisa do plano Essential ou superior):
   * **Endereço:** `https://zorfupxbkluiswmhoqnq.supabase.co/functions/v1/leads-cloudtalk` (testes).
   * **Eventos:** `call.ended` e `call.recording_ready`.
   * **Segredo:** a CloudTalk mostra-o (começa por `whsec_`). Guarda-o no Supabase como `CLOUDTALK_WEBHOOK_SECRET`.
3. **Agentes:** confirmar que cada pessoa da equipa tem o mesmo email na CloudTalk e na OPERA Leads.

**Por confirmar com a CloudTalk:** a documentação não diz onde ficam guardados os dados (UE ou não), nem se o pedido de chamada devolve o id da chamada; a OPERA não precisa dele, porque junta a chamada pelo telefone e pela hora.

## Variáveis novas
| Onde | Nome |
|---|---|
| Supabase, Edge Functions, Secrets | `CLOUDTALK_API_KEY_ID` |
| Supabase, Edge Functions, Secrets | `CLOUDTALK_API_KEY_SECRET` |
| Supabase, Edge Functions, Secrets | `CLOUDTALK_WEBHOOK_SECRET` |
