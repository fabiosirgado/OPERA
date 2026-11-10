-- Banco (Millennium via Enable Banking, só leitura): saldo diário e movimentos da conta da Grabbingstars.
-- Escrito só pela Edge Function opera-banco (chave secreta); lido e tratado no Dashboard Admin (nível total).

create table if not exists public.opera_banco_ligacao (
  id uuid primary key default gen_random_uuid(),
  aspsp text not null,
  estado text not null default 'pendente' check (estado in ('pendente','ativa','expirada','erro')),
  auth_state text,
  session_id text,
  contas jsonb not null default '[]'::jsonb,
  valido_ate timestamptz,
  ultima_sync timestamptz,
  ultimo_erro text,
  criado_em timestamptz not null default now()
);

create table if not exists public.opera_banco_movimentos (
  id uuid primary key default gen_random_uuid(),
  conta_uid text not null,
  ref text not null,
  data date not null,
  valor numeric(12,2) not null,           -- positivo = entrada, negativo = saída
  moeda text not null default 'EUR',
  contraparte text,
  descricao text,
  estado text not null default 'novo' check (estado in ('novo','ligado','ignorado','custo')),
  pagamento_id uuid references public.opera_pagamentos (id) on delete set null,
  custo_id uuid references public.opera_custos (id) on delete set null,
  criado_em timestamptz not null default now(),
  unique (conta_uid, ref)
);
create index if not exists opera_banco_movimentos_data_idx on public.opera_banco_movimentos (data desc);

alter table public.opera_banco_ligacao enable row level security;
alter table public.opera_banco_movimentos enable row level security;
revoke all on public.opera_banco_ligacao, public.opera_banco_movimentos from anon, authenticated;
grant select on public.opera_banco_ligacao, public.opera_banco_movimentos to authenticated;
create policy opera_banco_ligacao_total on public.opera_banco_ligacao for select to authenticated using (private.opera_nivel() = 'total');
create policy opera_banco_movimentos_total on public.opera_banco_movimentos for select to authenticated using (private.opera_nivel() = 'total');

-- Entradas por ligar com a prestação por receber que melhor encaixa (mesmo valor, data próxima, nome parecido).
create or replace function public.opera_admin_banco_sugestoes() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  return (
    with mov as (
      select * from opera_banco_movimentos where estado = 'novo' and valor > 0
    ), cand as (
      select m.id mov_id, p.id pag_id, c.cliente, p.numero, p.valor, p.data_prevista,
        abs(m.data - p.data_prevista) dias,
        (exists (select 1 from regexp_split_to_table(lower(c.cliente), '[^a-zà-ú0-9]+') w
                 where length(w) >= 4 and lower(coalesce(m.contraparte,'') || ' ' || coalesce(m.descricao,'')) like '%' || w || '%')) nome
      from mov m
      join opera_pagamentos p on p.estado = 'pendente' and abs(p.valor - m.valor) < 0.01 and abs(m.data - p.data_prevista) <= 60
      join opera_contratos c on c.id = p.contrato_id and c.estado <> 'cancelado'
    ), melhor as (
      select distinct on (mov_id) * from cand order by mov_id, nome desc, dias
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'data', m.data, 'valor', m.valor, 'contraparte', m.contraparte, 'descricao', m.descricao,
      'sugestao', case when b.pag_id is null then null else jsonb_build_object(
        'pagamento_id', b.pag_id, 'cliente', b.cliente, 'numero', b.numero, 'data_prevista', b.data_prevista, 'nome_bate', b.nome) end
    ) order by m.data desc), '[]'::jsonb)
    from mov m left join melhor b on b.mov_id = m.id
  );
end $$;

-- Prestações por receber (para escolher à mão quando a sugestão não serve).
create or replace function public.opera_admin_banco_pendentes() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('pagamento_id', p.id, 'cliente', c.cliente, 'numero', p.numero, 'valor', p.valor, 'data_prevista', p.data_prevista) order by p.data_prevista, c.cliente), '[]'::jsonb)
          from opera_pagamentos p join opera_contratos c on c.id = p.contrato_id
          where p.estado = 'pendente' and c.estado <> 'cancelado');
end $$;

-- Liga uma entrada do banco a uma prestação: fica paga na data do movimento.
create or replace function public.opera_admin_banco_ligar(p_mov uuid, p_pag uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  select * into m from opera_banco_movimentos where id = p_mov and estado = 'novo' and valor > 0 for update;
  if m.id is null then raise exception 'Movimento já tratado ou inexistente.'; end if;
  update opera_pagamentos set estado = 'pago', data_pagamento = m.data, confirmado_em = now()
   where id = p_pag and estado = 'pendente';
  if not found then raise exception 'Essa prestação já não está por receber.'; end if;
  update opera_banco_movimentos set estado = 'ligado', pagamento_id = p_pag where id = p_mov;
end $$;

-- Marca um movimento como não relevante (transferência interna, reembolso, etc.).
create or replace function public.opera_admin_banco_ignorar(p_mov uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  update opera_banco_movimentos set estado = 'ignorado' where id = p_mov and estado = 'novo';
end $$;

-- Volta a pôr um movimento por tratar (desfaz ligação a prestação ou custo criado a partir dele).
create or replace function public.opera_admin_banco_desfazer(p_mov uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  select * into m from opera_banco_movimentos where id = p_mov for update;
  if m.estado = 'ligado' and m.pagamento_id is not null then
    update opera_pagamentos set estado = 'pendente', data_pagamento = null, confirmado_em = null where id = m.pagamento_id and estado = 'pago';
  end if;
  if m.estado = 'custo' and m.custo_id is not null then delete from opera_custos where id = m.custo_id; end if;
  update opera_banco_movimentos set estado = 'novo', pagamento_id = null, custo_id = null where id = p_mov;
end $$;

-- Regista uma saída do banco como custo pontual (entra no P&L na data do movimento).
create or replace function public.opera_admin_banco_custo(p_mov uuid, p_categoria text, p_descricao text) returns void
language plpgsql security definer set search_path = public as $$
declare m record; cid uuid;
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  if p_categoria not in ('entrega','aquisicao','outros') then raise exception 'Categoria inválida.'; end if;
  select * into m from opera_banco_movimentos where id = p_mov and estado = 'novo' and valor < 0 for update;
  if m.id is null then raise exception 'Movimento já tratado ou inexistente.'; end if;
  insert into opera_custos (descricao, categoria, valor_mensal, inicio, fim, tipo)
  values (coalesce(nullif(trim(p_descricao), ''), m.contraparte, 'Saída do banco'), p_categoria, abs(m.valor), m.data, m.data, 'pontual')
  returning id into cid;
  update opera_banco_movimentos set estado = 'custo', custo_id = cid where id = p_mov;
end $$;

revoke all on function public.opera_admin_banco_sugestoes(), public.opera_admin_banco_pendentes(), public.opera_admin_banco_ligar(uuid, uuid),
  public.opera_admin_banco_ignorar(uuid), public.opera_admin_banco_desfazer(uuid), public.opera_admin_banco_custo(uuid, text, text) from public, anon;
grant execute on function public.opera_admin_banco_sugestoes(), public.opera_admin_banco_pendentes(), public.opera_admin_banco_ligar(uuid, uuid),
  public.opera_admin_banco_ignorar(uuid), public.opera_admin_banco_desfazer(uuid), public.opera_admin_banco_custo(uuid, text, text) to authenticated;

-- Sincronização diária (07:40 UTC): a base de dados chama a Edge Function com a chave das entradas automáticas.
create or replace function private.opera_banco_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.opera_banco_ligacao where estado = 'ativa') then return; end if;
  select value into v_url from private.leads_config where key = 'functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'leads_inbound_secret';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := v_url || '/opera-banco',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-opera-secret', v_key),
    body := '{"action": "sync"}'::jsonb,
    timeout_milliseconds := 60000);
end $$;
revoke all on function private.opera_banco_kick() from public, anon, authenticated;

select cron.schedule('opera-banco-diario', '40 7 * * *', 'select private.opera_banco_kick()');
