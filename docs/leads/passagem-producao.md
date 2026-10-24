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
| 1.2 | Tu | Supabase, Authentication: ligar a **proteção contra palavras passe expostas** (leaked password protection). |
| 1.3 | Eu | Confirmar com o verificador de segurança do Supabase que não há avisos novos. |

## Etapa 2. Base de dados da produção

| # | Quem | O quê | Verificação |
|---|---|---|---|
| 2.1 | Eu | Cópia de segurança (backup do Pro ou cópia manual). | Backup com hora registada. |
| 2.2 | Eu | Marcar o esquema inicial como aplicado (`20261021000000`), sem o executar. | Lista de migrações. |
| 2.3 | Eu | Aplicar as 11 migrações do Leads por ordem, de `20261022090000` a `20261023150000`, uma de cada vez. | Depois de cada uma: o CRM continua a abrir e a guardar clientes e perfis. |
| 2.4 | Eu | Configuração da produção em `private.leads_config`: `functions_url` e `app_url = https://opera-os.com/leads/`. **Sem** `email_redirect_to`. | Consulta à tabela. |
| 2.5 | Eu | Verificador de segurança e de desempenho do Supabase. RLS ativo em todas as tabelas novas. | Zero avisos críticos. |

**Voltar atrás:** as migrações só juntam tabelas, colunas e funções. Se algo correr mal com o CRM, restaura-se o backup de 2.1.

## Etapa 3. Autenticação da produção

| # | Quem | O quê |
|---|---|---|
| 3.1 | Eu (contigo no Chrome) | SMTP próprio com o Resend (emails de login, convites e "esqueci a palavra passe" a sair de `opera-os.com`). |
| 3.2 | Eu (contigo no Chrome) | Fechar o registo público e juntar os endereços de regresso (`https://opera-os.com/leads/`). |
| 3.3 | Eu | Adaptar os convites do portal do CRM para usarem a função de convites nova (decidido na Fase 1). |
| 3.4 | Eu | Verificação em dois passos: o admin e os gestores ativam-na no primeiro login. |

## Etapa 4. Funções no servidor (Supabase, UE)

| # | Quem | O quê |
|---|---|---|
| 4.1 | Eu | Publicar `leads-users`, `leads-inbound`, `leads-cloudtalk` e `leads-notify` na produção. |
| 4.2 | Tu | Guardar os segredos na produção (eu preparo os nomes, tu colas os valores): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `CLOUDTALK_API_KEY_ID`, `CLOUDTALK_API_KEY_SECRET`, `CLOUDTALK_WEBHOOK_SECRET`. |
| 4.3 | Eu | Teste de fumo: chave errada recusada (401), email de aviso enviado para ti, leitura de um email de portal de exemplo. |

## Etapa 5. Site

| # | Quem | O quê |
|---|---|---|
| 5.1 | Eu | Juntar os pull requests ao `main` por ordem (Fase 0 a 7), resolvendo conflitos com o que entrou no `main` entretanto (a landing page do Gestor de Leads). |
| 5.2 | Eu | Confirmar que o Netlify publica: o site principal continua igual e `opera-os.com/leads/` abre o ecrã de login. |
| 5.3 | Tu | Primeiro login como admin, com a verificação em dois passos. |

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
