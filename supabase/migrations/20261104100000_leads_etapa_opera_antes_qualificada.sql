-- OPERA Leads: etapas da OPERA só de um cliente antes de Lead Qualificada (pedido do Fábio, 2026-11-04).
--
-- Exemplo: "Nova lead crédito" da Gerações Team, entre Nova Lead BD (30) e Follow Up OPERA (40).
-- * Só a equipa OPERA as cria (dono 'opera', de um cliente), entre 30 e 50, como as outras etapas do lado da OPERA.
-- * O cliente vê a coluna, como vê as outras etapas da OPERA, mas não as leads (o RLS já esconde tudo abaixo de 50).
-- * O cliente não apaga etapas da OPERA, nem as do seu cliente.

alter table public.lead_stages drop constraint lead_stages_extra_depois_de_qualificada;
alter table public.lead_stages add constraint lead_stages_extra_posicao check (
  is_base
  or (position > 50 and position < 999)
  or (owner = 'opera' and client_id is not null and position > 30 and position < 50));

drop policy "cliente apaga etapas suas" on public.lead_stages;
create policy "cliente apaga etapas suas" on public.lead_stages for delete
  using (not is_base and owner = 'cliente' and client_id = private.leads_my_client_id());
