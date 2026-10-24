# OPERA Leads: Fase 8 (conversa entre a OPERA e cada cliente), plano

Decidido a 2026-10-24: uma conversa por cliente, dentro do OPERA Leads, entre a equipa OPERA e os utilizadores desse cliente. Faz-se **depois da passagem para a produção**, para não atrasar a saída.

## Objetivo
Substituir os grupos de WhatsApp com cada cliente por um canal dentro da aplicação, com o histórico guardado junto das leads, as mesmas regras de acesso e ligação direta às leads.

## O que fica de fora (já existe ou não compensa)
* **Conversa sobre uma lead em concreto:** já são as notas da ficha da lead.
* **Chat interno da equipa OPERA:** fica no WhatsApp ou no Google Chat.

## Como vai funcionar
**Para o cliente:**
* Um ecrã novo, **"Conversa com a OPERA"**, no menu, com o número de mensagens por ler.
* Lê e escreve as mensagens do seu cliente; nunca vê as de outros clientes.

**Para a equipa OPERA:**
* Um ecrã **"Conversas"** com a lista de clientes ativos, ordenada pela última mensagem, com as por ler em destaque, e a conversa de cada cliente ao lado (em telemóvel, uma de cada vez).
* O cartão de cada cliente no menu lateral mostra as mensagens por ler.

**Mensagens:**
* Texto, com quem escreveu e quando.
* Quem escreveu pode editar ou apagar a sua mensagem durante 15 minutos; depois fica "editada" ou "apagada" à vista.
* **Ligar uma lead:** botão "Juntar lead" para escolher uma lead; a mensagem mostra um cartão com o nome e a etapa, que abre a ficha. O cliente só pode ligar, e só vê, as leads a que tem acesso (a partir de Lead Qualificada); a OPERA também só pode ligar essas, para nunca mostrar ao cliente uma lead que ele não vê.
* **Tempo real:** a mensagem aparece logo a quem tiver a conversa aberta, sem recarregar.

**Avisos:**
* Número de mensagens por ler no menu (por pessoa).
* **Email:** se uma mensagem ficar por ler 15 minutos, quem a devia ler recebe um email com o texto e o link para a conversa.
  * Do lado do cliente: os utilizadores ativos.
  * Do lado da OPERA: o gestor do cliente.
  * Sai pelo Resend, com a mesma fila e as mesmas tentativas dos avisos da Fase 7. No máximo 1 email por conversa a cada hora, para não encher a caixa de correio.

## Base de dados (rascunho)
* `client_messages`:
  * id, client_id, author_id, body (até 4000 caracteres), lead_id (opcional);
  * created_at, edited_at, deleted_at.
  * Índice por (client_id, created_at).
* `client_message_reads`:
  * user_id, client_id, last_read_at.
  * As "por ler" contam-se a partir daqui, sem uma linha por mensagem.
* **RLS, testado como nas outras fases:**
  * equipa OPERA (com dois passos): conversas dos clientes ativos;
  * utilizadores de cliente: só a do seu cliente, e só enquanto o cliente estiver ativo;
  * ligar uma lead obriga a que o autor a possa ver;
  * editar e apagar: só o autor, nos 15 minutos.
* **Funções no servidor:**
  * lista de conversas com as por ler;
  * marcar como lida;
  * o aviso por email entra na fila da Fase 7 (generalizada para avisos que não são de uma lead).
* **Tempo real:** a tabela entra na publicação do Supabase Realtime, filtrada por cliente.

## RGPD
* As mensagens são dados do cliente: entram na exportação quando o cliente sai.
* São apagadas com o resto, ao fim dos 6 meses depois de o cliente ser desativado.
* Apagar uma mensagem apaga o texto; fica só a indicação de que foi apagada.
* Nada de conteúdo das mensagens nos registos de erros.

## Testes previstos
* **RLS:** cada cliente só vê a sua conversa; cliente inativo perde o acesso; a OPERA sem dois passos não lê.
* **Leads ligadas:** não se pode ligar uma lead que o cliente não vê.
* **Edição e remoção:** só o autor, só nos 15 minutos.
* **Por ler:** a contagem certa por pessoa e o marcar como lida.
* **Email de aviso:** só depois de 15 minutos por ler, no máximo 1 por hora por conversa.
* **Desempenho:** lista de conversas e últimas 50 mensagens rápidas com 100 mil mensagens.
* **Browser:** computador e telemóvel, dois utilizadores ao mesmo tempo a ver a mensagem chegar.

## Pontos a decidir antes de começar
1. **Anexos** (fotos, PDFs): fora da primeira versão (recomendado; podem vir numa 8b, com o armazenamento do Supabase) ou já incluídos?
2. **Quem recebe o email do lado da OPERA:** só o gestor do cliente (recomendado) ou toda a equipa?
3. **Horário:** os emails de aviso ao cliente só em horário de expediente, ou a qualquer hora?

## Estimativa
Uma fase do tamanho da Fase 5: base de dados com RLS e testes, dois ecrãs, tempo real e avisos. Como nas outras: ramo próprio, pull request, testes no opera-testes, verificação no browser e pausa para aprovação antes da produção.
