-- OPERA Leads: o histórico importado não conta no dashboard (decisão do Fábio, 2026-10-24).
--
-- * leads.imported: leads trazidas de outro sistema (Pipedrive por API ou Excel). Não contam como "Leads que entraram",
--   nem por dia, nem por origem. O trabalho feito nelas a partir de agora (chamadas, qualificações) conta normalmente.
-- * Eventos com meta.imported (por exemplo chamadas antigas do Pipedrive) ficam no histórico da lead mas não contam
--   nas chamadas, qualificações nem leads trabalhadas.

alter table public.leads add column imported boolean not null default false;
update public.leads l set imported = true
 where l.external_id like 'pipedrive%'
    or exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'auto'
                and e.title in ('Lead importada de Excel', 'Lead importada do Pipedrive'));

-- Importar de Excel: as leads novas ficam marcadas como importadas.
create or replace function public.leads_import_batch(p_rows jsonb, p_dup text, p_file text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record; v_existing public.leads; v_stage public.lead_stages; v_id uuid; v_label uuid; v_name text;
  v_created integer := 0; v_updated integer := 0; v_ignored integer := 0; v_errors jsonb := '[]'::jsonb;
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA importa leads.'; end if;
  if p_dup not in ('ignore', 'fill', 'create') then raise exception 'Opção de duplicados inválida.'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'Lote demasiado grande.'; end if;

  for r in select * from jsonb_to_recordset(p_rows) as x(line integer, client_id uuid, stage_id uuid, name text, phone text,
             email text, source text, interest text, budget text, labels jsonb, note text, source_date text)
  loop
    begin
      if r.client_id is null or r.client_id not in (select private.leads_active_client_ids()) then
        v_errors := v_errors || jsonb_build_object('line', r.line, 'reason', 'Cliente não reconhecido'); continue;
      end if;
      if coalesce(trim(r.name), '') = '' then
        v_errors := v_errors || jsonb_build_object('line', r.line, 'reason', 'Sem nome'); continue;
      end if;
      if coalesce(trim(r.phone), '') = '' and coalesce(trim(r.email), '') = '' then
        v_errors := v_errors || jsonb_build_object('line', r.line, 'reason', 'Sem telemóvel nem email'); continue;
      end if;
      select * into v_stage from public.lead_stages where id = r.stage_id and (client_id is null or client_id = r.client_id);
      if v_stage.id is null then
        v_errors := v_errors || jsonb_build_object('line', r.line, 'reason', 'Etapa inválida para este cliente'); continue;
      end if;

      select * into v_existing from public.leads l
       where l.client_id = r.client_id and not l.anonymized
         and ((length(coalesce(private.leads_normalize_phone(r.phone), '')) >= 6 and l.phone_norm = private.leads_normalize_phone(r.phone))
              or (nullif(trim(r.email), '') is not null and lower(l.email) = lower(trim(r.email))))
       limit 1;

      if v_existing.id is not null and p_dup = 'ignore' then
        v_ignored := v_ignored + 1; continue;
      end if;

      if v_existing.id is not null and p_dup = 'fill' then
        update public.leads set
          phone = coalesce(phone, nullif(trim(r.phone), '')),
          email = coalesce(email, nullif(lower(trim(r.email)), '')),
          interest = coalesce(interest, nullif(trim(r.interest), '')),
          source = coalesce(source, nullif(trim(r.source), '')),
          qualification = case when nullif(trim(r.budget), '') is not null and not (qualification ? 'Budget')
                               then qualification || jsonb_build_object('Budget', trim(r.budget)) else qualification end
         where id = v_existing.id;
        v_id := v_existing.id;
        v_updated := v_updated + 1;
      else
        insert into public.leads (client_id, name, phone, email, source, interest, stage_id, entry_stage, qualification,
                                  source_created_at, created_by, imported)
        values (r.client_id, trim(r.name), nullif(trim(r.phone), ''), nullif(lower(trim(r.email)), ''),
                coalesce(nullif(trim(r.source), ''), 'Base de dados'), nullif(trim(r.interest), ''), v_stage.id, 'bd',
                case when nullif(trim(r.budget), '') is null then '{}'::jsonb else jsonb_build_object('Budget', trim(r.budget)) end,
                case when r.source_date ~ '^\d{4}-\d{2}-\d{2}' then r.source_date::timestamptz end,
                auth.uid(), true)
        returning id into v_id;
        insert into public.lead_events (lead_id, type, title, body, author_id)
        values (v_id, 'auto', 'Lead importada de Excel', 'Ficheiro ' || coalesce(p_file, ''), auth.uid());
        if nullif(trim(r.note), '') is not null then
          insert into public.lead_events (lead_id, type, title, body, author_id) values (v_id, 'note', 'Nota', trim(r.note), auth.uid());
        end if;
        -- Nenhuma lead nasce com tarefa automática (decisão do Fábio, ver 20261022160000_leads_sem_tarefa_auto.sql).
        v_created := v_created + 1;
      end if;

      -- Etiquetas: as que não existem são criadas a cinzento.
      for v_name in select distinct trim(x) from jsonb_array_elements_text(coalesce(r.labels, '[]'::jsonb)) x where trim(x) <> '' loop
        select id into v_label from public.lead_labels where lower(name) = lower(v_name);
        if v_label is null then
          insert into public.lead_labels (name, color) values (left(v_name, 40), 'cinzento') returning id into v_label;
        end if;
        insert into public.lead_label_links (lead_id, label_id) values (v_id, v_label) on conflict do nothing;
        v_label := null;
      end loop;
    exception when others then
      v_errors := v_errors || jsonb_build_object('line', r.line, 'reason', 'Erro ao gravar esta linha');
    end;
    v_existing := null; v_stage := null;
  end loop;

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'ignored', v_ignored, 'errors', v_errors);
end;
$$;

revoke execute on function public.leads_import_batch(jsonb, text, text) from public, anon;

-- Dashboard: igual, sem o histórico importado.
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
