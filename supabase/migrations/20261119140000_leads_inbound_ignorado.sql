-- OPERA Leads, entradas por email (pedido do Fábio, 2026-11-19: "ela recebe mais emails do Idealista que não são imóveis").
-- Os emails dos portais que a IA vê que não são pedidos de contacto (resumos diários, alertas, faturas) passam a
-- ficar como "ignorado" no registo das entradas, sem criar lead.
alter table public.inbound_log drop constraint inbound_log_status_check;
alter table public.inbound_log add constraint inbound_log_status_check
  check (status = any (array['recebido', 'processado', 'revisao', 'duplicado', 'erro', 'sem_cliente', 'ignorado']));
