-- OPERA Leads, Fase 4: Dashboard (só admin e gestores). Tudo calculado aqui, a partir das leads,
-- do histórico (chamadas e mudanças de etapa) e das tarefas.
--
-- p_period: '1' hoje, '7' 7 dias, '30' 30 dias, '0' tudo. O gráfico por dia mostra 7 ou 30 dias ("tudo" mostra 30).
-- Definições (iguais às do protótipo):
--   Time to Lead: chegada ao sistema (created_at) até à primeira chamada, atendida ou não; só leads com
--                 entrada Meta ou portais (entry_stage meta ou imoveis) que entraram no período.
--   Por contactar: dessas, as que ainda não têm chamada e não estão desqualificadas.
--   Recuperadas: leads com entrada BD que passaram a Lead Qualificada no período; percentagem sobre as
--                leads BD trabalhadas (com pelo menos uma chamada no período).
--   Taxa de qualificação: qualificadas sobre decididas (qualificadas + desqualificadas) no período.
--   Tarefas atrasadas: agora, independente do período.
create index if not exists lead_events_stage_to_idx on public.lead_events (to_stage_id, created_at) where type = 'stage';
create index if not exists lead_tasks_done_idx on public.lead_tasks (done_at) where done_at is not null;
create index if not exists leads_created_client_idx on public.leads (created_at, client_id);

create function public.leads_dashboard(p_client uuid default null, p_period text default '7')
returns jsonb
language plpgsql stable security definer set search_path = public set work_mem = '32MB' as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_from timestamptz;
  v_days integer;
  v_target integer;
  v_qual uuid; v_desq uuid;
  v_out jsonb;
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA vê o dashboard.'; end if;
  v_from := case p_period when '1' then v_today when '7' then now() - interval '7 days'
                          when '30' then now() - interval '30 days' else '-infinity'::timestamptz end;
  v_days := case p_period when '1' then 1 when '7' then 7 else 30 end;
  select ttl_target_minutes into v_target from public.leads_settings;
  select id into v_qual from public.lead_stages where key = 'qualificada';
  select id into v_desq from public.lead_stages where key = 'desq';

  -- Cada tabela é percorrida uma só vez e agrupada por cliente; os totais saem da soma por cliente.
  with cl as (
    select c.id, c.name, c.color, c.manager_id from public.clients c
     where c.leads_enabled and c.leads_status = 'ativo' and (p_client is null or c.id = p_client)
  ),
  lin as (
    select l.client_id, l.source, l.entry_stage, l.stage_id,
           case when l.entry_stage in ('meta', 'imoveis') and l.first_call_at is not null
                then extract(epoch from (l.first_call_at - l.created_at)) / 60.0 end as ttl
      from public.leads l where l.client_id in (select id from cl) and l.created_at >= v_from
  ),
  a_lin as (
    select client_id, count(*) as leads_in,
           count(*) filter (where entry_stage in ('meta', 'imoveis') and ttl is null and stage_id <> v_desq) as pending,
           count(ttl) as ttl_n,
           count(*) filter (where ttl <= v_target) as ttl_in_target,
           count(*) filter (where ttl <= 60) as ttl_in_60,
           count(*) filter (where ttl <= 15) as b1, count(*) filter (where ttl > 15 and ttl <= 30) as b2,
           count(*) filter (where ttl > 30 and ttl <= 60) as b3, count(*) filter (where ttl > 60 and ttl <= 240) as b4,
           count(*) filter (where ttl > 240) as b5,
           percentile_cont(0.5) within group (order by ttl) as ttl_median
      from lin group by client_id
  ),
  a_ev as (  -- chamadas e mudanças de etapa no período, numa só passagem pelo histórico
    select l.client_id,
           count(*) filter (where e.type = 'call') as calls,
           count(*) filter (where e.type = 'call' and (e.meta ->> 'answered') = 'true') as answered,
           count(*) filter (where e.type = 'stage' and e.to_stage_id = v_qual) as qual,
           count(*) filter (where e.type = 'stage' and e.to_stage_id = v_desq) as desq,
           count(*) filter (where e.type = 'stage' and e.to_stage_id = v_qual and l.entry_stage = 'bd') as recovered
      from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.created_at >= v_from and l.client_id in (select id from cl)
       and (e.type = 'call' or (e.type = 'stage' and e.to_stage_id in (v_qual, v_desq)))
     group by l.client_id
  ),
  a_bdw as (  -- leads BD com pelo menos uma chamada no período
    select l.client_id, count(*) as bd_worked from public.leads l
     where l.client_id in (select id from cl) and l.entry_stage = 'bd'
       and exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'call' and e.created_at >= v_from)
     group by l.client_id
  ),
  a_late as (
    select l.client_id, count(*) as overdue from public.lead_tasks t join public.leads l on l.id = t.lead_id
     where t.done_at is null and t.canceled_at is null and t.due_at < now() and l.client_id in (select id from cl)
     group by l.client_id
  ),
  per as (
    select c.id, c.name, c.color, c.manager_id,
           coalesce(a.leads_in, 0) leads_in, coalesce(a.pending, 0) pending, coalesce(a.ttl_n, 0) ttl_n,
           coalesce(a.ttl_in_target, 0) ttl_in_target, coalesce(a.ttl_in_60, 0) ttl_in_60, a.ttl_median,
           coalesce(a.b1, 0) b1, coalesce(a.b2, 0) b2, coalesce(a.b3, 0) b3, coalesce(a.b4, 0) b4, coalesce(a.b5, 0) b5,
           coalesce(e.calls, 0) calls, coalesce(e.answered, 0) answered, coalesce(e.qual, 0) qual, coalesce(e.desq, 0) desq,
           coalesce(e.recovered, 0) recovered, coalesce(w.bd_worked, 0) bd_worked, coalesce(t.overdue, 0) overdue
      from cl c left join a_lin a on a.client_id = c.id left join a_ev e on e.client_id = c.id
      left join a_bdw w on w.client_id = c.id left join a_late t on t.client_id = c.id
  ),
  tot as (select coalesce(sum(leads_in), 0) leads_in, coalesce(sum(pending), 0) pending, coalesce(sum(ttl_n), 0) ttl_n, coalesce(sum(ttl_in_target), 0) ttl_in_target,
                 coalesce(sum(ttl_in_60), 0) ttl_in_60, coalesce(sum(b1), 0) b1, coalesce(sum(b2), 0) b2, coalesce(sum(b3), 0) b3, coalesce(sum(b4), 0) b4, coalesce(sum(b5), 0) b5, coalesce(sum(calls), 0) calls,
                 coalesce(sum(answered), 0) answered, coalesce(sum(qual), 0) qual, coalesce(sum(desq), 0) desq, coalesce(sum(recovered), 0) recovered, coalesce(sum(bd_worked), 0) bd_worked,
                 coalesce(sum(overdue), 0) overdue from per)
  select jsonb_build_object(
    'ttl_target', v_target,
    'ttl_median', (select percentile_cont(0.5) within group (order by ttl) from lin where ttl is not null),
    'ttl_avg', (select avg(ttl) from lin where ttl is not null),
    'ttl_n', tot.ttl_n, 'ttl_in_target', tot.ttl_in_target, 'ttl_in_60', tot.ttl_in_60, 'pending', tot.pending,
    'ttl_buckets', jsonb_build_array(tot.b1, tot.b2, tot.b3, tot.b4, tot.b5, tot.pending),
    'leads_in', tot.leads_in, 'days', v_days,
    'calls', tot.calls, 'answered', tot.answered,
    'acts', (select jsonb_build_object('call', count(*) filter (where t.type = 'call'),
                                       'meeting', count(*) filter (where t.type = 'meeting'),
                                       'followup', count(*) filter (where t.type = 'followup'))
               from public.lead_tasks t join public.leads l on l.id = t.lead_id
              where t.done_at >= v_from and l.client_id in (select id from cl)),
    'qual', tot.qual, 'desq', tot.desq,
    'time_to_qualify', (select percentile_cont(0.5) within group (order by extract(epoch from (e.created_at - l.created_at)) / 60.0)
                          from public.lead_events e join public.leads l on l.id = e.lead_id
                         where e.type = 'stage' and e.to_stage_id = v_qual and e.created_at >= v_from and l.client_id in (select id from cl)),
    'recovered', tot.recovered, 'bd_worked', tot.bd_worked, 'overdue', tot.overdue,
    'per_day', (select coalesce(jsonb_agg(jsonb_build_object('d', d.d, 'v', coalesce(x.n, 0)) order by d.d), '[]'::jsonb)
                  from generate_series((v_today at time zone 'Europe/Lisbon')::date - (v_days - 1),
                                       (v_today at time zone 'Europe/Lisbon')::date, interval '1 day') g(dd)
                  cross join lateral (select g.dd::date as d) d
                  left join (select (l.created_at at time zone 'Europe/Lisbon')::date as d, count(*) n from public.leads l
                              where l.client_id in (select id from cl)
                                and l.created_at >= ((v_today at time zone 'Europe/Lisbon')::date - (v_days - 1))::timestamp at time zone 'Europe/Lisbon'
                              group by 1) x on x.d = d.d),
    'by_source', (select coalesce(jsonb_agg(jsonb_build_object('l', s, 'v', n) order by n desc), '[]'::jsonb)
                    from (select coalesce(source, 'Sem origem') s, count(*) n from lin group by 1) x),
    'per_client', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'color', p.color,
        'manager', (select full_name from public.profiles pr where pr.id = p.manager_id),
        'leads_in', p.leads_in, 'ttl_median', p.ttl_median, 'ttl_n', p.ttl_n, 'ttl_in_target', p.ttl_in_target,
        'calls', p.calls, 'qual', p.qual, 'desq', p.desq, 'recovered', p.recovered, 'overdue', p.overdue) order by p.name), '[]'::jsonb) from per p)
  ) into v_out from tot;
  return v_out;
end;
$$;

-- Taxa de ocupação por gestor: clientes ativos atribuídos sobre o máximo de 8, leads em trabalho
-- (antes de Lead Qualificada, sem as desqualificadas) e tarefas atrasadas de cada gestor.
create function public.leads_managers_load()
returns table (id uuid, name text, role text, clients jsonb, leads_working bigint, overdue bigint)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(p.full_name, p.email), p.leads_role,
         coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                     from public.clients c where c.manager_id = p.id and c.leads_enabled and c.leads_status = 'ativo'), '[]'::jsonb),
         (select count(*) from public.leads l join public.lead_stages s on s.id = l.stage_id
           join public.clients c on c.id = l.client_id
           where c.manager_id = p.id and c.leads_enabled and c.leads_status = 'ativo' and s.position < 50),
         (select count(*) from public.lead_tasks t join public.leads l on l.id = t.lead_id
           join public.clients c on c.id = l.client_id
           where c.manager_id = p.id and c.leads_enabled and c.leads_status = 'ativo'
             and t.done_at is null and t.canceled_at is null and t.due_at < now())
    from public.profiles p
   where private.leads_is_opera() and p.leads_status = 'ativo'
     and (p.leads_role = 'gestor' or (p.leads_role = 'admin' and exists (select 1 from public.clients c where c.manager_id = p.id)))
   order by 2;
$$;

-- Objetivo do Time to Lead (minutos), configurável pelo admin.
create function public.leads_set_ttl_target(p_minutes integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_admin() then raise exception 'Só o admin muda o objetivo.'; end if;
  update public.leads_settings set ttl_target_minutes = p_minutes where id;
  perform public.leads_audit('objetivo_time_to_lead', jsonb_build_object('minutos', p_minutes));
end;
$$;

revoke execute on function public.leads_dashboard(uuid, text) from public, anon;
revoke execute on function public.leads_managers_load() from public, anon;
revoke execute on function public.leads_set_ttl_target(integer) from public, anon;
