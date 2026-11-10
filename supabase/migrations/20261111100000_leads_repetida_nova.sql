-- OPERA Leads: uma lead que já existia e volta a pedir contacto (Meta ou email de portal) é tratada como lead
-- nova (pedido do Fábio, 2026-11-11, caso Larissa Barbosa no Bruno Fernandes).
--
-- * Novo campo leads.new_at: desde quando a lead está "Nova". É ele que acende o sinal "Nova" (antes era
--   calculado a partir de created_by/imported, por isso uma lead importada nunca o tinha).
--   - nasce com a lead quando entra por uma entrada automática;
--   - volta a acender quando a mesma pessoa faz um novo pedido;
--   - apaga-se na primeira chamada ou contacto, ou quando a lead passa para uma etapa a partir de Lead Qualificada
--     (posição 50 ou mais, o que inclui Lead desqualificada).
-- * Lead repetida com um pedido recente (feito há menos de 48 horas, ou sem data): acende "Nova", vai para a
--   etapa de entrada certa (Meta: Nova Lead Meta; portais: Nova lead imóveis) se estiver numa etapa antes de
--   Lead Qualificada ou em Lead desqualificada, e a equipa OPERA recebe o aviso no telemóvel. Se a lead já
--   estiver com o cliente (Lead Qualificada ou depois), fica na etapa onde está, mas com o sinal "Nova".
--   Os pedidos antigos que o Make volte a enviar (por exemplo ao reler o formulário) só juntam o evento, como antes.

-- ============================================================ CAMPO
alter table public.leads add column new_at timestamptz;
comment on column public.leads.new_at is
  'Desde quando a lead está "Nova" (entrada automática ou novo pedido de uma lead que já existia). Nulo depois do primeiro contacto.';

-- As leads que hoje têm o sinal ficam com ele.
update public.leads l set new_at = coalesce(l.source_created_at, l.created_at)
  from public.lead_stages s
 where s.id = l.stage_id and l.created_by is null and not l.imported and l.attempts = 0
   and l.last_contact_at is null and s.position < 50 and not l.anonymized;

create index leads_new_at_idx on public.leads (new_at) where new_at is not null;

-- ============================================================ QUANDO ACENDE E QUANDO APAGA
create function private.leads_new_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.new_at is null and new.created_by is null and not coalesce(new.imported, false) then
      new.new_at := now();
    end if;
    return new;
  end if;
  -- Quem acende o sinal neste mesmo update (novo pedido) ganha sempre.
  if new.new_at is distinct from old.new_at then return new; end if;
  if new.new_at is not null and (
       new.attempts > old.attempts
       or (new.last_contact_at is not null and new.last_contact_at is distinct from old.last_contact_at)
       or new.anonymized
       or (new.stage_id is distinct from old.stage_id
           and coalesce((select s.position from public.lead_stages s where s.id = new.stage_id), 0) >= 50)) then
    new.new_at := null;
  end if;
  return new;
end;
$$;
create trigger leads_new_at before insert or update on public.leads
  for each row execute function private.leads_new_at();

-- ============================================================ PIPELINE: o sinal vem do campo
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_pipeline(uuid,uuid,uuid,text,boolean,text,integer,integer,integer)'::regprocedure;
  old constant text := $a$(l.created_by is null and not l.imported and l.attempts = 0 and l.last_contact_at is null and s.position < 50)$a$;
  new constant text := $a$(l.new_at is not null)$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, old, new);
  if length(d) - n <> length(new) - length(old) then raise exception 'leads_pipeline: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;

-- ============================================================ ENTRADA DE UMA LEAD QUE JÁ EXISTIA
create or replace function private.leads_inbound_apply(p_log_id bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_log public.inbound_log;
  p jsonb;
  v_client uuid;
  v_entry text;
  v_stage uuid;
  v_lead uuid;
  v_name text;
  v_note text;
  v_ext text;
  v_review boolean;
  v_when timestamptz;
  v_fresh boolean;
  v_old public.leads;
  v_old_pos numeric;
  v_old_key text;
  v_moved boolean := false;
begin
  select * into v_log from public.inbound_log where id = p_log_id for update;
  if not found then raise exception 'Entrada não encontrada.'; end if;
  if v_log.kind <> 'lead' then raise exception 'Esta entrada não é uma lead.'; end if;
  if v_log.status in ('processado', 'revisao', 'duplicado') then
    return jsonb_build_object('status', v_log.status, 'lead_id', v_log.lead_id, 'client_id', v_log.client_id);
  end if;
  p := coalesce(v_log.parsed, '{}'::jsonb);

  -- Cliente: já escolhido, indicado pelo Make, pelo formulário Meta, ou pelo endereço de receção.
  v_client := v_log.client_id;
  if v_client is null and nullif(p ->> 'client', '') is not null then
    select id into v_client from public.clients
     where inbox_alias = lower(p ->> 'client') or id::text = p ->> 'client';
  end if;
  if v_client is null and v_log.channel = 'meta' then
    select client_id into v_client from public.lead_meta_forms
     where (nullif(p ->> 'form_id', '') is not null and form_id = p ->> 'form_id')
        or (nullif(p ->> 'page_id', '') is not null and page_id = p ->> 'page_id' and form_id is null)
     order by form_id nulls last limit 1;
  end if;
  if v_client is null and jsonb_typeof(p -> 'recipients') = 'array' then
    select a.client_id into v_client from public.client_inbox_addresses a
     where a.address in (select lower(trim(r)) from jsonb_array_elements_text(p -> 'recipients') r)
     limit 1;
  end if;
  if v_client is null or not exists (select 1 from public.clients
                                       where id = v_client and leads_enabled and leads_status = 'ativo') then
    update public.inbound_log set status = 'sem_cliente', client_id = null,
           error = case when v_client is null then 'Cliente não identificado.' else 'Cliente inativo no Leads.' end
     where id = p_log_id;
    return jsonb_build_object('status', 'sem_cliente');
  end if;

  v_ext := nullif(trim(p ->> 'external_id'), '');
  v_review := coalesce((p ->> 'review')::boolean, false)
              or (coalesce(private.leads_normalize_phone(p ->> 'phone'), '') = '' and coalesce(trim(p ->> 'email'), '') = '');
  v_entry := case when v_log.channel = 'meta' then 'meta' else 'imoveis' end;
  v_when := case when (p ->> 'source_created_at') ~ '^\d{4}-\d{2}-\d{2}' then (p ->> 'source_created_at')::timestamptz end;

  -- 1. A mesma entrada outra vez (o Make repetiu o envio): nada de novo.
  if v_ext is not null then
    select id into v_lead from public.leads where client_id = v_client and external_id = v_ext;
    if v_lead is not null then
      update public.inbound_log set status = 'duplicado', client_id = v_client, lead_id = v_lead, error = null where id = p_log_id;
      return jsonb_build_object('status', 'duplicado', 'lead_id', v_lead, 'client_id', v_client);
    end if;
  end if;

  -- Texto da nota: a mensagem do email ou as respostas do formulário.
  v_note := nullif(trim(coalesce(p ->> 'message', '')), '');
  if jsonb_typeof(p -> 'answers') = 'array' and jsonb_array_length(p -> 'answers') > 0 then
    v_note := concat_ws(E'\n\n', v_note,
      (select string_agg(coalesce(nullif(trim(x ->> 'q'), ''), 'Resposta') || ': ' || coalesce(x ->> 'a', ''), E'\n')
         from jsonb_array_elements(p -> 'answers') x));
  end if;

  -- 2. Lead que já existe no cliente (mesmo telefone ou email): junta-se o evento. Se o pedido é recente, a lead
  --    volta a ser "Nova", vai para a etapa de entrada (se ainda não está com o cliente) e a OPERA é avisada.
  select d.id into v_lead from public.leads_find_duplicate(v_client, p ->> 'phone', p ->> 'email') d;
  if v_lead is not null then
    select * into v_old from public.leads where id = v_lead for update;
    select s.position, s.key into v_old_pos, v_old_key from public.lead_stages s where s.id = v_old.stage_id;
    v_fresh := not v_old.anonymized and (v_when is null or v_when > now() - interval '48 hours');

    if v_fresh then
      select id into v_stage from public.lead_stages where key = v_entry;
      v_moved := v_stage is not null and v_old.stage_id <> v_stage and (v_old_pos < 50 or v_old_key = 'desq');
      update public.leads
         set new_at = now(),
             stage_id = case when v_moved then v_stage else stage_id end,
             entry_stage = case when v_moved then v_entry else entry_stage end
       where id = v_lead;
    end if;

    insert into public.lead_events (lead_id, type, title, body, author_id, meta)
    values (v_lead, 'auto', 'Novo contacto recebido',
            concat_ws(E'\n\n',
              case when v_log.channel = 'meta' then 'Novo pedido pelo formulário Meta.'
                   else 'Novo email de ' || coalesce(nullif(p ->> 'source', ''), 'portal') || '.' end,
              case when v_moved then 'A lead já existia: voltou para ' ||
                     (select s.name from public.lead_stages s where s.id = v_stage) || ' como lead nova.'
                   when v_fresh then 'A lead já existia e está marcada como nova.' end,
              case when nullif(p ->> 'interest', '') is not null then 'Imóvel: ' || (p ->> 'interest') end,
              case when nullif(p ->> 'reference', '') is not null then 'Referência do anúncio: ' || (p ->> 'reference') end,
              v_note),
            null,
            jsonb_build_object('inbound_log_id', p_log_id, 'channel', v_log.channel, 'reference', p ->> 'reference',
                               'nova', v_fresh, 'from_stage', case when v_moved then v_old.stage_id end));

    if v_fresh then
      perform private.leads_push(
        array(select r.id from private.leads_message_readers(v_client, 'opera') r),
        'Nova lead (já existia) · ' || coalesce(nullif(v_old.name, ''), 'Sem nome'),
        concat_ws(' · ', (select c.name from public.clients c where c.id = v_client),
                  case when v_log.channel = 'meta' then 'Meta' else coalesce(nullif(p ->> 'source', ''), 'Portal') end),
        private.leads_app_link('lead=' || v_lead), v_lead::text);
    end if;

    update public.inbound_log set status = 'duplicado', client_id = v_client, lead_id = v_lead, error = null where id = p_log_id;
    return jsonb_build_object('status', 'duplicado', 'lead_id', v_lead, 'client_id', v_client, 'nova', v_fresh, 'moved', v_moved);
  end if;

  -- 3. Lead nova: Meta entra em Nova Lead Meta, emails dos portais em Nova lead imóveis. Sem tarefa.
  select id into v_stage from public.lead_stages where key = v_entry;
  v_name := coalesce(nullif(trim(p ->> 'name'), ''), 'Sem nome');

  insert into public.leads (client_id, name, phone, email, source, interest, stage_id, entry_stage,
                            source_created_at, external_id, created_by)
  values (v_client, v_name, nullif(trim(p ->> 'phone'), ''), nullif(lower(trim(p ->> 'email')), ''),
          coalesce(nullif(trim(p ->> 'source'), ''), case when v_entry = 'meta' then 'Meta' else 'Portal' end),
          nullif(trim(p ->> 'interest'), ''), v_stage, v_entry, v_when, v_ext, null)
  returning id into v_lead;

  insert into public.lead_events (lead_id, type, title, body, author_id, meta)
  values (v_lead, 'auto',
          case when v_entry = 'meta' then 'Lead recebida do Meta'
               else 'Lead recebida por email (' || coalesce(nullif(p ->> 'source', ''), 'portal') || ')' end,
          case when nullif(p ->> 'reference', '') is not null then 'Referência do anúncio: ' || (p ->> 'reference') end,
          null,
          jsonb_build_object('inbound_log_id', p_log_id, 'channel', v_log.channel, 'reference', p ->> 'reference'));
  if v_note is not null then
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (v_lead, 'note', case when v_entry = 'meta' then 'Respostas do formulário' else 'Mensagem da lead' end, v_note, null);
  end if;
  if v_review then
    insert into public.lead_events (lead_id, type, title, body, pinned, author_id)
    values (v_lead, 'note', 'Precisa de revisão',
            coalesce(nullif(p ->> 'review_reason', ''), 'Não foi encontrado telefone nem email.')
              || ' O email original está nas Entradas automáticas durante 30 dias.', true, null);
  end if;

  update public.inbound_log set status = case when v_review then 'revisao' else 'processado' end,
         client_id = v_client, lead_id = v_lead, error = null
   where id = p_log_id;
  return jsonb_build_object('status', case when v_review then 'revisao' else 'processado' end,
                            'lead_id', v_lead, 'client_id', v_client);
end;
$$;
