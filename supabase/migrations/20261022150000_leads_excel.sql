-- OPERA Leads, Fase 3: importar e exportar Excel.
-- O ficheiro é lido no browser (SheetJS); a validação, os duplicados e a gravação correm aqui, em lotes.

-- ============================================================ IMPORTAR
-- Antes de importar: diz que linhas já existem (mesmo telefone normalizado ou email, no mesmo cliente).
-- p_rows: [{ i, client_id, phone, email }]. Devolve [{ i, id, name }] só das que já existem.
create function public.leads_import_check(p_rows jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA importa leads.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('i', r.i, 'id', d.id, 'name', d.name))
      from jsonb_to_recordset(p_rows) as r(i integer, client_id uuid, phone text, email text)
      cross join lateral (
        select l.id, l.name from public.leads l
         where l.client_id = r.client_id and not l.anonymized
           and r.client_id in (select private.leads_active_client_ids())
           and ((length(coalesce(private.leads_normalize_phone(r.phone), '')) >= 6 and l.phone_norm = private.leads_normalize_phone(r.phone))
                or (nullif(trim(r.email), '') is not null and lower(l.email) = lower(trim(r.email))))
         limit 1) d), '[]'::jsonb);
end;
$$;

-- Um lote de linhas já validadas no browser. p_dup: 'ignore' | 'fill' (atualizar dados em falta) | 'create'.
-- p_rows: [{ line, client_id, stage_id, name, phone, email, source, interest, budget, labels: [nomes], note, source_date }]
-- Devolve { created, updated, ignored, errors: [{ line, reason }] }.
create function public.leads_import_batch(p_rows jsonb, p_dup text, p_file text) returns jsonb
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
                                  source_created_at, created_by)
        values (r.client_id, trim(r.name), nullif(trim(r.phone), ''), nullif(lower(trim(r.email)), ''),
                coalesce(nullif(trim(r.source), ''), 'Base de dados'), nullif(trim(r.interest), ''), v_stage.id, 'bd',
                case when nullif(trim(r.budget), '') is null then '{}'::jsonb else jsonb_build_object('Budget', trim(r.budget)) end,
                case when r.source_date ~ '^\d{4}-\d{2}-\d{2}' then r.source_date::timestamptz end,
                auth.uid())
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

-- No fim da importação (todos os lotes): uma só entrada no registo de atividade.
create function public.leads_log_import(p_file text, p_created integer, p_updated integer, p_ignored integer, p_errors integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA importa leads.'; end if;
  perform public.leads_audit('importacao', jsonb_build_object('ficheiro', left(p_file, 200), 'leads', p_created,
                             'atualizadas', p_updated, 'ignoradas', p_ignored, 'erros', p_errors));
end;
$$;

-- ============================================================ EXPORTAR
-- Uma página de leads para exportar (1000 de cada vez). Fica no registo de atividade na primeira página.
-- A equipa OPERA exporta clientes ativos (o admin também os inativos, para entregar ao cliente que sai);
-- cada cliente exporta só as suas leads.
create function public.leads_export(p_client uuid default null, p_stages uuid[] default null, p_since timestamptz default null,
                                    p_history boolean default false, p_offset integer default 0)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
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
               from public.lead_events e where e.lead_id = l.id) end as historico
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
$$;

revoke execute on function public.leads_import_check(jsonb) from public, anon;
revoke execute on function public.leads_import_batch(jsonb, text, text) from public, anon;
revoke execute on function public.leads_log_import(text, integer, integer, integer, integer) from public, anon;
revoke execute on function public.leads_export(uuid, uuid[], timestamptz, boolean, integer) from public, anon;
