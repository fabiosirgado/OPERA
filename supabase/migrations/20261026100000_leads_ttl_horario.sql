-- OPERA Leads: o Time to Lead conta só o tempo dentro do horário de trabalho.
-- Horário: segunda a sexta, das 9:30 às 19:00 (Lisboa); os feriados nacionais contam como fim de semana.
-- Uma lead que entra fora do horário começa a contar às 9:30 do dia útil seguinte; ligada antes disso conta 0.
-- Decidido a 2026-10-26: a hora de almoço conta como horário de trabalho.

-- Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), para a Sexta Feira Santa e o Corpo de Deus.
create function private.leads_easter(p_year integer) returns date
language plpgsql immutable set search_path = '' as $$
declare a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int;
begin
  a := p_year % 19; b := p_year / 100; c := p_year % 100; d := b / 4; e := b % 4;
  f := (b + 8) / 25; g := (b - f + 1) / 3; h := (19 * a + b - d - g + 15) % 30;
  i := c / 4; k := c % 4; l := (32 + 2 * e + 2 * i - h - k) % 7; m := (a + 11 * h + 22 * l) / 451;
  return make_date(p_year, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
end;
$$;

-- Dia útil: segunda a sexta e não é feriado nacional em Portugal.
create function private.leads_is_workday(p_day date) returns boolean
language sql immutable set search_path = '' as $$
  select extract(isodow from p_day) < 6
     and to_char(p_day, 'MM-DD') not in ('01-01', '04-25', '05-01', '06-10', '08-15', '10-05', '11-01', '12-01', '12-08', '12-25')
     and p_day not in (private.leads_easter(extract(year from p_day)::int) - 2,     -- Sexta Feira Santa
                       private.leads_easter(extract(year from p_day)::int) + 60);   -- Corpo de Deus
$$;

-- Minutos de trabalho entre dois instantes (segunda a sexta, 9:30 às 19:00 em Lisboa, sem feriados).
create function public.leads_business_minutes(p_from timestamptz, p_to timestamptz) returns numeric
language sql immutable security definer set search_path = '' as $$
  select case when p_from is null or p_to is null or p_to <= p_from then 0 else coalesce((
    select sum(greatest(0, extract(epoch from (
             least(p_to, (d + time '19:00') at time zone 'Europe/Lisbon')
             - greatest(p_from, (d + time '09:30') at time zone 'Europe/Lisbon'))) / 60.0))
      from generate_series((p_from at time zone 'Europe/Lisbon')::date, (p_to at time zone 'Europe/Lisbon')::date, interval '1 day') g(dd)
      cross join lateral (select g.dd::date as d) x
     where private.leads_is_workday(x.d)), 0)::numeric end;
$$;
revoke execute on function public.leads_business_minutes(timestamptz, timestamptz) from public, anon;
grant execute on function public.leads_business_minutes(timestamptz, timestamptz) to authenticated;

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
    -- Sem filtro de cliente, os clientes internos (a própria OPERA) ficam de fora.
    select c.id, c.name, c.color, c.manager_id from public.clients c
     where c.leads_enabled and c.leads_status = 'ativo'
       and (c.id = p_client or (p_client is null and not c.leads_internal))
  ),
  lin as (
    -- Time to Lead em minutos de trabalho (segunda a sexta, 9:30 às 19:00, sem feriados).
    select l.client_id, l.source, l.entry_stage, l.stage_id,
           case when l.entry_stage in ('meta', 'imoveis') and l.first_call_at is not null
                then public.leads_business_minutes(l.created_at, l.first_call_at) end as ttl
      from public.leads l where l.client_id in (select id from cl) and l.created_at >= v_from and not l.imported
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
     where e.created_at >= v_from and l.client_id in (select id from cl) and not (e.meta ? 'imported')
       and (e.type = 'call' or (e.type = 'stage' and e.to_stage_id in (v_qual, v_desq)))
     group by l.client_id
  ),
  a_bdw as (  -- leads BD com pelo menos uma chamada no período
    select l.client_id, count(*) as bd_worked from public.leads l
     where l.client_id in (select id from cl) and l.entry_stage = 'bd'
       and exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'call' and e.created_at >= v_from and not (e.meta ? 'imported'))
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
                              where l.client_id in (select id from cl) and not l.imported
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
