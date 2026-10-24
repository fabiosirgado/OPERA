# OPERA Leads: plano de passagem para a produção

Estado a 2026-10-24: as 7 fases estão feitas e testadas no **opera-testes** (98 testes a passar). A produção (`tdxooskqhpncylwmakvv`) ainda não tem nada do Leads: tem o CRM e as duas correções de segurança da Fase 0. O código está em 8 pull requests encadeados (Fase 0 a Fase 7), ainda por juntar ao `main`.

**Princípio:** primeiro a base de dados e as funções, depois o site, depois as entradas automáticas em paralelo com o Pipedrive. Só se desliga o Pipedrive quando a OPERA Leads tiver corrido sem falhas durante uma a duas semanas. Em cada passo há uma forma de voltar atrás.

Legenda: **Tu** = passo teu (contas, chaves, decisões). **Eu** = passo meu. ⏱ = tempo estimado do teu lado.

---

## Etapa 0. Antes de tocar na produção (decisões e contas)

| # | Quem | O quê | ⏱ |
|---|---|---|---|
| 0.1 | Feito | **Plano Pro do Supabase (ativo a 2026-10-24, backups diários a correr)** na produção (cerca de 25 USD por mês): dá backups diários e restauro. Recomendo fortemente antes de mexer numa base que o CRM já usa. Se preferires ficar no gratuito, eu faço uma cópia manual antes (precisa da palavra passe da base de dados). | 5 min |
| 0.2 | Feito | **Netlify (resolvido a 2026-10-24):** o build falhava a empacotar a função antiga `diagnostico.js`, por causa do `"type": "module"` do `package.json`. Um `package.json` em `netlify/functions` mantém o formato antigo; a pré visualização do pull request 1 voltou a publicar. | 0 |
| 0.3 | Feito | **Resend:** o domínio `opera-os.com` já estava verificado, na região Irlanda. A chave do opera-testes está guardada e os avisos saem. Falta só a chave da produção (0.4). | 0 |
| 0.4 | Tu | **Chaves novas para a produção**, nenhuma mostrada nesta conversa: Anthropic (espaço de trabalho, validade longa), CloudTalk (nova chave da API), Resend (só envio). As de testes que ficaram visíveis: apagar ou rodar. | 15 min |
| 0.5 | Decidido | **Primeiros clientes (2026-10-24):** Bruno Fernandes, Alberto Liberal, Casa Penafiel (Daniel), Teixeira & Felizardo e **OPERA** (conta interna: os gestores marcam reuniões para os closers; etapas dos closers depois de Lead Qualificada: R1 feita, R2, Em decisão, Fechado). Gestor: Fábio (admin) até o André entrar. Falta de cada cliente: emails dos utilizadores (na OPERA, os closers), exportação do Pipedrive (a OPERA vem do funil "OPERA" do Pipedrive ligado, por API) e endereço onde recebem os emails dos portais. | 10 min |

## Etapa 1. Segurança da produção (pendente da Fase 0)

| # | Quem | O quê |
|---|---|---|
| 1.1 | Quase feito | **CRM (2026-10-24):** chaves novas só para o CRM no Vault (`crm_resend_api_key`, `crm_anthropic_api_key`); as 8 funções do CRM passaram a lê-las do Vault (migração `20261024120000`), testadas com resposta 200 da Anthropic e do Resend. **Falta:** apagar as chaves antigas no Resend e na Claude Console. |
| 1.2 | Feito | Proteção contra palavras passe expostas ligada (2026-10-24). |
| 1.3 | Feito | Verificador de segurança: sem erros. Ficam 3 avisos antigos do CRM, conhecidos e sem risco (funções de papel usadas pelas regras de acesso, leitura de documentos e relatórios só para a equipa, e o `search_path` de `equipa_notify_emails`). |

## Etapa 2. Base de dados da produção

| # | Quem | O quê | Verificação |
|---|---|---|---|
| 2.1 | Feito | Backup diário do Pro (2026-10-24 06:34 UTC) e, antes de começar, cópia das tabelas `clients` e `profiles`, das políticas e das funções do CRM no esquema `copia_20261024` (fora da API). | Feito às 15:15 UTC. |
| 2.2 | Feito | Esquema inicial (`20261021000000`) e a migração do Vault (`20261024120000`) marcados como aplicados, sem os executar. | Lista de migrações igual à do repositório. |
| 2.3 | Feito | As 11 migrações do Leads aplicadas uma a uma. Depois de cada uma, como utilizador da equipa do CRM e como cliente (com tudo desfeito no fim): a equipa vê os 9 clientes e os 6 perfis e consegue guardá los, o cliente vê só o seu, e nenhuma função nem política do CRM mudou. | **A 1.ª migração tinha um erro:** a proteção das colunas do Leads impedia a equipa do CRM de guardar clientes e perfis. Apanhado pela verificação e corrigido na 2.ª migração minutos depois (também no opera-testes e nos ficheiros). |
| 2.4 | Feito | `private.leads_config` da produção: `functions_url` e `app_url = https://opera-os.com/leads/`, **sem** `email_redirect_to`. | Consulta à tabela. |
| 2.5 | Feito | Produção igual ao opera-testes (tabelas, colunas, índices, políticas, gatilhos, tarefas agendadas e funções, tirando comentários). RLS ativo em todas as tabelas. Verificadores: sem erros; só os avisos já conhecidos. | 98 testes a passar. |

**Voltar atrás:** as migrações só juntam tabelas, colunas e funções. Se algo correr mal com o CRM, restaura-se o backup de 2.1. A cópia `copia_20261024` apaga-se quando a passagem estiver estável.

## Etapa 3. Autenticação da produção

| # | Quem | O quê |
|---|---|---|
| 3.1 | Feito | SMTP do Resend (já existia): remetente passou a "OPERA &lt;crm@opera-os.com&gt;" e a palavra passe é agora uma chave só para isto ("Supabase login", só envio). Testado: link de entrada entregue. O teu endereço estava bloqueado no Resend desde 6/10 (devolução) e foi desbloqueado. As chaves "Onboarding" do Resend já não servem os logins. |
| 3.2 | Meio feito | Endereço de regresso `https://opera-os.com/leads/**` juntado. **Registo público fica aberto até à Etapa 5** (decisão de 2026-10-24): o CRM cria as contas dos clientes pelo link mágico, que precisa dele. Uma conta nova sem convite não vê nada no Leads nem no CRM. |
| 3.3 | Etapa 5 | Mudar os convites do Portal do Cliente do CRM para a função de convites e só então fechar o registo público. |
| 3.4 | Feito | TOTP ligado no Supabase; a app obriga a equipa a ativá lo no primeiro login. |
| 3.5 | Feito | Os 6 textos dos emails de login em português gravados na produção (2026-10-24): [emails-login-pt.md](emails-login-pt.md). |

## Etapa 4. Funções no servidor (Supabase, UE)

| # | Quem | O quê |
|---|---|---|
| 4.1 | Feito | As 4 funções publicadas na produção (2026-10-24), iguais às do opera-testes (mesma impressão digital), todas com a verificação de acesso feita dentro da função. |
| 4.2 | Quase feito | Na produção: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `CLOUDTALK_API_KEY_ID`, `CLOUDTALK_API_KEY_SECRET`. Falta `CLOUDTALK_WEBHOOK_SECRET`, que nasce quando o webhook passar para a produção (Etapa 7). |
| 4.3 | Feito | Sem chave ou sessão, as 4 funções recusam (401). A base de dados chama a `leads-notify` com a chave do Vault e o Resend está ligado (200, `configured: true`). A leitura de emails com IA fica para o primeiro email real na Etapa 7, para não pôr dados de exemplo na produção. |

## Etapa 5. Site

| # | Quem | O quê |
|---|---|---|
| 5.1 | Feito | Fases 0 a 7 juntas ao `main` pelo pull request 8 (2026-10-24), sem conflitos (o `main` só tinha juntado `links.html`, `comercial-b2b.html` e uma foto). Os pull requests 1 a 7 foram fechados. |
| 5.2 | Feito | O Netlify publicou: o site principal, o CRM, links e comercial B2B abrem como antes, e `opera-os.com/leads/` abre o OPERA Leads, ligado ao Supabase da produção. |
| 5.3 | Tu | A tua conta (`fabio.sirgado@opera-os.com`) já é admin do Leads. Falta o primeiro login em `opera-os.com/leads/`, com a verificação em dois passos. Como o CRM e o Leads estão no mesmo domínio, a sessão do CRM é a mesma. |
| 5.4 | Decidido | Os convites do Portal do Cliente do CRM ficam como estão e o registo público fica aberto (decisão de 2026-10-24). Uma conta criada sem convite não vê nada no Leads nem no CRM. |

**Voltar atrás:** no Netlify, "Publish deploy" na publicação anterior repõe o site em segundos.

## Etapa 6. Clientes, equipa e dados

| # | Quem | O quê |
|---|---|---|
| 6.1 | Tu (ou eu contigo) | Ativar no Leads os clientes da lista 0.5, com cor, gestor e endereço dos portais. |
| 6.2 | Tu | Convidar o André (gestor) e os utilizadores de cada cliente. |
| 6.3 | Tu | Exportar os negócios de cada conta Pipedrive (com os campos da pessoa). |
| 6.4 | Tu ou eu | Importar cada ficheiro no ecrã "Importar e exportar", escolhendo o cliente e confirmando as etapas. Os ganhos entram em Lead Qualificada e os perdidos em desqualificada, sem enviar emails. |
| 6.5 | Tu | Conferir 5 leads ao acaso de cada cliente com o Pipedrive. |

## Etapa 7. Entradas automáticas e CloudTalk, em paralelo com o Pipedrive

| # | Quem | O quê |
|---|---|---|
| 7.1 | Eu | **Meta:** em cada cenário do Meta (OPERA, Bruno, Teixeira & Felizardo), juntar no fim o módulo que envia para a **produção**, como fizemos nos testes. O Pipedrive continua a receber igual. Retirar a cópia para o opera-testes. |
| 7.2 | Eu | Registar no ecrã Entradas automáticas os formulários do Meta de cada cliente. |
| 7.3 | Eu | **Emails dos portais:** criar o cenário de produção (mailhook novo) e guardar o endereço no ecrã. |
| 7.4 | Tu | Enviar a cada cliente as instruções de reencaminhamento (botão no ecrã); quando chegarem os códigos do Gmail, enviar-lhos. |
| 7.5 | Tu (comigo no Chrome) | **CloudTalk:** mudar o endereço do webhook para a produção (assim o opera-testes deixa de receber as chamadas reais). Confirmar que cada pessoa da equipa tem o mesmo email na CloudTalk e na OPERA Leads. |
| 7.6 | Tu | Uma chamada real e um email de portal real, confirmados na lead. |

## Etapa 8. Período em paralelo (1 a 2 semanas)

* A equipa trabalha na OPERA Leads; o Pipedrive continua a receber as leads do Meta, só como rede de segurança.
* Eu vejo todos os dias: entradas com erro ou sem cliente, avisos não enviados, Time to Lead no Dashboard.
* **Critério para avançar:** nenhuma lead perdida (cada lead do Meta no Pipedrive está também na OPERA Leads) e nenhum erro por resolver.

## Etapa 9. Desligar o Pipedrive

| # | Quem | O quê |
|---|---|---|
| 9.1 | Eu (com o teu sim) | Retirar os módulos do Pipedrive dos cenários do Meta e desligar o cenário antigo do Imovirtual. |
| 9.2 | Tu | Exportação final de cada conta Pipedrive (arquivo) e cancelar as contas quando quiseres. |

## Etapa 10. Limpeza do ambiente de testes (RGPD)

| # | Quem | O quê |
|---|---|---|
| 10.1 | Eu | Apagar do opera-testes os dados reais que lá ficaram: o email do Imovirtual reencaminhado, as cópias de leads do Meta (se entrarem), os eventos de chamadas reais, o cliente "OPERA (testes)" e os teus endereços nos cartões dos clientes de teste. |
| 10.2 | Eu | Desligar o utilizador de teste do teu agente da CloudTalk (já feito) e retirar a chave de teste do Make. |

## Depois da passagem: Fase 8
Conversa entre a OPERA e cada cliente dentro do OPERA Leads. Começa quando a Etapa 8 (período em paralelo) estiver a correr bem. Plano em [fase-8-plano.md](fase-8-plano.md).

---

## Resumo do teu tempo
Cerca de **1 hora e meia** repartida (contas e chaves, DNS, Netlify, convites, exportações do Pipedrive), mais a conferência das leads importadas. O resto faço eu, e em cada passo com risco paro para confirmares.

## Pontos em aberto
* Quantos clientes e contas Pipedrive há para migrar, e por que ordem.
* Plano Pro do Supabase (recomendado) ou cópia manual.
* Onde ficam guardados os dados da CloudTalk (perguntar-lhes se é na UE).
