-- OPERA Leads, Setting B2B, prioridade 3:
--   * configuração do cliente de setting sem código (campos de qualificação, motivos de desqualificação, quem faz as
--     reuniões e o link da agenda de marcações do cliente), guardada pela equipa OPERA no ecrã Clientes e acessos;
--   * a mensagem automática na conversa do cliente, num cliente de setting, passa a ser a da reunião agendada (dia,
--     hora, quem faz, ligação e qualificação do cliente). Clientes de imobiliário: texto igual ao de antes.

alter table public.clients add column if not exists booking_url text;
alter table public.clients add column if not exists meeting_hosts text[];

create or replace function public.leads_cliente_setting_guardar(
  p_client uuid, p_qual_fields jsonb, p_desq_reasons text[], p_meeting_hosts text[], p_booking_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare f jsonb;
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA pode mudar a configuração do cliente.'; end if;
  if not private.leads_is_setting(p_client) then raise exception 'Este cliente não é de setting.'; end if;
  if jsonb_typeof(coalesce(p_qual_fields, '[]'::jsonb)) <> 'array' then raise exception 'Campos de qualificação inválidos.'; end if;
  for f in select * from jsonb_array_elements(coalesce(p_qual_fields, '[]'::jsonb)) loop
    if coalesce(btrim(f ->> 'key'), '') = '' or char_length(f ->> 'key') > 60 then raise exception 'Cada campo precisa de um nome (até 60 letras).'; end if;
    if coalesce(f ->> 'type', 'texto') not in ('texto', 'sim_nao', 'escolha') then raise exception 'Tipo de campo inválido.'; end if;
  end loop;
  if p_booking_url is not null and btrim(p_booking_url) <> '' and p_booking_url !~* '^https://' then
    raise exception 'O link da agenda tem de começar por https://';
  end if;
  update public.clients set
    qual_fields = coalesce(p_qual_fields, '[]'::jsonb),
    desq_reasons = (select coalesce(array_agg(btrim(x)), array[]::text[]) from unnest(coalesce(p_desq_reasons, array[]::text[])) x where btrim(x) <> ''),
    meeting_hosts = (select coalesce(array_agg(btrim(x)), array[]::text[]) from unnest(coalesce(p_meeting_hosts, array[]::text[])) x where btrim(x) <> ''),
    booking_url = nullif(btrim(coalesce(p_booking_url, '')), '')
  where id = p_client;
end $$;

revoke all on function public.leads_cliente_setting_guardar(uuid, jsonb, text[], text[], text) from public, anon;
grant execute on function public.leads_cliente_setting_guardar(uuid, jsonb, text[], text[], text) to authenticated;

-- Texto da mensagem automática na conversa. Imobiliário: igual a antes. Setting: reunião agendada.
create or replace function private.leads_qualified_message_text(p_lead public.leads) returns text
language sql stable set search_path = public as $$
  select case when private.leads_is_setting(p_lead.client_id) then concat_ws(E'\n',
    'Reunião agendada: ' || coalesce(nullif(p_lead.name, ''), 'Sem nome'),
    nullif(concat_ws(' · ',
      to_char(p_lead.meeting_at at time zone 'Europe/Lisbon', 'DD/MM "às" HH24:MI'),
      'com ' || nullif(p_lead.meeting_with, ''),
      nullif(p_lead.meeting_link, '')), ''),
    nullif((select string_agg(f ->> 'key' || ': ' || (p_lead.qualification ->> (f ->> 'key')), ' · ' order by o)
              from public.clients c, jsonb_array_elements(coalesce(c.qual_fields, '[]'::jsonb)) with ordinality as x(f, o)
             where c.id = p_lead.client_id and coalesce(p_lead.qualification ->> (f ->> 'key'), '') <> ''), ''),
    'Já está nas vossas leads. Depois da reunião, marquem o resultado (Compareceu, Não compareceu, Fechado ou Perdido). Qualquer dúvida, respondam aqui.')
  else concat_ws(E'\n',
    'Lead qualificada: ' || coalesce(nullif(p_lead.name, ''), 'Sem nome'),
    nullif(concat_ws(' · ',
      nullif(p_lead.qualification ->> 'Objetivo', ''),
      'Budget ' || nullif(p_lead.qualification ->> 'Budget', ''),
      'Prazo: ' || nullif(p_lead.qualification ->> 'Prazo', ''),
      'Financiamento: ' || nullif(p_lead.qualification ->> 'Financiamento', '')), ''),
    'Já está nas vossas leads, com o resumo da chamada. Qualquer dúvida sobre esta lead, respondam aqui.') end;
$$;

-- Notificação no telemóvel da mensagem automática: "Reunião agendada" nos clientes de setting (o resto igual).
create or replace function private.leads_push_message() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare v_side text; v_client public.clients; v_author text; v_lead text;
begin
  if new.deleted_at is not null then return null; end if;
  select * into v_client from public.clients where id = new.client_id;
  if not v_client.leads_enabled or v_client.leads_status <> 'ativo' then return null; end if;
  v_side := case private.leads_message_side(new.author_id) when 'opera' then 'cliente' else 'opera' end;
  if new.auto = 'qualificada' then
    select name into v_lead from public.leads where id = new.lead_id;
    perform private.leads_push(
      array(select r.id from private.leads_message_readers(new.client_id, v_side) r where r.id is distinct from new.author_id),
      case when v_client.service_type = 'setting' then 'Reunião agendada · ' else 'Lead qualificada · ' end || coalesce(v_lead, ''),
      case when v_client.service_type = 'setting' then 'A OPERA agendou uma reunião para ' || v_client.name || '. Toque para ver.'
           else 'A OPERA qualificou esta lead para ' || v_client.name || '. Toque para ver.' end,
      private.leads_app_link('conversa=' || new.client_id), 'conversa-' || new.client_id);
    return null;
  end if;
  select coalesce(nullif(full_name, ''), email) into v_author from public.profiles where id = new.author_id;
  perform private.leads_push(
    array(select r.id from private.leads_message_readers(new.client_id, v_side) r where r.id is distinct from new.author_id),
    case v_side when 'cliente' then 'Mensagem da OPERA' else 'Mensagem de ' || v_client.name end,
    concat_ws(': ', v_author, private.leads_message_text(new.body, new.audio_seconds)),
    private.leads_app_link('conversa=' || new.client_id), 'conversa-' || new.client_id);
  return null;
end;
$function$;

-- Notas automáticas das chamadas: num cliente de setting, os campos que a nota preenche são os do cliente (qual_fields);
-- nos clientes de imobiliário continuam a ser os seis de sempre.
create or replace function public.leads_cloudtalk_ai_note(p_call_id text, p_body text, p_model text, p_fields jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid; v_at timestamptz; v_author uuid; v_q jsonb; v_filled jsonb := '{}'::jsonb; k text; v text;
  v_client uuid; v_campos text[];
begin
  if nullif(trim(p_body), '') is null then raise exception 'Nota vazia.'; end if;
  select e.lead_id, e.created_at into v_lead, v_at
    from public.lead_events e join public.leads l on l.id = e.lead_id
   where e.type = 'call' and e.meta ->> 'call_id' = p_call_id and not l.anonymized
   order by e.created_at desc limit 1;
  if v_lead is null then return jsonb_build_object('status', 'sem_lead'); end if;
  select c.manager_id, l.qualification, c.id into v_author, v_q, v_client
    from public.leads l join public.clients c on c.id = l.client_id where l.id = v_lead for update of l;
  v_campos := case when private.leads_is_setting(v_client)
    then (select coalesce(array_agg(f ->> 'key'), array[]::text[]) from public.clients c, jsonb_array_elements(coalesce(c.qual_fields, '[]'::jsonb)) f where c.id = v_client)
    else array['Objetivo', 'Budget', 'Prazo', 'Financiamento', 'Tem imóvel para vender', 'Disponibilidade para visita'] end;

  -- O resumo curto sai e entra a nota do Claude, com a mesma hora (o autor de uma nota não muda).
  delete from public.lead_events where lead_id = v_lead and type = 'note' and meta ->> 'ci_call_id' = p_call_id;
  insert into public.lead_events (lead_id, type, title, body, meta, author_id, created_at)
  values (v_lead, 'note', 'Resumo da chamada', trim(p_body),
          jsonb_build_object('via', 'cloudtalk', 'ci_call_id', p_call_id, 'ai', p_model), v_author, v_at + interval '1 second');

  -- Qualificação: só os campos conhecidos e só os que ainda estão vazios.
  for k, v in select key, left(trim(value), 200) from jsonb_each_text(coalesce(p_fields, '{}'::jsonb)) loop
    continue when not (k = any (v_campos));
    continue when nullif(v, '') is null or nullif(trim(coalesce(v_q ->> k, '')), '') is not null;
    v_filled := v_filled || jsonb_build_object(k, v);
  end loop;
  if v_filled <> '{}'::jsonb then
    update public.leads set qualification = coalesce(qualification, '{}'::jsonb) || v_filled where id = v_lead;
    insert into public.lead_events (lead_id, type, title, body, meta, author_id, created_at)
    values (v_lead, 'auto', 'Qualificação preenchida pela nota da chamada',
            (select string_agg(key || ': ' || value, E'\n' order by key) from jsonb_each_text(v_filled)),
            jsonb_build_object('via', 'cloudtalk', 'ci_call_id', p_call_id, 'fields', v_filled), null, v_at + interval '2 seconds');
  end if;
  return jsonb_build_object('status', 'processado', 'lead_id', v_lead, 'preenchidos', v_filled);
end;
$$;
