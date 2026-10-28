-- OPERA Leads: chamadas recebidas da CloudTalk (a lead liga para a OPERA). Até aqui eram ignoradas, por isso
-- não ficavam na ficha e a transcrição e a nota do Claude não tinham onde ficar.
-- Agora ficam como "Chamada recebida" na lead com esse telefone (a de atividade mais recente). Não contam como
-- tentativa da OPERA, nem para o Time to Lead, nem no dashboard. Atendida: conta como contacto e a lead sai da
-- etapa de entrada. Não atendida: fica uma tarefa para ligar de volta.

create or replace function public.leads_cloudtalk_call_ended(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_phone text := private.leads_normalize_phone(p ->> 'external_number');
  v_at timestamptz := coalesce((p ->> 'started_at')::timestamptz, now());
  v_answered boolean := coalesce((p ->> 'talking_time')::numeric, 0) > 0;
  v_incoming boolean := coalesce(p ->> 'direction', '') in ('incoming', 'inbound');
  v_meta jsonb;
  v_event uuid; v_lead uuid; v_author uuid; v_others text; v_key text;
begin
  if not v_incoming and coalesce(p ->> 'direction', '') not in ('outgoing', 'outbound') then
    return jsonb_build_object('status', 'ignorado', 'motivo', 'Chamada interna.');
  end if;
  if coalesce(length(v_phone), 0) < 6 then
    return jsonb_build_object('status', 'sem_lead', 'motivo', 'Chamada sem número.');
  end if;

  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'via', 'cloudtalk', 'call_id', p ->> 'call_id', 'call_uuid', p ->> 'call_uuid', 'answered', v_answered,
    'duration_s', nullif(coalesce((p ->> 'talking_time')::numeric, 0), 0), 'total_s', (p ->> 'duration')::numeric,
    'recorded', (p ->> 'recorded')::boolean, 'agent_id', p ->> 'agent_id',
    'direction', case when v_incoming then 'incoming' end));

  -- Já tratado (a CloudTalk pode repetir o envio).
  select id, lead_id into v_event, v_lead from public.lead_events
   where type = 'call' and meta ->> 'call_id' = p ->> 'call_id' limit 1;
  if v_event is not null then
    return jsonb_build_object('status', 'processado', 'lead_id', v_lead, 'repetido', true);
  end if;

  if not v_incoming then
    -- 1. A chamada pedida pelo botão Ligar: a mais recente desta lead ainda sem resultado.
    select e.id, e.lead_id into v_event, v_lead
      from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.type = 'call' and e.meta ->> 'via' = 'cloudtalk' and e.meta ->> 'call_id' is null
       and l.phone_norm = v_phone and e.created_at between v_at - interval '15 minutes' and v_at + interval '5 minutes'
     order by e.created_at desc limit 1;
    if v_event is not null then
      update public.lead_events
         set meta = meta || v_meta,
             title = case when v_answered then 'Chamada CloudTalk, atendida' else 'Chamada CloudTalk, não atendida' end
       where id = v_event;
      return jsonb_build_object('status', 'processado', 'lead_id', v_lead);
    end if;
  end if;

  -- 2. Chamada feita diretamente na CloudTalk, ou recebida: a lead com este telefone e atividade mais recente.
  select l.id into v_lead from public.leads l join public.clients c on c.id = l.client_id
   where l.phone_norm = v_phone and not l.anonymized and c.leads_enabled and c.leads_status = 'ativo'
   order by greatest(l.updated_at, coalesce(l.last_contact_at, l.created_at)) desc limit 1;
  if v_lead is null then
    return jsonb_build_object('status', 'sem_lead', 'motivo', 'Nenhuma lead com este telefone.');
  end if;

  select id into v_author from public.profiles
   where cloudtalk_agent_id::text = p ->> 'agent_id' or lower(email) = lower(p ->> 'agent_email')
   order by (cloudtalk_agent_id::text = p ->> 'agent_id') desc nulls last limit 1;

  if v_incoming then
    insert into public.lead_events (lead_id, type, title, meta, author_id, created_at)
    values (v_lead, 'call', case when v_answered then 'Chamada recebida, atendida' else 'Chamada recebida, não atendida' end,
            v_meta, v_author, v_at);
    if v_answered then
      update public.leads set last_contact_at = greatest(coalesce(last_contact_at, v_at), v_at) where id = v_lead;
      select s.key into v_key from public.leads l join public.lead_stages s on s.id = l.stage_id where l.id = v_lead;
      if v_key in ('meta', 'imoveis', 'bd') then
        update public.leads set stage_id = (select id from public.lead_stages where key = 'followup') where id = v_lead;
      end if;
    else
      insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
      values (v_lead, 'call', v_at, 'A lead ligou e a chamada não foi atendida. Ligar de volta.', v_author);
    end if;
  else
    perform private.leads_apply_call(v_lead,
      case when v_answered then 'Chamada CloudTalk, atendida' else 'Chamada CloudTalk, não atendida' end,
      v_meta, v_at, v_author);
  end if;

  select string_agg(c.name, ', ' order by c.name) into v_others
    from public.leads l join public.clients c on c.id = l.client_id
   where l.phone_norm = v_phone and l.id <> v_lead and not l.anonymized and c.leads_status = 'ativo';
  if v_others is not null then
    insert into public.lead_events (lead_id, type, title, body, pinned, author_id)
    values (v_lead, 'note', 'Confirmar a chamada',
            'Este número também existe em: ' || v_others || '. A chamada foi registada nesta lead por ter a atividade mais recente. Confirma que é a lead certa.',
            true, null);
  end if;
  return jsonb_build_object('status', 'processado', 'lead_id', v_lead, 'outros_clientes', v_others is not null);
end;
$$;
revoke execute on function public.leads_cloudtalk_call_ended(jsonb) from public, anon, authenticated;
grant execute on function public.leads_cloudtalk_call_ended(jsonb) to service_role;

-- Dashboard: as chamadas recebidas não contam (o dashboard mede as chamadas feitas pela OPERA).
do $do$
declare d text; n int;
  function_sig regprocedure := 'public.leads_dashboard(uuid,text,date,date)'::regprocedure;
  inc constant text := $a$ and coalesce(e.meta ->> 'direction', '') <> 'incoming'$a$;
begin
  d := pg_get_functiondef(function_sig);
  n := length(d);
  -- chamadas, atendidas, qualificadas... (a_ev)
  d := replace(d, $a$and (e.type = 'call' or (e.type = 'stage'$a$, $a$and ((e.type = 'call'$a$ || inc || $a$) or (e.type = 'stage'$a$);
  -- leads BD trabalhadas, leads contactadas e chamadas às leads novas
  d := replace(d, $a$e.type = 'call' and e.created_at >= v_from and e.created_at < v_to and not (e.meta ? 'imported'))$a$,
                  $a$e.type = 'call' and e.created_at >= v_from and e.created_at < v_to and not (e.meta ? 'imported')$a$ || inc || ')');
  d := replace(d, $a$where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to
                        and l.client_id$a$,
                  $a$where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to$a$ || inc || $a$
                        and l.client_id$a$);
  d := replace(d, $a$where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to
                     and l.client_id$a$,
                  $a$where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to$a$ || inc || $a$
                     and l.client_id$a$);
  -- Quatro substituições; a primeira leva também dois parênteses.
  if (length(d) - n) <> 4 * length(inc) + 2 then raise exception 'leads_dashboard: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;
