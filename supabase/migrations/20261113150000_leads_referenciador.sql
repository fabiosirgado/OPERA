-- OPERA Leads: campo "Referenciador" na lead, por baixo do Nome no painel Contacto (pedido do Fábio, 2026-11-13).
-- Quem referenciou a lead (texto livre). Edita-se como os outros campos de contacto.
alter table public.leads add column if not exists referrer text;
comment on column public.leads.referrer is 'Referenciador: quem indicou esta lead (texto livre).';
