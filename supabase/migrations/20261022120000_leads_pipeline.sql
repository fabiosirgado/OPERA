-- OPERA Leads, Fase 2: regras de negócio do pipeline, consultas no servidor e desempenho.
-- Tudo o que filtra, ordena, pesquisa e pagina corre aqui, com o RLS de quem chama.

-- ============================================================ DESEMPENHO DO RLS
-- Clientes ativos no Leads, calculados uma vez por pedido em vez de uma vez por lead.
create function private.leads_active_client_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.clients where leads_enabled and leads_status = 'ativo';
$$;

-- As políticas das leads passam a usar (select ...), que o Postgres avalia uma só vez por consulta.
drop policy "ver leads" on public.leads;
drop policy "opera cria leads" on public.leads;
drop policy "cliente cria leads suas" on public.leads;
drop policy "opera edita leads" on public.leads;
drop policy "cliente edita leads qualificadas" on public.leads;
drop policy "admin apaga leads" on public.leads;

create policy "ver leads" on public.leads for select
  using ((select private.leads_is_admin())
         or ((select private.leads_is_opera()) and client_id in (select private.leads_active_client_ids()))
         or client_id = (select private.leads_my_client_id()));
create policy "opera cria leads" on public.leads for insert
  with check ((select private.leads_is_opera()) and client_id in (select private.leads_active_client_ids())
              and private.lead_stage_fits(stage_id, client_id));
create policy "cliente cria leads suas" on public.leads for insert
  with check (client_id = (select private.leads_my_client_id()) and private.lead_stage_fits(stage_id, client_id));
create policy "opera edita leads" on public.leads for update
  using ((select private.leads_is_opera()) and client_id in (select private.leads_active_client_ids()))
  with check ((select private.leads_is_opera()) and client_id in (select private.leads_active_client_ids())
              and private.lead_stage_fits(stage_id, client_id));
create policy "cliente edita leads qualificadas" on public.leads for update
  using (client_id = (select private.leads_my_client_id()) and private.lead_stage_position(stage_id) >= 50)
  with check (client_id = (select private.leads_my_client_id()) and private.lead_stage_position(stage_id) >= 50
              and private.lead_stage_fits(stage_id, client_id));
create policy "admin apaga leads" on public.leads for delete
  using ((select private.leads_is_admin()));

-- ============================================================ PRÓXIMA TAREFA E ÚLTIMO CONTACTO
-- Guardadas na lead para ordenar e mostrar o cartão sem consultar as tarefas de cada lead.
alter table public.leads
  add column next_task_at timestamptz,
  add column next_task_type text;
create index leads_client_stage_next_idx on public.leads (client_id, stage_id, next_task_at);
create index leads_created_idx on public.leads (created_at desc);
create index lead_tasks_open_lead_idx on public.lead_tasks (lead_id, due_at) where done_at is null and canceled_at is null;
create index lead_events_pinned_idx on public.lead_events (lead_id, created_at desc) where pinned;

create function private.leads_refresh_next_task(p_lead_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.leads l
     set next_task_at = t.due_at, next_task_type = t.type
    from (select
            (select due_at from public.lead_tasks where lead_id = p_lead_id and done_at is null and canceled_at is null order by due_at limit 1) as due_at,
            (select type from public.lead_tasks where lead_id = p_lead_id and done_at is null and canceled_at is null order by due_at limit 1) as type) t
   where l.id = p_lead_id
     and (l.next_task_at is distinct from t.due_at or l.next_task_type is distinct from t.type);
$$;

create function public.lead_tasks_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform private.leads_refresh_next_task(coalesce(new.lead_id, old.lead_id));
  return null;
end;
$$;
create trigger lead_tasks_after_write after insert or update or delete on public.lead_tasks
  for each row execute function public.lead_tasks_after_write();

-- Tarefa concluída: regista quem a fez.
create function public.lead_tasks_before_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.done_at is not null and old.done_at is null then new.done_by := auth.uid(); end if;
  return new;
end;
$$;
create trigger lead_tasks_before_update before update on public.lead_tasks
  for each row execute function public.lead_tasks_before_update();

-- Nota editada: fica marcada.
create function public.lead_events_before_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.body is distinct from old.body then new.edited_at := now(); end if;
  if new.type is distinct from old.type or new.lead_id is distinct from old.lead_id
     or new.author_id is distinct from old.author_id or new.created_at is distinct from old.created_at then
    raise exception 'Só o texto e a marca de afixada de uma nota podem mudar.';
  end if;
  return new;
end;
$$;
create trigger lead_events_before_update before update on public.lead_events
  for each row execute function public.lead_events_before_update();

-- ============================================================ AVISOS (estrutura para a Fase 7)
-- Fila de avisos a enviar (email agora, WhatsApp depois). O envio é feito por uma função no servidor.
create table public.lead_notifications (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  kind text not null check (kind in ('qualificada', 'nova_lead_do_cliente')),
  channel text not null default 'email' check (channel in ('email', 'whatsapp')),
  status text not null default 'pendente' check (status in ('pendente', 'enviado', 'erro', 'cancelado')),
  sent_at timestamptz,
  error text
);
create index lead_notifications_pending_idx on public.lead_notifications (created_at) where status = 'pendente';
alter table public.lead_notifications enable row level security;
create policy "opera vê avisos" on public.lead_notifications for select using ((select private.leads_is_opera()));

-- ============================================================ REGRAS DAS ETAPAS
-- Lead Qualificada: cancela tarefas em aberto, cria Follow up a 24 h e põe o aviso ao cliente na fila.
-- Lead desqualificada: cancela as tarefas em aberto.
create function public.leads_stage_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_key text; v_from numeric;
begin
  if new.stage_id is not distinct from old.stage_id then return null; end if;
  select key into v_key from public.lead_stages where id = new.stage_id;
  select position into v_from from public.lead_stages where id = old.stage_id;

  if v_key in ('qualificada', 'desq') then
    update public.lead_tasks set canceled_at = now()
     where lead_id = new.id and done_at is null and canceled_at is null;
  end if;

  if v_key = 'qualificada' and v_from < 50 and not new.anonymized then
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (new.id, 'followup', now() + interval '24 hours', 'Confirmar com o cliente', auth.uid());
    insert into public.lead_notifications (lead_id, kind) values (new.id, 'qualificada');
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (new.id, 'auto', 'Cliente vai ser avisado',
            'O resumo da lead segue por email para o responsável no cliente ou, sem responsável, para todos os utilizadores ativos do cliente.',
            auth.uid());
  end if;
  return null;
end;
$$;
create trigger leads_stage_rules after update of stage_id on public.leads
  for each row execute function public.leads_stage_rules();

-- ============================================================ CRIAR LEAD
-- Etapa inicial pela origem: Meta, portais imobiliários, ou base de dados.
create function private.leads_entry_for_source(p_source text) returns text
language sql immutable as $$
  select case when p_source = 'Meta' then 'meta'
              when p_source in ('Idealista', 'Imovirtual', 'Casa Sapo') then 'imoveis'
              else 'bd' end;
$$;

-- Duplicado: mesmo telefone normalizado ou mesmo email, no mesmo cliente. Corre com o RLS de quem chama.
create function public.leads_find_duplicate(p_client_id uuid, p_phone text, p_email text)
returns table (id uuid, name text, stage_name text)
language sql stable security invoker set search_path = public as $$
  select l.id, l.name, s.name
    from public.leads l join public.lead_stages s on s.id = l.stage_id
   where l.client_id = p_client_id and not l.anonymized
     and ((length(coalesce(private.leads_normalize_phone(p_phone), '')) >= 6 and l.phone_norm = private.leads_normalize_phone(p_phone))
          or (nullif(trim(p_email), '') is not null and lower(l.email) = lower(trim(p_email))))
   limit 1;
$$;

-- p: { client_id, name, phone, email, source, interest, budget, stage ('auto' ou chave/id de etapa),
--      first_task_minutes, note, note_pinned }
create function public.leads_create(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := (p ->> 'client_id')::uuid;
  v_opera boolean := private.leads_is_opera();
  v_source text := coalesce(nullif(p ->> 'source', ''), 'Outra');
  v_entry text := private.leads_entry_for_source(v_source);
  v_stage_in text := coalesce(nullif(p ->> 'stage', ''), 'auto');
  v_stage uuid; v_pos numeric; v_id uuid;
  v_minutes integer := coalesce((p ->> 'first_task_minutes')::integer, 60);
begin
  if not (v_opera and v_client in (select private.leads_active_client_ids()))
     and v_client is distinct from private.leads_my_client_id() then
    raise exception 'Sem permissão para criar leads neste cliente.';
  end if;
  if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Indica o nome.'; end if;

  if v_stage_in = 'auto' then
    select id into v_stage from public.lead_stages where key = v_entry;
  else
    select id into v_stage from public.lead_stages
     where (key = v_stage_in or id::text = v_stage_in) and (client_id is null or client_id = v_client);
  end if;
  if v_stage is null then raise exception 'Etapa inválida.'; end if;
  select position, coalesce(key, '') into v_pos, v_stage_in from public.lead_stages where id = v_stage;
  -- O cliente escolhe entre "a OPERA contacta" (etapa pela origem) e "fico eu com ela" (Lead Qualificada).
  if not v_opera and v_stage_in not in ('meta', 'imoveis', 'bd', 'qualificada') then
    raise exception 'Etapa inválida.';
  end if;
  if v_stage_in in ('meta', 'imoveis', 'bd') then v_entry := v_stage_in; end if;

  insert into public.leads (client_id, name, phone, email, source, interest, stage_id, entry_stage, qualification, created_by)
  values (v_client, trim(p ->> 'name'), nullif(trim(p ->> 'phone'), ''), nullif(lower(trim(p ->> 'email')), ''),
          v_source, nullif(trim(p ->> 'interest'), ''), v_stage, v_entry,
          case when nullif(trim(p ->> 'budget'), '') is null then '{}'::jsonb else jsonb_build_object('Budget', trim(p ->> 'budget')) end,
          auth.uid())
  returning id into v_id;

  insert into public.lead_events (lead_id, type, title, body, author_id)
  values (v_id, 'auto', case when v_opera then 'Lead criada manualmente' else 'Lead adicionada pelo cliente' end,
          case when not v_opera and v_pos < 50 then 'A OPERA foi avisada para contactar.' else null end, auth.uid());

  -- Toda a lead antes de Lead Qualificada nasce com uma tarefa Chamada.
  if v_pos < 50 then
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (v_id, 'call', now() + make_interval(mins => greatest(v_minutes, 0)), 'Primeiro contacto', auth.uid());
    if not v_opera then
      insert into public.lead_notifications (lead_id, kind) values (v_id, 'nova_lead_do_cliente');
    end if;
  end if;

  if coalesce(trim(p ->> 'note'), '') <> '' then
    insert into public.lead_events (lead_id, type, title, body, pinned, author_id)
    values (v_id, 'note', 'Nota', trim(p ->> 'note'), coalesce((p ->> 'note_pinned')::boolean, false), auth.uid());
  end if;
  return v_id;
end;
$$;

-- ============================================================ CHAMADAS
-- Soma uma tentativa, regista a chamada, preenche a primeira chamada, fecha a próxima tarefa Chamada e,
-- se a lead estiver numa etapa de entrada, passa-a para Follow Up OPERA.
-- p_meta: { answered, duration_s, cloudtalk_id, recording_url } (a CloudTalk preenche na Fase 6).
create function public.leads_register_call(p_lead_id uuid, p_meta jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_lead public.leads; v_key text; v_task uuid;
begin
  if not (private.leads_is_opera() and private.leads_can_write(p_lead_id)) and auth.role() <> 'service_role' then
    raise exception 'Só a equipa OPERA regista chamadas.';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null then raise exception 'Lead não encontrada.'; end if;

  update public.leads
     set attempts = attempts + 1, first_call_at = coalesce(first_call_at, now()), last_contact_at = now()
   where id = p_lead_id;

  insert into public.lead_events (lead_id, type, title, meta, author_id)
  values (p_lead_id, 'call', 'Chamada', coalesce(p_meta, '{}'::jsonb), auth.uid());

  select id into v_task from public.lead_tasks
   where lead_id = p_lead_id and type = 'call' and done_at is null and canceled_at is null
   order by due_at limit 1;
  if v_task is not null then update public.lead_tasks set done_at = now() where id = v_task; end if;

  select key into v_key from public.lead_stages where id = v_lead.stage_id;
  if v_key in ('meta', 'imoveis', 'bd') then
    update public.leads set stage_id = (select id from public.lead_stages where key = 'followup') where id = p_lead_id;
  end if;
end;
$$;

-- ============================================================ CONSULTAS DO PIPELINE
-- Filtro comum: visibilidade (a mesma regra do RLS) mais cliente, etiqueta, texto e "só as minhas".
-- Aplica a visibilidade de uma só vez, em vez de linha a linha, para continuar rápido com 100 mil leads.
-- No pipeline, pesquisa e Hoje, a equipa OPERA (admin incluído) só vê clientes ativos.
create function private.leads_visible_filtered(p_client uuid, p_label uuid, p_q text, p_mine boolean)
returns setof public.leads
language sql stable security definer set search_path = public as $$
  select l.* from public.leads l
   where (((select private.leads_is_opera()) and l.client_id in (select private.leads_active_client_ids()))
          or l.client_id = (select private.leads_my_client_id()))
     and (p_client is null or l.client_id = p_client)
     and (p_label is null or exists (select 1 from public.lead_label_links k where k.lead_id = l.id and k.label_id = p_label))
     and (not coalesce(p_mine, false) or l.owner_user_id = auth.uid())
     and (coalesce(trim(p_q), '') = ''
          or l.name ilike '%' || trim(p_q) || '%'
          or l.email ilike '%' || trim(p_q) || '%'
          or l.interest ilike '%' || trim(p_q) || '%'
          or (length(regexp_replace(p_q, '\D', '', 'g')) > 2
              and l.phone_norm like '%' || regexp_replace(regexp_replace(p_q, '\D', '', 'g'), '^351', '') || '%'));
$$;

-- Leads de uma coluna do quadro (p_stage) ou da lista (p_stage nulo), já ordenadas e paginadas.
-- Ordenações: next, recent, old, name, stale, attempts (quadro); name, client, stage, source, created, next, last, attempts (lista, com p_dir).
create function public.leads_pipeline(
  p_client uuid default null, p_stage uuid default null, p_label uuid default null, p_q text default null,
  p_mine boolean default false, p_sort text default 'next', p_dir integer default 1,
  p_offset integer default 0, p_limit integer default 50)
returns table (id uuid, client_id uuid, client_name text, client_color text, name text, phone text, email text,
               source text, interest text, stage_id uuid, stage_name text, attempts integer, created_at timestamptz,
               last_contact_at timestamptz, next_task_at timestamptz, next_task_type text, owner_name text,
               label_ids uuid[], pinned_note text, anonymized boolean, total bigint)
language sql stable security definer set search_path = public as $$
  with base as (
    select l.*, c.name as cname, c.color as ccolor, s.name as sname, s.position as spos,
           count(*) over () as total,
           row_number() over (order by
             -- quadro
             case when p_sort = 'next' then l.next_task_at end asc nulls last,
             case when p_sort = 'recent' then l.created_at end desc,
             case when p_sort = 'old' then l.created_at end asc,
             case when p_sort = 'stale' then coalesce(l.last_contact_at, '-infinity'::timestamptz) end asc,
             -- lista (e "name" e "attempts" do quadro)
             case when p_dir = 1 then case p_sort when 'name' then l.name when 'client' then c.name when 'source' then l.source end end asc,
             case when p_dir = -1 then case p_sort when 'name' then l.name when 'client' then c.name when 'source' then l.source end end desc,
             case when p_dir = 1 then case p_sort when 'created' then l.created_at when 'last' then l.last_contact_at end end asc nulls first,
             case when p_dir = -1 then case p_sort when 'created' then l.created_at when 'last' then l.last_contact_at end end desc nulls last,
             case when p_sort = 'attempts' and p_dir = -1 then l.attempts end desc,
             case when p_sort = 'attempts' and p_dir = 1 then l.attempts end asc,
             case when p_sort = 'stage' and p_dir = 1 then s.position end asc,
             case when p_sort = 'stage' and p_dir = -1 then s.position end desc,
             case when p_sort = 'nextlist' and p_dir = 1 then l.next_task_at end asc nulls last,
             case when p_sort = 'nextlist' and p_dir = -1 then l.next_task_at end desc nulls last,
             l.created_at desc, l.id) as rn
      from private.leads_visible_filtered(p_client, p_label, p_q, p_mine) l
      join public.clients c on c.id = l.client_id
      join public.lead_stages s on s.id = l.stage_id
     where p_stage is null or l.stage_id = p_stage
  )
  select b.id, b.client_id, b.cname, b.ccolor, b.name, b.phone, b.email, b.source, b.interest, b.stage_id, b.sname,
         b.attempts, b.created_at, b.last_contact_at, b.next_task_at, b.next_task_type,
         (select full_name from public.profiles p where p.id = b.owner_user_id),
         coalesce((select array_agg(k.label_id) from public.lead_label_links k where k.lead_id = b.id), '{}'),
         (select e.body from public.lead_events e where e.lead_id = b.id and e.pinned order by e.created_at desc limit 1),
         b.anonymized, b.total
    from base b
   where b.rn > greatest(p_offset, 0) and b.rn <= greatest(p_offset, 0) + least(greatest(p_limit, 1), 200)
   order by b.rn;
$$;

create function public.leads_pipeline_counts(p_client uuid default null, p_label uuid default null, p_q text default null, p_mine boolean default false)
returns table (stage_id uuid, n bigint)
language sql stable security definer set search_path = public as $$
  select l.stage_id, count(*) from private.leads_visible_filtered(p_client, p_label, p_q, p_mine) l group by l.stage_id;
$$;

-- Indicadores do topo do pipeline (equipa OPERA).
create function public.leads_pipeline_kpis(p_client uuid default null)
returns table (entraram_hoje bigint, por_contactar bigint, tarefas_atrasadas bigint, qualificadas bigint)
language sql stable security definer set search_path = public as $$
  with l as (select * from private.leads_visible_filtered(p_client, null, null, false))
  select (select count(*) from l where l.created_at >= (date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon')),
         (select count(*) from l join public.lead_stages s on s.id = l.stage_id where s.key in ('meta', 'imoveis', 'bd')),
         (select count(*) from public.lead_tasks t join l on l.id = t.lead_id
           where t.done_at is null and t.canceled_at is null and t.due_at < now()),
         (select count(*) from l join public.lead_stages s on s.id = l.stage_id where s.key = 'qualificada');
$$;

-- Lista Hoje: tarefas em aberto atrasadas, de hoje e de amanhã.
create function public.leads_today(p_client uuid default null, p_q text default null)
returns table (task_id uuid, task_type text, due_at timestamptz, task_note text, lead_id uuid, lead_name text,
               phone text, interest text, client_name text, client_color text, stage_name text)
language sql stable security definer set search_path = public as $$
  select t.id, t.type, t.due_at, t.note, l.id, l.name, l.phone, l.interest, c.name, c.color, s.name
    from public.lead_tasks t
    join private.leads_visible_filtered(p_client, null, p_q, false) l on l.id = t.lead_id
    join public.clients c on c.id = l.client_id
    join public.lead_stages s on s.id = l.stage_id
   where t.done_at is null and t.canceled_at is null
     and t.due_at < (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '2 days') at time zone 'Europe/Lisbon'
   order by t.due_at
   limit 500;
$$;

-- Pesquisa global: nome, telefone, email, interesse, qualificação, notas e etiquetas.
create function public.leads_search(p_q text)
returns table (id uuid, name text, phone text, client_name text, client_color text, stage_name text, found_in text, snippet text)
language sql stable security definer set search_path = public as $$
  with q as (select trim(p_q) as t, regexp_replace(regexp_replace(p_q, '\D', '', 'g'), '^351', '') as d),
  v as (select l.* from private.leads_visible_filtered(null, null, null, false) l),
  hits as (
    select v.id, 1 as pri, 'nome' as found_in, null::text as snippet from v, q where v.name ilike '%' || q.t || '%'
    union all
    select v.id, 2, 'telefone', null from v, q where length(q.d) > 2 and v.phone_norm like '%' || q.d || '%'
    union all
    select v.id, 3, 'email', null from v, q where v.email ilike '%' || q.t || '%'
    union all
    select v.id, 4, 'interesse', v.interest from v, q where v.interest ilike '%' || q.t || '%'
    union all
    select v.id, 5, 'qualificação', null from v, q where v.qualification::text ilike '%' || q.t || '%'
    union all
    select e.lead_id, 6, 'notas', left(e.body, 120) from public.lead_events e, q
     where e.type = 'note' and e.body ilike '%' || q.t || '%' and e.lead_id in (select v.id from v)
    union all
    select k.lead_id, 7, 'etiqueta', g.name from public.lead_label_links k join public.lead_labels g on g.id = k.label_id, q
     where g.name ilike '%' || q.t || '%' and k.lead_id in (select v.id from v)
  ),
  best as (select distinct on (h.id) h.* from hits h order by h.id, h.pri)
  select l.id, l.name, l.phone, c.name, c.color, s.name, b.found_in, b.snippet
    from best b
    join public.leads l on l.id = b.id
    join public.clients c on c.id = l.client_id
    join public.lead_stages s on s.id = l.stage_id
   where length(trim(p_q)) >= 2
   order by b.pri, l.created_at desc
   limit 40;
$$;

-- ============================================================ PERMISSÕES DE EXECUÇÃO
revoke execute on function private.leads_refresh_next_task(uuid) from public, anon, authenticated;
revoke execute on function public.lead_tasks_after_write() from public, anon, authenticated;
revoke execute on function public.lead_tasks_before_update() from public, anon, authenticated;
revoke execute on function public.lead_events_before_update() from public, anon, authenticated;
revoke execute on function public.leads_stage_rules() from public, anon, authenticated;
revoke execute on function public.leads_create(jsonb) from public, anon;
revoke execute on function public.leads_register_call(uuid, jsonb) from public, anon;
revoke execute on function public.leads_find_duplicate(uuid, text, text) from public, anon;
revoke execute on function public.leads_pipeline(uuid, uuid, uuid, text, boolean, text, integer, integer, integer) from public, anon;
revoke execute on function public.leads_pipeline_counts(uuid, uuid, text, boolean) from public, anon;
revoke execute on function public.leads_pipeline_kpis(uuid) from public, anon;
revoke execute on function public.leads_today(uuid, text) from public, anon;
revoke execute on function public.leads_search(text) from public, anon;
revoke execute on function private.leads_visible_filtered(uuid, uuid, text, boolean) from public, anon;
revoke execute on function private.leads_active_client_ids() from public, anon;
-- As políticas das leads usam-na com as permissões de quem faz o pedido.
grant execute on function private.leads_active_client_ids() to authenticated;

alter publication supabase_realtime add table public.lead_label_links;
