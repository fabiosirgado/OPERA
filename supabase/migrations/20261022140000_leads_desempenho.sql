-- OPERA Leads, Fase 2: desempenho com 100 mil leads (teste de carga).
-- 1. Uma coluna de pesquisa com índice trigram, em vez de quatro ilike separados.
-- 2. Consultas montadas com os filtros reais de cada pedido, para o Postgres usar os índices.
-- 3. O pipeline deixa de contar o total em cada página (os totais vêm de leads_pipeline_counts).

alter table public.leads add column search_text text generated always as (
  lower(coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(interest, '') || ' ' || coalesce(phone_norm, ''))
) stored;
create index leads_search_trgm on public.leads using gin (search_text extensions.gin_trgm_ops);
create index leads_client_name_idx on public.leads (client_id, name);
create index leads_client_created_idx on public.leads (client_id, created_at desc);

-- Texto para LIKE: % e _ escritos pelo utilizador contam como letras, não como curingas.
create function private.leads_like_escape(p text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(coalesce(p, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- Condição SQL dos filtros comuns. Só inclui o que foi pedido; os valores entram como parâmetros ($1 a $5).
--   $1 cliente, $2 etiqueta, $3 texto em minúsculas, $4 só dígitos do texto, $5 utilizador ("só as minhas")
create function private.leads_filter_sql(p_client uuid, p_label uuid, p_q text, p_mine boolean) returns text
language plpgsql immutable as $$
declare
  w text := '(((select private.leads_is_opera()) and l.client_id in (select private.leads_active_client_ids()))'
            ' or l.client_id = (select private.leads_my_client_id()))';
begin
  if p_client is not null then w := w || ' and l.client_id = $1'; end if;
  if p_label is not null then w := w || ' and exists (select 1 from public.lead_label_links k where k.lead_id = l.id and k.label_id = $2)'; end if;
  if coalesce(trim(p_q), '') <> '' then
    w := w || ' and (l.search_text like ''%'' || $3 || ''%''';
    if length(regexp_replace(p_q, '\D', '', 'g')) > 2 then w := w || ' or l.search_text like ''%'' || $4 || ''%'''; end if;
    w := w || ')';
  end if;
  if coalesce(p_mine, false) then w := w || ' and l.owner_user_id = $5'; end if;
  return w;
end;
$$;

create or replace function private.leads_visible_filtered(p_client uuid, p_label uuid, p_q text, p_mine boolean)
returns setof public.leads
language plpgsql stable security definer set search_path = public as $$
begin
  return query execute 'select l.* from public.leads l where ' || private.leads_filter_sql(p_client, p_label, p_q, p_mine)
    using p_client, p_label, private.leads_like_escape(lower(trim(p_q))), regexp_replace(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '^351', ''), auth.uid();
end;
$$;

drop function public.leads_pipeline(uuid, uuid, uuid, text, boolean, text, integer, integer, integer);
create function public.leads_pipeline(
  p_client uuid default null, p_stage uuid default null, p_label uuid default null, p_q text default null,
  p_mine boolean default false, p_sort text default 'next', p_dir integer default 1,
  p_offset integer default 0, p_limit integer default 50)
returns table (id uuid, client_id uuid, client_name text, client_color text, name text, phone text, email text,
               source text, interest text, stage_id uuid, stage_name text, attempts integer, created_at timestamptz,
               last_contact_at timestamptz, next_task_at timestamptz, next_task_type text, owner_name text,
               label_ids uuid[], pinned_note text, anonymized boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  d text := case when p_dir = -1 then 'desc' else 'asc' end;
  ord text;
begin
  -- Só ordenações conhecidas; nunca texto vindo de fora.
  ord := case p_sort
    when 'next' then 'l.next_task_at asc nulls last'
    when 'recent' then 'l.created_at desc'
    when 'old' then 'l.created_at asc'
    when 'stale' then 'l.last_contact_at asc nulls first'
    when 'name' then 'l.name ' || d
    when 'client' then 'c.name ' || d || ', l.name'
    when 'source' then 'l.source ' || d || ' nulls last'
    when 'created' then 'l.created_at ' || d
    when 'last' then 'l.last_contact_at ' || d || case when d = 'asc' then ' nulls first' else ' nulls last' end
    when 'attempts' then 'l.attempts ' || d
    when 'stage' then 's.position ' || d
    when 'nextlist' then 'l.next_task_at ' || d || ' nulls last'
    else 'l.created_at desc' end;

  return query execute
    'select l.id, l.client_id, c.name, c.color, l.name, l.phone, l.email, l.source, l.interest, l.stage_id, s.name,
            l.attempts, l.created_at, l.last_contact_at, l.next_task_at, l.next_task_type,
            (select p.full_name from public.profiles p where p.id = l.owner_user_id),
            coalesce((select array_agg(k.label_id) from public.lead_label_links k where k.lead_id = l.id), ''{}''),
            (select e.body from public.lead_events e where e.lead_id = l.id and e.pinned order by e.created_at desc limit 1),
            l.anonymized
       from public.leads l
       join public.clients c on c.id = l.client_id
       join public.lead_stages s on s.id = l.stage_id
      where ' || private.leads_filter_sql(p_client, p_label, p_q, p_mine)
      || case when p_stage is not null then ' and l.stage_id = $6' else '' end
      || ' order by ' || ord || ', l.id offset $7 limit $8'
    using p_client, p_label, private.leads_like_escape(lower(trim(p_q))), regexp_replace(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '^351', ''),
          auth.uid(), p_stage, greatest(p_offset, 0), least(greatest(p_limit, 1), 200);
end;
$$;

-- Pesquisa global: usa a coluna de pesquisa e o índice das notas.
-- O texto entra na consulta como literal (format %L), para o Postgres usar os índices trigram.
create or replace function public.leads_search(p_q text)
returns table (id uuid, name text, phone text, client_name text, client_color text, stage_name text, found_in text, snippet text)
language plpgsql stable security definer set search_path = public as $$
declare
  t text := lower(trim(coalesce(p_q, '')));
  dg text := regexp_replace(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '^351', '');
  pt text; pd text; has_d boolean;
begin
  if length(t) < 2 then return; end if;
  pt := '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  pd := '%' || dg || '%';
  has_d := length(dg) > 2;
  return query execute format($q$
    with vis as (select l.id from public.leads l
                  where ((select private.leads_is_opera()) and l.client_id in (select private.leads_active_client_ids()))
                     or l.client_id = (select private.leads_my_client_id())),
    hits as (
      select l.id,
             case when lower(l.name) like %1$L then 1 when %3$L and l.phone_norm like %2$L then 2 when lower(l.email) like %1$L then 3 else 4 end as pri,
             case when lower(l.name) like %1$L then 'nome' when %3$L and l.phone_norm like %2$L then 'telefone'
                  when lower(l.email) like %1$L then 'email' else 'interesse' end as found_in,
             case when lower(coalesce(l.interest, '')) like %1$L and lower(l.name) not like %1$L then l.interest end as snippet
        from public.leads l
       where (l.search_text like %1$L or (%3$L and l.search_text like %2$L)) and l.id in (select id from vis)
      union all
      select l.id, 5, 'qualificação', null from public.leads l
       where l.qualification <> '{}'::jsonb and lower(l.qualification::text) like %1$L and l.id in (select id from vis)
      union all
      select e.lead_id, 6, 'notas', left(e.body, 120) from public.lead_events e
       where e.type = 'note' and e.body ilike %1$L and e.lead_id in (select id from vis)
      union all
      select k.lead_id, 7, 'etiqueta', g.name from public.lead_label_links k join public.lead_labels g on g.id = k.label_id
       where lower(g.name) like %1$L and k.lead_id in (select id from vis)
    ),
    best as (select distinct on (h.id) h.* from hits h order by h.id, h.pri)
    select l.id, l.name, l.phone, c.name, c.color, s.name, b.found_in, b.snippet
      from best b
      join public.leads l on l.id = b.id
      join public.clients c on c.id = l.client_id
      join public.lead_stages s on s.id = l.stage_id
     order by b.pri, l.created_at desc
     limit 40 $q$, pt, pd, has_d);
end;
$$;

revoke execute on function private.leads_filter_sql(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function private.leads_visible_filtered(uuid, uuid, text, boolean) from public, anon;
revoke execute on function public.leads_pipeline(uuid, uuid, uuid, text, boolean, text, integer, integer, integer) from public, anon;
revoke execute on function public.leads_search(text) from public, anon;

-- Indicadores e lista Hoje: contam direto nas tabelas, com os índices, em vez de passar por uma lista intermédia.
create index leads_name_idx on public.leads (name);

create or replace function public.leads_pipeline_kpis(p_client uuid default null)
returns table (entraram_hoje bigint, por_contactar bigint, tarefas_atrasadas bigint, qualificadas bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  w text := private.leads_filter_sql(p_client, null, null, false);
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
begin
  return query execute
    'select count(*) filter (where l.created_at >= $9),
            count(*) filter (where s.key in (''meta'', ''imoveis'', ''bd'')),
            (select count(*) from public.lead_tasks t join public.leads l on l.id = t.lead_id
              where t.done_at is null and t.canceled_at is null and t.due_at < now() and ' || w || '),
            count(*) filter (where s.key = ''qualificada'')
       from public.leads l join public.lead_stages s on s.id = l.stage_id
      where ' || w
    using p_client, null::uuid, null::text, null::text, auth.uid(), null::uuid, 0, 0, v_today;
end;
$$;

create or replace function public.leads_today(p_client uuid default null, p_q text default null)
returns table (task_id uuid, task_type text, due_at timestamptz, task_note text, lead_id uuid, lead_name text,
               phone text, interest text, client_name text, client_color text, stage_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  return query execute
    'select t.id, t.type, t.due_at, t.note, l.id, l.name, l.phone, l.interest, c.name, c.color, s.name
       from public.lead_tasks t
       join public.leads l on l.id = t.lead_id
       join public.clients c on c.id = l.client_id
       join public.lead_stages s on s.id = l.stage_id
      where t.done_at is null and t.canceled_at is null and t.due_at < $6 and ' || private.leads_filter_sql(p_client, null, p_q, false)
      || ' order by t.due_at limit 500'
    using p_client, null::uuid, private.leads_like_escape(lower(trim(p_q))),
          regexp_replace(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '^351', ''), auth.uid(),
          (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '2 days') at time zone 'Europe/Lisbon';
end;
$$;
revoke execute on function public.leads_pipeline_kpis(uuid) from public, anon;
revoke execute on function public.leads_today(uuid, text) from public, anon;

alter function private.leads_entry_for_source(text) set search_path = '';
alter function private.leads_filter_sql(uuid, uuid, text, boolean) set search_path = '';
