-- OPERA Leads: dashboard também para os clientes e leads qualificadas por tipo (decisões do Fábio, 2026-10-24).
--
-- * Cada utilizador de cliente vê o dashboard só com os números do seu cliente (sem a taxa de ocupação dos gestores,
--   que continua só para a equipa OPERA em leads_managers_load).
-- * O "Objetivo" da qualificação passa a ser uma escolha entre Comprador, Proprietário e Crédito (pode ter vários),
--   guardada como texto ("Comprador, Crédito") para os emails e a exportação continuarem iguais.
-- * É obrigatório indicar o Objetivo para passar uma lead a Lead Qualificada. As leads importadas já
--   qualificadas e as criadas pelo cliente em Lead Qualificada não passam por esta regra (não mudam de etapa).

-- Tipos indicados no Objetivo. Aceita também texto antigo ("compra", "vender", "financiamento").
create function private.leads_objetivo_tipos(p text) returns text[]
language sql immutable set search_path = '' as $$
  select array_remove(array[
    case when coalesce(p, '') ~* 'compr' then 'Comprador' end,
    case when coalesce(p, '') ~* 'propriet|vend' then 'Proprietário' end,
    case when coalesce(p, '') ~* 'cr[eé]dito|financ' then 'Crédito' end], null);
$$;
grant execute on function private.leads_objetivo_tipos(text) to authenticated, service_role;

-- Para qualificar é preciso o Objetivo.
create function public.leads_require_objetivo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage_id is distinct from old.stage_id and not new.anonymized
     and (select key from public.lead_stages where id = new.stage_id) = 'qualificada'
     and coalesce((select position from public.lead_stages where id = old.stage_id), 0) < 50
     and cardinality(private.leads_objetivo_tipos(new.qualification ->> 'Objetivo')) = 0 then
    raise exception 'Indica o Objetivo da lead (Comprador, Proprietário ou Crédito) antes de a qualificar.';
  end if;
  return new;
end;
$$;
revoke execute on function public.leads_require_objetivo() from public, anon, authenticated;
create trigger leads_require_objetivo before update of stage_id on public.leads
  for each row execute function public.leads_require_objetivo();

-- Dashboard: igual ao da Fase 4, aberto aos clientes (só o seu) e com as qualificadas por tipo.
create or replace function public.leads_dashboard(p_client uuid default null, p_period text default '7')
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
  -- A equipa OPERA vê todos os clientes ativos; cada cliente vê só o seu (o filtro é imposto aqui).
  if not private.leads_is_opera() then
    p_client := private.leads_my_client_id();
    if p_client is null then raise exception 'Sem acesso ao dashboard.'; end if;
  end if;
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
    -- Leads qualificadas no período por tipo (Objetivo). Uma lead pode ter vários tipos.
    'qual_types', (select jsonb_build_object(
        'comprador', count(*) filter (where 'Comprador' = any (t.tipos)),
        'proprietario', count(*) filter (where 'Proprietário' = any (t.tipos)),
        'credito', count(*) filter (where 'Crédito' = any (t.tipos)),
        'sem_tipo', count(*) filter (where cardinality(t.tipos) = 0))
      from (select distinct on (l.id) private.leads_objetivo_tipos(l.qualification ->> 'Objetivo') as tipos
              from public.lead_events e join public.leads l on l.id = e.lead_id
             where e.type = 'stage' and e.to_stage_id = v_qual and e.created_at >= v_from
               and l.client_id in (select id from cl)) t),
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
