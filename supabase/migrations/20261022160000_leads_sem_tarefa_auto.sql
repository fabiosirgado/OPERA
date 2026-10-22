-- Decisão do Fábio (2026-10-22): nenhuma lead nasce com tarefa automática quando é criada
-- (à mão, importada ou, mais tarde, recebida do Meta e dos portais). Substitui a regra 6 do documento.
-- O Follow up "Confirmar com o cliente" ao passar para Lead Qualificada (regra 10) mantém-se.
create or replace function public.leads_create(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid := (p ->> 'client_id')::uuid;
  v_opera boolean := private.leads_is_opera();
  v_source text := coalesce(nullif(p ->> 'source', ''), 'Outra');
  v_entry text := private.leads_entry_for_source(v_source);
  v_stage_in text := coalesce(nullif(p ->> 'stage', ''), 'auto');
  v_stage uuid; v_pos numeric; v_id uuid;
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

  -- Lead do cliente para a OPERA tratar: aviso à OPERA (enviado na Fase 7).
  if not v_opera and v_pos < 50 then
    insert into public.lead_notifications (lead_id, kind) values (v_id, 'nova_lead_do_cliente');
  end if;

  if coalesce(trim(p ->> 'note'), '') <> '' then
    insert into public.lead_events (lead_id, type, title, body, pinned, author_id)
    values (v_id, 'note', 'Nota', trim(p ->> 'note'), coalesce((p ->> 'note_pinned')::boolean, false), auth.uid());
  end if;
  return v_id;
end;
$$;
revoke execute on function public.leads_create(jsonb) from public, anon;
