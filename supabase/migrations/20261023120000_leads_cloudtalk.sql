-- OPERA Leads, Fase 6: CloudTalk (uma conta e um número para todos os clientes; só chamadas de saída).
--
-- Fluxo:
--   1. Botão Ligar: a função leads-cloudtalk cria ou atualiza o contacto na CloudTalk ("Nome · Cliente"),
--      pede a chamada ao agente de quem carregou e regista logo a chamada na lead (conta para o Time to Lead).
--   2. Webhook call.ended (assinado pela CloudTalk): junta à chamada registada a duração, se foi atendida e o
--      id da chamada. Uma chamada feita diretamente na CloudTalk também fica registada, pela lead com o mesmo
--      telefone; se o número existir em mais de um cliente, usa a lead com atividade mais recente e deixa
--      uma nota afixada a pedir confirmação.
--   3. Webhook call.recording_ready: marca a chamada como gravada; a equipa ouve a gravação pela função.

alter table public.profiles add column cloudtalk_agent_id bigint;
alter table public.leads add column cloudtalk_contact_id text;

-- Eventos recebidos da CloudTalk: a CloudTalk entrega pelo menos uma vez, por isso guarda-se o id do evento.
create table public.cloudtalk_events (
  event_id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  payload jsonb,
  status text not null default 'recebido' check (status in ('recebido', 'processado', 'ignorado', 'sem_lead', 'erro')),
  lead_id uuid references public.leads (id) on delete set null,
  error text
);
create index cloudtalk_events_received_idx on public.cloudtalk_events (received_at desc);
alter table public.cloudtalk_events enable row level security;
create policy "opera lê eventos da cloudtalk" on public.cloudtalk_events for select using ((select private.leads_is_opera()));

create index lead_events_call_id_idx on public.lead_events ((meta ->> 'call_id')) where type = 'call';

-- ============================================================ REGISTAR UMA CHAMADA
-- Usado pelo botão Ligar e pelo webhook: conta a tentativa, marca a primeira chamada (Time to Lead),
-- conclui a tarefa de chamada mais antiga e tira a lead das etapas de entrada.
create function private.leads_apply_call(p_lead_id uuid, p_title text, p_meta jsonb, p_at timestamptz, p_author uuid)
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

  insert into public.lead_events (lead_id, type, title, meta, author_id, created_at)
  values (p_lead_id, 'call', p_title, coalesce(p_meta, '{}'::jsonb), p_author, p_at)
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

create or replace function public.leads_register_call(p_lead_id uuid, p_meta jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (private.leads_is_opera() and private.leads_can_write(p_lead_id)) and auth.role() <> 'service_role' then
    raise exception 'Só a equipa OPERA regista chamadas.';
  end if;
  perform private.leads_apply_call(p_lead_id,
    case when p_meta ->> 'via' = 'cloudtalk' then 'Chamada CloudTalk' else 'Chamada' end,
    p_meta, now(), auth.uid());
end;
$$;

-- ============================================================ WEBHOOK DA CLOUDTALK
-- p (call.ended): { event_id, call_id, call_uuid, direction, external_number, started_at, ended_at,
--                   talking_time, duration, agent_id, agent_email, recorded }
create function public.leads_cloudtalk_call_ended(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_phone text := private.leads_normalize_phone(p ->> 'external_number');
  v_at timestamptz := coalesce((p ->> 'started_at')::timestamptz, now());
  v_answered boolean := coalesce((p ->> 'talking_time')::numeric, 0) > 0;
  v_meta jsonb;
  v_event uuid; v_lead uuid; v_author uuid; v_others text;
begin
  if coalesce(p ->> 'direction', '') not in ('outgoing', 'outbound') then
    return jsonb_build_object('status', 'ignorado', 'motivo', 'Só as chamadas de saída contam.');
  end if;
  if coalesce(length(v_phone), 0) < 6 then
    return jsonb_build_object('status', 'sem_lead', 'motivo', 'Chamada sem número.');
  end if;

  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'via', 'cloudtalk', 'call_id', p ->> 'call_id', 'call_uuid', p ->> 'call_uuid', 'answered', v_answered,
    'duration_s', nullif(coalesce((p ->> 'talking_time')::numeric, 0), 0), 'total_s', (p ->> 'duration')::numeric,
    'recorded', (p ->> 'recorded')::boolean, 'agent_id', p ->> 'agent_id'));

  -- Já tratado (a CloudTalk pode repetir o envio).
  select id, lead_id into v_event, v_lead from public.lead_events
   where type = 'call' and meta ->> 'call_id' = p ->> 'call_id' limit 1;
  if v_event is not null then
    return jsonb_build_object('status', 'processado', 'lead_id', v_lead, 'repetido', true);
  end if;

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

  -- 2. Chamada feita diretamente na CloudTalk: a lead com este telefone e atividade mais recente.
  select l.id into v_lead from public.leads l join public.clients c on c.id = l.client_id
   where l.phone_norm = v_phone and not l.anonymized and c.leads_enabled and c.leads_status = 'ativo'
   order by greatest(l.updated_at, coalesce(l.last_contact_at, l.created_at)) desc limit 1;
  if v_lead is null then
    return jsonb_build_object('status', 'sem_lead', 'motivo', 'Nenhuma lead com este telefone.');
  end if;

  select id into v_author from public.profiles
   where cloudtalk_agent_id::text = p ->> 'agent_id' or lower(email) = lower(p ->> 'agent_email')
   order by (cloudtalk_agent_id::text = p ->> 'agent_id') desc nulls last limit 1;
  perform private.leads_apply_call(v_lead,
    case when v_answered then 'Chamada CloudTalk, atendida' else 'Chamada CloudTalk, não atendida' end,
    v_meta, v_at, v_author);

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

-- call.recording_ready: a gravação já existe na CloudTalk.
create function public.leads_cloudtalk_recording_ready(p_call_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_lead uuid;
begin
  update public.lead_events set meta = meta || '{"recorded": true}'::jsonb
   where type = 'call' and meta ->> 'call_id' = p_call_id
  returning lead_id into v_lead;
  return jsonb_build_object('status', case when v_lead is null then 'sem_lead' else 'processado' end, 'lead_id', v_lead);
end;
$$;

revoke execute on function public.leads_cloudtalk_call_ended(jsonb) from public, anon, authenticated;
revoke execute on function public.leads_cloudtalk_recording_ready(text) from public, anon, authenticated;
grant execute on function public.leads_cloudtalk_call_ended(jsonb) to service_role;
grant execute on function public.leads_cloudtalk_recording_ready(text) to service_role;

-- A gravação só se ouve pela função, e fica no registo de atividade quem a ouviu.
create function public.leads_can_hear_recording(p_call_id text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_lead uuid;
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA ouve gravações.'; end if;
  select lead_id into v_lead from public.lead_events where type = 'call' and meta ->> 'call_id' = p_call_id limit 1;
  if v_lead is null or not private.leads_can_write(v_lead) then raise exception 'Chamada não encontrada.'; end if;
  perform public.leads_audit('ouvir_gravacao', jsonb_build_object('lead_id', v_lead, 'call_id', p_call_id));
  return v_lead;
end;
$$;
revoke execute on function public.leads_can_hear_recording(text) from public, anon;

-- RGPD: o conteúdo dos eventos da CloudTalk só fica 30 dias.
select cron.schedule('leads-cloudtalk-limpeza', '35 3 * * *',
  $$update public.cloudtalk_events set payload = null where payload is not null and received_at < now() - interval '30 days'$$);
