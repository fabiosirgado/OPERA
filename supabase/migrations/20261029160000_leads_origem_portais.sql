-- OPERA Leads: nova origem "Portais imobiliários" (decisão do Fábio, 2026-10-29).
-- Entra em Nova lead imóveis, como Idealista, Imovirtual e Casa Sapo.

create or replace function private.leads_entry_for_source(p_source text) returns text
language sql immutable set search_path to '' as $$
  select case when p_source = 'Meta' then 'meta'
              when p_source in ('Idealista', 'Imovirtual', 'Casa Sapo', 'Portais imobiliários') then 'imoveis'
              else 'bd' end;
$$;
