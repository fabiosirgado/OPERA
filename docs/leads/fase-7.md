# OPERA Leads: Fase 7 (avisos aos clientes e migração do Pipedrive)

Tudo isto está aplicado só no projeto Supabase de **testes**. A produção não foi tocada. O envio de emails ainda não está ligado: falta a conta do Resend (ver no fim).

## Decisões (2026-10-23)
* **Envio de email:** Resend, com envio a partir da região UE. Serve também para os emails de login e convites da produção.
* **Remetente:** "OPERA Leads <leads@opera-os.com>". Não precisa de existir uma caixa de correio com esse nome; o domínio é verificado com registos DNS.
* **Respostas:** vão para o gestor do cliente.
* **Migração do Pipedrive:** a partir das exportações Excel de cada conta, com o importador da Fase 3. Os negócios ganhos e perdidos também passam.

## Avisos por email
**Lead qualificada:**
* **Destinatários:** o responsável da lead no cliente ou, sem responsável, todos os utilizadores ativos do cliente.
* **Conteúdo:**
  * contacto (nome, telefone, email);
  * interesse e origem;
  * qualificação (objetivo, budget, prazo, financiamento, imóvel para vender, disponibilidade para visita);
  * notas afixadas;
  * botão "Abrir a lead".
* **Respostas:** o "responder" vai para o gestor da OPERA desse cliente.
* **Exemplo:** [pré-visualização com uma lead fictícia](exemplo-email-lead-qualificada.html).

**Lead criada pelo cliente para a OPERA contactar:** o aviso vai para o gestor do cliente; sem gestor, vai para os admins.

**Como sai:**
* Quando um aviso entra na fila, a base de dados pede o envio à função `leads-notify` (Supabase, UE) sem atrasar quem qualificou a lead.
* De 5 em 5 minutos volta a tentar os que falharam, com espaços cada vez maiores, até 5 tentativas.
* **No histórico da lead** fica "Cliente avisado por email" e para quem foi, ou "O email de aviso não foi enviado" e o motivo.
* **Leads importadas** (por exemplo do Pipedrive) entram diretamente na etapa e **não** geram avisos.
* **Sem a chave do Resend**, os avisos ficam pendentes e saem quando a chave existir.

**Link "Abrir a lead":** a aplicação abre a ficha logo a seguir ao login. O cliente só vê a lead se tiver acesso a ela, pelas regras de sempre.

**Ambiente de testes:** todos os emails vão para um só endereço (fabio.castro.sirgado@gmail.com). O assunto começa por "Teste para …", com os destinatários reais. Configura-se em `private.leads_config` (`email_redirect_to`); na produção não existe.

**RGPD:** o Resend junta-se à lista de subcontratantes no ecrã Privacidade e RGPD.

## Migração do Pipedrive
No ecrã "Importar e exportar", com a exportação de negócios de cada conta Pipedrive (com os campos da pessoa):
* **Colunas reconhecidas sozinhas,** em português e em inglês: "Pessoa - Nome", "Pessoa - Telefone", "Pessoa - E-mail", "Negócio - Etapa", "Negócio - Status", "Negócio - Negócio criado em", "Negócio - Valor".
  * A "Origem" do Pipedrive e o título do negócio ficam de fora.
* **Etapas do ficheiro:** o ecrã mostra cada etapa da conta, com o número de negócios, e propõe a etapa da OPERA, que se pode trocar.
* **Ganhos e perdidos:** os negócios ganhos entram em Lead Qualificada e os perdidos em Lead desqualificada, seja qual for a etapa.
* **Cliente:** cada conta Pipedrive é de um só cliente, que se escolhe no ecrã. Um ficheiro por cliente.

Verificado no browser com uma exportação de exemplo (4 negócios):
* todas as colunas foram reconhecidas;
* o resumo antes de importar ficou certo: Follow Up OPERA 1, Lead Qualificada 1, Lead desqualificada 1, Nova Lead Meta 1.

## Correção à Fase 6 (CloudTalk)
* **Chamadas que não são de nenhuma lead:** a conta da CloudTalk envia todas as chamadas da equipa para o webhook. Agora, dessas chamadas não se guarda o conteúdo, só o tipo e a hora. As que já estavam guardadas foram limpas.
* **Utilizador de teste:** um dos testes usava o utilizador de teste, que tinha ficado ligado ao agente da CloudTalk depois do teste real, e pediu duas chamadas a números de teste. O utilizador foi desligado do agente e o teste passou a garantir que nunca liga.

## Testes
* **9 testes novos** (98 no total, todos a passar):
  * aviso ao qualificar, com resumo, link, notas e "responder para";
  * destinatários com e sem responsável;
  * aviso ao gestor quando o cliente cria uma lead;
  * leads importadas sem aviso;
  * fila pendente sem a chave;
  * permissões;
  * colunas e etapas do Pipedrive.
* **Verificado no browser:** importação do Pipedrive e link "Abrir a lead".

## O que falta do teu lado
1. **Conta no Resend** (resend.com): criar a conta e juntar o domínio `opera-os.com`, escolhendo a região **Irlanda (eu-west-1)**.
2. **DNS na Register.it:** o Resend mostra os registos a juntar (um TXT para a assinatura DKIM, e um MX e um TXT no subdomínio `send`). Não mexem no email do Google, que usa o domínio principal.
3. **Chave da API do Resend:** criar uma, com permissão só de envio, e guardá-la no Supabase (Edge Functions, Secrets) como `RESEND_API_KEY`, primeiro no opera-testes.

## Variáveis novas
| Onde | Nome | Valor |
|---|---|---|
| Supabase, Edge Functions, Secrets | `RESEND_API_KEY` | chave do Resend (só envio) |
| Supabase, Edge Functions, Secrets (opcional) | `LEADS_EMAIL_FROM` | por defeito "OPERA Leads <leads@opera-os.com>" |
| `private.leads_config` (por ambiente, não é segredo) | `functions_url`, `app_url`, `email_redirect_to` (só testes) | endereços do ambiente |
