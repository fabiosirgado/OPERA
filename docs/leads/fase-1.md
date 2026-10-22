# OPERA Leads: Fase 1 (base de dados e acessos)

Tudo isto está aplicado só no projeto Supabase de **testes** (`opera-testes`). A produção não foi tocada.

## Feito

**Base de dados** ([supabase/migrations/](../../supabase/migrations/))
* Tabelas `leads`, `lead_stages`, `lead_labels`, `lead_label_links`, `lead_events`, `lead_tasks`, `audit_log`, `inbound_log` e `leads_settings`. O prefixo `lead_` evita confusão com as tabelas do CRM.
* Reutiliza `clients` e `profiles` do CRM e só acrescenta colunas. O papel no Leads fica em `profiles.leads_role` e não mexe no `role` que o CRM usa.
* Um cliente do CRM só aparece no Leads depois de ser ativado (`leads_enabled`). Assim um gestor não vê as fichas do CRM dos outros clientes.
* Etapas base e etiquetas iniciais criadas. Índices de pesquisa com `pg_trgm`.

**Regras de acesso no RLS**, com testes que as provam pela API:
* A equipa OPERA só tem acesso com verificação em dois passos.
* Um cliente só vê as suas leads e só mexe nelas a partir de Lead Qualificada.
* Notas: cada cliente só edita as suas.
* Máximo de 8 clientes por gestor.
* Desativar um cliente bloqueia logo os acessos. As leads são apagadas automaticamente aos 6 meses (tarefa diária às 03:15) e apagar mais cedo exige escrever o nome do cliente.
* Registo de atividade, que só o admin lê, guardado 12 meses. O conteúdo bruto das entradas automáticas é apagado aos 30 dias.
* RGPD: "Apagar a pedido do titular" anonimiza a lead e mantém só as chamadas e as mudanças de etapa. A regra automática opcional (12 ou 24 meses) está desligada por defeito.

**Convites** ([supabase/functions/leads-users](../../supabase/functions/leads-users/index.ts)): Edge Function no Supabase (UE) para convidar, reenviar e cancelar, com as mesmas permissões do RLS. Se a pessoa já tiver conta no CRM, dá acesso sem criar outra.

**Ecrãs** ([leads-app/src](../../leads-app/src/)), com o design do protótipo:
* Login com palavra passe, link por email e "Esqueci a palavra passe".
* Definir a palavra passe a partir do convite.
* Verificação em dois passos, com ativação por código QR.
* "Clientes e acessos", com novo cliente (de raiz ou a partir de um cliente do CRM), atribuição de gestores e equipa OPERA.
* "A minha equipa".
* "Privacidade e RGPD".
* Sessões terminam por inatividade: 12 h para a equipa OPERA, 30 dias para os clientes.

**Testes:** 35 testes automáticos contra o projeto de testes (`npm test`, precisam do ficheiro `.env.test`, que não vai para o git). Experimentei também no browser, em computador e telemóvel.

## Antes de ir para produção

1. **Servidor de email próprio no Supabase (SMTP).** O servidor por defeito só envia para membros da equipa no Supabase e tem limite de envios por hora, por isso os convites não chegariam aos clientes. Proposta: usar o Resend, que a OPERA já usa, com o domínio opera-os.com.
2. **Definições de Auth do Supabase:**
   * Desligar o registo público.
   * Acrescentar os endereços de regresso (`https://opera-os.com/leads/` e os deploys de pré visualização).
3. **Convites do Portal do Cliente do CRM.** Hoje dependem do registo público. Quando o registo for desligado, os convites do CRM têm de passar a usar a mesma função de convites. Isto ainda não está feito.
4. **Aplicar as migrações e a função na produção.** Antes disso é preciso marcar a base como já aplicada (ver `fase-0.md`).
