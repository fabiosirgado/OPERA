-- Contratos e faturas automáticos.
-- 1) Ficha de fecho: dados de identificação do cliente guardados no contrato (copiados nas renovações).
-- 2) Contrato em PDF: gerado no Dashboard Admin, guardado no bucket privado opera-documentos e enviado ao cliente.
-- 3) Faturas: na data prevista de cada pagamento, a Edge Function opera-documentos pede a fatura à contabilidade;
--    a resposta (com o PDF) chega por um mailhook do Make, fica à espera de validação e depois segue para o cliente.

alter table public.opera_contratos
  add column if not exists ficha jsonb,
  add column if not exists ficha_em timestamptz,
  add column if not exists contrato_pdf text,
  add column if not exists contrato_gerado_em timestamptz,
  add column if not exists contrato_enviado_em timestamptz,
  add column if not exists contrato_enviado_para text,
  add column if not exists contrato_assinado_em timestamptz;

-- Renovação ou novo contrato do mesmo cliente: herda a ficha do contrato anterior.
create or replace function private.opera_contrato_herda_ficha() returns trigger
language plpgsql security definer set search_path = '' as $$
declare f record;
begin
  if new.ficha is not null then return new; end if;
  select c.ficha, c.ficha_em into f from public.opera_contratos c
   where c.ficha is not null
     and ((new.renovacao_de is not null and c.id = new.renovacao_de) or (new.lead_id is not null and c.lead_id = new.lead_id))
   order by (c.id = new.renovacao_de) desc nulls last, c.created_at desc
   limit 1;
  if f.ficha is not null then new.ficha := f.ficha; new.ficha_em := f.ficha_em; end if;
  return new;
end $$;
drop trigger if exists opera_contrato_herda_ficha on public.opera_contratos;
create trigger opera_contrato_herda_ficha before insert on public.opera_contratos
  for each row execute function private.opera_contrato_herda_ficha();

-- ============================================================ FATURAS
create sequence if not exists public.opera_faturas_ref_seq;

create table if not exists public.opera_faturas (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('F-' || lpad(nextval('public.opera_faturas_ref_seq')::text, 4, '0')),
  contrato_id uuid references public.opera_contratos (id) on delete set null,
  pagamento_id uuid references public.opera_pagamentos (id) on delete set null,
  cliente text not null,
  numero integer,
  total_pagamentos integer,
  valor numeric(12,2) not null,              -- sem IVA
  data_prevista date,
  dados jsonb not null default '{}'::jsonb,  -- dados de faturação no momento do pedido
  estado text not null default 'a_pedir' check (estado in ('a_pedir','pedida','recebida','enviada','tratada_fora','cancelada','erro')),
  pedida_em timestamptz,
  recebida_em timestamptz,
  pdf_path text,
  pdf_nome text,
  enviada_em timestamptz,
  enviada_para text,
  erro text,
  criada_em timestamptz not null default now()
);
create unique index if not exists opera_faturas_pagamento_uniq on public.opera_faturas (pagamento_id)
  where pagamento_id is not null and estado <> 'cancelada';
create index if not exists opera_faturas_estado_idx on public.opera_faturas (estado);

alter table public.opera_faturas enable row level security;
revoke all on public.opera_faturas from anon, authenticated;
grant select on public.opera_faturas to authenticated;
drop policy if exists opera_faturas_total on public.opera_faturas;
create policy opera_faturas_total on public.opera_faturas for select to authenticated using (private.opera_nivel() = 'total');
revoke all on sequence public.opera_faturas_ref_seq from anon, authenticated;

-- ============================================================ DOCUMENTOS (bucket privado)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('opera-documentos', 'opera-documentos', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists opera_documentos_total_select on storage.objects;
drop policy if exists opera_documentos_total_insert on storage.objects;
drop policy if exists opera_documentos_total_update on storage.objects;
create policy opera_documentos_total_select on storage.objects for select to authenticated
  using (bucket_id = 'opera-documentos' and private.opera_nivel() = 'total');
create policy opera_documentos_total_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'opera-documentos' and private.opera_nivel() = 'total' and (storage.foldername(name))[1] = 'contratos');
create policy opera_documentos_total_update on storage.objects for update to authenticated
  using (bucket_id = 'opera-documentos' and private.opera_nivel() = 'total' and (storage.foldername(name))[1] = 'contratos');

-- ============================================================ PEDIDO DIÁRIO À CONTABILIDADE (08:10 UTC)
create or replace function private.opera_faturas_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text;
begin
  select value into v_url from private.leads_config where key = 'functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'leads_inbound_secret';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := v_url || '/opera-documentos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-opera-secret', v_key),
    body := '{"action": "pedir_faturas"}'::jsonb,
    timeout_milliseconds := 60000);
end $$;
revoke all on function private.opera_faturas_kick() from public, anon, authenticated;

select cron.unschedule('opera-faturas-diario') where exists (select 1 from cron.job where jobname = 'opera-faturas-diario');
select cron.schedule('opera-faturas-diario', '10 8 * * *', 'select private.opera_faturas_kick()');
