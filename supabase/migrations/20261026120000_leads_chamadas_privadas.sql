-- OPERA Leads: a análise das chamadas (resumo, notas, transcrição) é só para a equipa OPERA.
--
-- Até aqui o cliente via no histórico da lead a nota "Resumo da chamada (CloudTalk)", com a transcrição, e a análise
-- guardada na própria chamada (meta.ci). O áudio já era só da equipa OPERA.
-- 1. Notas internas: lead_events.internal. O cliente não as vê (RLS), nem na pesquisa nem na exportação.
--    Uma nota interna não se afixa, porque as notas afixadas aparecem ao cliente (cartões e email de lead qualificada).
-- 2. A análise sai de lead_events.meta.ci para lead_call_insights, que só a equipa OPERA lê.
-- 3. As chamadas da equipa OPERA também são internas: o cliente não vê as linhas "Chamada CloudTalk, atendida".
--    As chamadas importadas do histórico (Pipedrive) continuam visíveis, porque são o trabalho do próprio cliente.

alter table public.lead_events add column internal boolean not null default false;

create table public.lead_call_insights (
  call_id text primary key,
  lead_id uuid not null references public.leads (id) on delete cascade,
  ci jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index lead_call_insights_lead_idx on public.lead_call_insights (lead_id);
alter table public.lead_call_insights enable row level security;
create policy "opera vê a análise das chamadas" on public.lead_call_insights for select
  using (private.leads_is_opera() and private.leads_can_read(lead_id));

-- Dados que já existem: passa a análise para a tabela nova e marca as notas da CloudTalk como internas.
-- As regras do histórico não deixam mudar estes campos a quem trabalha na app; aqui é a própria migração.
set local session_replication_role = replica;
insert into public.lead_call_insights (call_id, lead_id, ci, updated_at)
select distinct on (e.meta ->> 'call_id') e.meta ->> 'call_id', e.lead_id, e.meta -> 'ci',
       coalesce((e.meta -> 'ci' ->> 'at')::timestamptz, now())
  from public.lead_events e
 where e.type = 'call' and e.meta ? 'ci' and e.meta ? 'call_id'
 order by e.meta ->> 'call_id', e.created_at desc
on conflict (call_id) do nothing;
update public.lead_events set meta = meta - 'ci' where type = 'call' and meta ? 'ci';
update public.lead_events set internal = true, pinned = false where type = 'note' and meta ? 'ci_call_id';
update public.lead_events set internal = true, pinned = false where type = 'call' and not (meta ? 'imported');
set local session_replication_role = origin;

alter table public.lead_events add constraint lead_events_interna_sem_afixar check (not (internal and pinned));

drop policy "ver histórico" on public.lead_events;
create policy "ver histórico" on public.lead_events for select
  using (private.leads_can_read(lead_id) and (not internal or private.leads_is_opera()));

-- A análise de cada chamada vai para lead_call_insights; a nota "Resumo da chamada (CloudTalk)" fica interna.
create or replace function public.leads_cloudtalk_ci(p_call_id text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid; v_at timestamptz; v_ci jsonb; v_body text; v_note uuid;
begin
  select e.lead_id, e.created_at into v_lead, v_at
    from public.lead_events e join public.leads l on l.id = e.lead_id
   where e.type = 'call' and e.meta ->> 'call_id' = p_call_id and not l.anonymized
   order by e.created_at desc limit 1;
  -- Chamada que não é de nenhuma lead: a análise não se guarda (RGPD).
  if v_lead is null then
    return jsonb_build_object('status', 'sem_lead');
  end if;

  insert into public.lead_call_insights (call_id, lead_id, ci)
  values (p_call_id, v_lead, jsonb_strip_nulls(p) || jsonb_build_object('at', now()))
  on conflict (call_id) do update
     set ci = lead_call_insights.ci || excluded.ci, lead_id = excluded.lead_id, updated_at = now()
  returning ci into v_ci;

  v_body := concat_ws(E'\n\n',
    nullif(trim(v_ci ->> 'summary'), ''),
    (select string_agg('• ' || x, E'\n') from jsonb_array_elements_text(coalesce(v_ci -> 'notes', '[]')) x),
    nullif(concat_ws(' · ',
      'Sentimento ' || case lower(v_ci ->> 'sentiment') when 'positive' then 'positivo' when 'neutral' then 'neutro'
                         when 'negative' then 'negativo' else nullif(v_ci ->> 'sentiment', '') end,
      'Temas: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(v_ci -> 'topics', '[]')) x)), ''),
    'Transcrição' || E'\n' || (select string_agg(coalesce(nullif(e ->> 's', '') || ': ', '') || (e ->> 'x'), E'\n')
                                 from jsonb_array_elements(coalesce(v_ci -> 'transcript', '[]')) e));

  select id into v_note from public.lead_events
   where lead_id = v_lead and type = 'note' and meta ->> 'ci_call_id' = p_call_id limit 1;
  if v_note is null then
    insert into public.lead_events (lead_id, type, title, body, meta, author_id, created_at, internal)
    values (v_lead, 'note', 'Resumo da chamada (CloudTalk)', v_body,
            jsonb_build_object('via', 'cloudtalk', 'ci_call_id', p_call_id), null, v_at + interval '1 second', true);
  else
    update public.lead_events set body = v_body where id = v_note;
    -- Escrita pelo sistema: não aparece como "editada".
    update public.lead_events set edited_at = null where id = v_note;
  end if;
  return jsonb_build_object('status', 'processado', 'lead_id', v_lead);
end;
$$;
revoke execute on function public.leads_cloudtalk_ci(text, jsonb) from public, anon, authenticated;
grant execute on function public.leads_cloudtalk_ci(text, jsonb) to service_role;

-- As chamadas registam-se sempre como internas (só a equipa OPERA liga).
create or replace function private.leads_apply_call(p_lead_id uuid, p_title text, p_meta jsonb, p_at timestamptz, p_author uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_lead public.leads; v_key text; v_task uuid; v_event uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null then raise exception 'Lead não encontrada.'; end if;

  update public.leads
     set attempts = attempts + 1,
         first_call_at = least(coalesce(first_call_at, p_at), p_at),
         last_contact_at = greatest(coalesce(last_contact_at, p_at), p_at)
   where id = p_lead_id;

  insert into public.lead_events (lead_id, type, title, meta, author_id, created_at, internal)
  values (p_lead_id, 'call', p_title, coalesce(p_meta, '{}'::jsonb), p_author, p_at, true)
  returning id into v_event;

  select id into v_task from public.lead_tasks
   where lead_id = p_lead_id and type = 'call' and done_at is null and canceled_at is null
   order by due_at limit 1;
  if v_task is not null then update public.lead_tasks set done_at = p_at where id = v_task; end if;

  select key into v_key from public.lead_stages where id = v_lead.stage_id;
  if v_key in ('meta', 'imoveis', 'bd') then
    update public.leads set stage_id = (select id from public.lead_stages where key = 'followup') where id = p_lead_id;
  end if;
  return v_event;
end;
$$;
revoke execute on function private.leads_apply_call(uuid, text, jsonb, timestamptz, uuid) from public, anon, authenticated;

-- Anonimização: a análise das chamadas também sai.
create or replace function private.leads_anonymize(p_lead_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('opera.leads_rpc', 'on', true);
  update public.leads
     set name = 'Titular apagado', phone = null, email = null, interest = null, source = null,
         qualification = '{}'::jsonb, owner_user_id = null, external_id = null, anonymized = true,
         stage_id = (select id from public.lead_stages where key = 'desq')
   where id = p_lead_id;
  delete from public.lead_label_links where lead_id = p_lead_id;
  delete from public.lead_events where lead_id = p_lead_id and type not in ('call', 'stage');
  update public.lead_events set title = null, body = null, pinned = false,
         meta = meta - 'recording_url' - 'notes' - 'ci'
   where lead_id = p_lead_id;
  delete from public.lead_call_insights where lead_id = p_lead_id;
  delete from public.lead_tasks where lead_id = p_lead_id and done_at is null;
  update public.lead_tasks set note = null where lead_id = p_lead_id;
  insert into public.lead_events (lead_id, type, title, body, author_id)
  values (p_lead_id, 'auto', 'Dados pessoais apagados', 'Motivo: ' || p_reason, auth.uid());
end;
$$;
revoke execute on function private.leads_anonymize(uuid, text) from public, anon, authenticated;

-- Pesquisa: o cliente não encontra leads pelo texto das notas internas.
create or replace function public.leads_search(p_q text)
returns table (id uuid, name text, phone text, client_name text, client_color text, stage_name text, found_in text, snippet text)
language plpgsql stable security definer set search_path = public as $function$
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
         and (not e.internal or (select private.leads_is_opera()))
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
$function$;

-- Exportação: as notas internas nunca saem (a exportação de um cliente é a que se lhe entrega quando sai).
create or replace function public.leads_export(p_client uuid default null, p_stages uuid[] default null,
  p_since timestamptz default null, p_history boolean default false, p_offset integer default 0)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v_total integer; v_rows jsonb;
  v_admin boolean := private.leads_is_admin();
  v_opera boolean := private.leads_is_opera();
  v_mine uuid := private.leads_my_client_id();
begin
  if private.leads_role() is null then raise exception 'Sem acesso ao OPERA Leads.'; end if;

  select count(*) into v_total from public.leads l
   where (v_admin or (v_opera and l.client_id in (select private.leads_active_client_ids())) or l.client_id = v_mine)
     and (p_client is null or l.client_id = p_client)
     and (p_stages is null or l.stage_id = any (p_stages))
     and (p_since is null or l.created_at >= p_since)
     and not l.anonymized;

  select coalesce(jsonb_agg(row_to_json(x) order by x.entrada), '[]'::jsonb) into v_rows from (
    select c.name as cliente, l.name as nome, l.phone as telemovel, l.email, l.source as origem, l.interest as interesse,
           s.name as etapa, l.created_at as entrada, l.next_task_type as proxima_tarefa, l.next_task_at as proxima_tarefa_em,
           l.attempts as tentativas, l.last_contact_at as ultimo_contacto, l.qualification as qualificacao,
           (select p.full_name from public.profiles p where p.id = l.owner_user_id) as responsavel,
           (select string_agg(g.name, ', ' order by g.name) from public.lead_label_links k join public.lead_labels g on g.id = k.label_id where k.lead_id = l.id) as etiquetas,
           (select string_agg(e.body, ' | ' order by e.created_at) from public.lead_events e where e.lead_id = l.id and e.pinned) as notas_afixadas,
           case when p_history then (
             select string_agg(to_char(e.created_at at time zone 'Europe/Lisbon', 'DD/MM/YYYY HH24:MI') || ' ' ||
                               coalesce(e.title, e.type) || coalesce(': ' || e.body, ''), E'\n' order by e.created_at)
               from public.lead_events e where e.lead_id = l.id and not e.internal) end as historico
      from public.leads l
      join public.clients c on c.id = l.client_id
      join public.lead_stages s on s.id = l.stage_id
     where (v_admin or (v_opera and l.client_id in (select private.leads_active_client_ids())) or l.client_id = v_mine)
       and (p_client is null or l.client_id = p_client)
       and (p_stages is null or l.stage_id = any (p_stages))
       and (p_since is null or l.created_at >= p_since)
       and not l.anonymized
     order by l.created_at, l.id
     offset greatest(p_offset, 0) limit 1000) x;

  if coalesce(p_offset, 0) = 0 then
    perform public.leads_audit('exportacao', jsonb_build_object('ambito', case when p_client is null then 'todos' else 'cliente' end,
                               'client_id', p_client, 'leads', v_total, 'historico', p_history));
  end if;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$function$;
