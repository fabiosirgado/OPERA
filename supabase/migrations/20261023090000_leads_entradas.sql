-- OPERA Leads, Fase 5: entradas automáticas (formulários Meta e emails dos portais), ambas pelo Make.
--
-- A função leads-inbound (Edge Function) recebe cada entrada, guarda o conteúdo bruto no inbound_log
-- antes de qualquer outra coisa, extrai os dados (a IA só nos emails) e chama leads_inbound_process.
-- Decisões do Fábio (2026-10-23):
--   * emails dos portais chegam a um endereço do Make (sem domínio próprio); o cliente é identificado
--     pelo endereço original onde o portal entregou o email (client_inbox_addresses);
--   * nenhuma lead nasce com tarefa; uma lead repetida só recebe o evento "Novo contacto recebido".

-- ============================================================ CONFIGURAÇÃO
-- Formulários Meta de cada cliente: a página (todos os formulários dela), o formulário, ou os dois.
-- O gatilho de leads do Make só envia o id do formulário, por isso o formulário sozinho também serve.
create table public.lead_meta_forms (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  page_id text check (page_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  form_id text check (form_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  label text,
  created_at timestamptz not null default now(),
  constraint lead_meta_forms_pagina_ou_formulario check (page_id is not null or form_id is not null)
);
create unique index lead_meta_forms_unico on public.lead_meta_forms (coalesce(page_id, ''), coalesce(form_id, ''));
create index lead_meta_forms_client_idx on public.lead_meta_forms (client_id);

-- Endereços de email onde cada cliente recebe os emails dos portais (e que reencaminha para o Make).
create table public.client_inbox_addresses (
  address text primary key check (address = lower(address) and address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  client_id uuid not null references public.clients (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index client_inbox_addresses_client_idx on public.client_inbox_addresses (client_id);

alter table public.lead_meta_forms enable row level security;
alter table public.client_inbox_addresses enable row level security;
create policy "opera vê formulários" on public.lead_meta_forms for select using ((select private.leads_is_opera()));
create policy "opera cria formulários" on public.lead_meta_forms for insert with check ((select private.leads_is_opera()));
create policy "opera apaga formulários" on public.lead_meta_forms for delete using ((select private.leads_is_opera()));
create policy "opera vê endereços" on public.client_inbox_addresses for select using ((select private.leads_is_opera()));
create policy "opera cria endereços" on public.client_inbox_addresses for insert with check ((select private.leads_is_opera()));
create policy "opera apaga endereços" on public.client_inbox_addresses for delete using ((select private.leads_is_opera()));

-- Endereço de receção do Make, para as instruções aos clientes.
alter table public.leads_settings add column inbound_email text
  check (inbound_email is null or inbound_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- ============================================================ REGISTO DAS ENTRADAS
alter table public.inbound_log
  add column kind text not null default 'lead' check (kind in ('lead', 'gmail_code')),
  add column parsed jsonb,
  add column handled_at timestamptz,
  add column handled_by uuid references public.profiles (id) on delete set null;
alter table public.inbound_log drop constraint inbound_log_status_check;
alter table public.inbound_log add constraint inbound_log_status_check
  check (status in ('recebido', 'processado', 'revisao', 'duplicado', 'erro', 'sem_cliente'));
create index inbound_log_client_idx on public.inbound_log (client_id, channel, received_at desc);
create index inbound_log_pending_idx on public.inbound_log (received_at desc)
  where status = 'sem_cliente' or (kind = 'gmail_code' and handled_at is null);

-- ============================================================ PROCESSAR UMA ENTRADA
-- Lê os dados extraídos (parsed) de uma linha do inbound_log, encontra o cliente e cria a lead ou junta
-- um evento à lead existente. Idempotente: uma entrada já tratada devolve o mesmo resultado.
-- parsed: { name, phone, email, source, interest, reference, message, answers: [{q, a}], external_id,
--           source_created_at, page_id, form_id, client (alias ou id), recipients: [emails],
--           review (sem dados de contacto ou IA indisponível), review_reason }
create function private.leads_inbound_apply(p_log_id bigint) returns jsonb
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

  -- 2. Lead que já existe no cliente (mesmo telefone ou email): junta-se um evento, sem tarefa.
  select d.id into v_lead from public.leads_find_duplicate(v_client, p ->> 'phone', p ->> 'email') d;
  if v_lead is not null then
    insert into public.lead_events (lead_id, type, title, body, author_id, meta)
    values (v_lead, 'auto', 'Novo contacto recebido',
            concat_ws(E'\n\n',
              case when v_log.channel = 'meta' then 'Novo pedido pelo formulário Meta.'
                   else 'Novo email de ' || coalesce(nullif(p ->> 'source', ''), 'portal') || '.' end,
              case when nullif(p ->> 'interest', '') is not null then 'Imóvel: ' || (p ->> 'interest') end,
              case when nullif(p ->> 'reference', '') is not null then 'Referência do anúncio: ' || (p ->> 'reference') end,
              v_note),
            null,
            jsonb_build_object('inbound_log_id', p_log_id, 'channel', v_log.channel, 'reference', p ->> 'reference'));
    update public.inbound_log set status = 'duplicado', client_id = v_client, lead_id = v_lead, error = null where id = p_log_id;
    return jsonb_build_object('status', 'duplicado', 'lead_id', v_lead, 'client_id', v_client);
  end if;

  -- 3. Lead nova: Meta entra em Nova Lead Meta, emails dos portais em Nova lead imóveis. Sem tarefa.
  v_entry := case when v_log.channel = 'meta' then 'meta' else 'imoveis' end;
  select id into v_stage from public.lead_stages where key = v_entry;
  v_name := coalesce(nullif(trim(p ->> 'name'), ''), 'Sem nome');

  insert into public.leads (client_id, name, phone, email, source, interest, stage_id, entry_stage,
                            source_created_at, external_id, created_by)
  values (v_client, v_name, nullif(trim(p ->> 'phone'), ''), nullif(lower(trim(p ->> 'email')), ''),
          coalesce(nullif(trim(p ->> 'source'), ''), case when v_entry = 'meta' then 'Meta' else 'Portal' end),
          nullif(trim(p ->> 'interest'), ''), v_stage, v_entry,
          case when (p ->> 'source_created_at') ~ '^\d{4}-\d{2}-\d{2}' then (p ->> 'source_created_at')::timestamptz end,
          v_ext, null)
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

-- Chamada pela função leads-inbound (chave secreta do servidor). Nunca pelo browser.
create function public.leads_inbound_process(p_log_id bigint) returns jsonb
language sql security definer set search_path = public as $$
  select private.leads_inbound_apply(p_log_id);
$$;
revoke execute on function public.leads_inbound_process(bigint) from public, anon, authenticated;
grant execute on function public.leads_inbound_process(bigint) to service_role;

-- ============================================================ ECRÃ "ENTRADAS AUTOMÁTICAS"
create function public.leads_inbound_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA vê as entradas automáticas.'; end if;
  return jsonb_build_object(
    'inbound_email', (select inbound_email from public.leads_settings),
    'clients', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'color', c.color,
        'addresses', (select coalesce(jsonb_agg(a.address order by a.address), '[]'::jsonb)
                        from public.client_inbox_addresses a where a.client_id = c.id),
        'forms', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'page_id', f.page_id, 'form_id', f.form_id,
                                                               'label', f.label) order by f.created_at), '[]'::jsonb)
                    from public.lead_meta_forms f where f.client_id = c.id),
        'meta_last', (select max(i.received_at) from public.inbound_log i
                       where i.client_id = c.id and i.channel = 'meta' and i.kind = 'lead'),
        'email_last', (select max(i.received_at) from public.inbound_log i
                        where i.client_id = c.id and i.channel = 'email' and i.kind = 'lead')
      ) order by c.name), '[]'::jsonb)
      from public.clients c where c.leads_enabled and c.leads_status = 'ativo'),
    'codes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'received_at', i.received_at, 'code', i.parsed ->> 'code', 'address', i.parsed ->> 'address',
        'link', i.parsed ->> 'link', 'client', (select name from public.clients where id = i.client_id)
      ) order by i.received_at desc), '[]'::jsonb)
      from public.inbound_log i
      where i.kind = 'gmail_code' and i.handled_at is null and i.received_at > now() - interval '30 days'),
    'unassigned', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'received_at', i.received_at, 'channel', i.channel, 'error', i.error,
        'name', i.parsed ->> 'name', 'source', i.parsed ->> 'source',
        'recipients', i.parsed -> 'recipients', 'page_id', i.parsed ->> 'page_id', 'form_id', i.parsed ->> 'form_id'
      ) order by i.received_at desc), '[]'::jsonb)
      from public.inbound_log i
      where i.status = 'sem_cliente' and i.received_at > now() - interval '30 days'),
    'recent', (select coalesce(jsonb_agg(x order by x.received_at desc), '[]'::jsonb) from (
        select i.id, i.received_at, i.channel, i.status, i.error, i.lead_id, i.raw is not null as has_raw,
               (select name from public.clients where id = i.client_id) as client,
               (select name from public.leads where id = i.lead_id) as lead_name
          from public.inbound_log i where i.kind = 'lead'
         order by i.received_at desc limit 50) x)
  );
end;
$$;

-- Escolher o cliente de uma entrada que não foi identificada e criar a lead.
create function public.leads_inbound_assign(p_log_id bigint, p_client_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not private.leads_is_opera() then raise exception 'Sem permissão.'; end if;
  if not exists (select 1 from public.inbound_log where id = p_log_id and status = 'sem_cliente' and kind = 'lead') then
    raise exception 'Esta entrada já foi tratada.';
  end if;
  update public.inbound_log set client_id = p_client_id, status = 'recebido', handled_at = now(), handled_by = auth.uid()
   where id = p_log_id;
  v_out := private.leads_inbound_apply(p_log_id);
  perform public.leads_audit('entrada_atribuida', jsonb_build_object('inbound_log_id', p_log_id, 'client_id', p_client_id));
  return v_out;
end;
$$;

-- Código de confirmação do Gmail já enviado ao cliente.
create function public.leads_inbound_code_done(p_log_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_opera() then raise exception 'Sem permissão.'; end if;
  update public.inbound_log set handled_at = now(), handled_by = auth.uid()
   where id = p_log_id and kind = 'gmail_code';
end;
$$;

-- Email original (só a equipa OPERA, só enquanto o conteúdo bruto existe: 30 dias).
create function public.leads_inbound_original(p_log_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_raw jsonb;
begin
  if not private.leads_is_opera() then raise exception 'Sem permissão.'; end if;
  select raw into v_raw from public.inbound_log where id = p_log_id;
  perform public.leads_audit('ver_entrada_original', jsonb_build_object('inbound_log_id', p_log_id));
  return v_raw;
end;
$$;

revoke execute on function public.leads_inbound_overview() from public, anon;
revoke execute on function public.leads_inbound_assign(bigint, uuid) from public, anon;
revoke execute on function public.leads_inbound_code_done(bigint) from public, anon;
revoke execute on function public.leads_inbound_original(bigint) from public, anon;

-- RGPD: os dados extraídos seguem a mesma regra do conteúdo bruto (30 dias).
select cron.schedule('leads-entradas-limpeza', '25 3 * * *',
  $$update public.inbound_log set parsed = null where parsed is not null and received_at < now() - interval '30 days'$$);

-- ============================================================ CHAVE PARTILHADA COM O MAKE
-- Gerada ao acaso em cada ambiente e guardada no Vault; nunca aparece no código. O Make envia-a no
-- cabeçalho x-opera-secret e a função leads-inbound confirma-a aqui.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'leads_inbound_secret',
                           'Chave do Make para a função leads-inbound');

-- Chaves de teste (só no ambiente de testes): guarda-se apenas a impressão digital (sha256), nunca a chave.
create table private.leads_inbound_test_keys (hash text primary key, note text, created_at timestamptz not null default now());

create function public.leads_inbound_verify(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_secret) >= 32 and (
    p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'leads_inbound_secret')
    or exists (select 1 from private.leads_inbound_test_keys
                where hash = encode(extensions.digest(p_secret, 'sha256'), 'hex'))), false);
$$;
revoke execute on function public.leads_inbound_verify(text) from public, anon, authenticated;
grant execute on function public.leads_inbound_verify(text) to service_role;
