-- OPERA Leads: lead qualificada → mensagem automática na conversa do cliente (decisão do Fábio, 2026-10-28).
-- A mensagem sai em nome do gestor OPERA do cliente (sem gestor ativo, o admin), com a lead junta e o resumo
-- da qualificação. Gera a notificação no telemóvel (que substitui a notificação "Lead qualificada" de antes),
-- mas não entra nos emails de "mensagens por ler". O email "Lead qualificada" continua igual.
-- Na conversa, a mensagem aparece destacada (client_messages.auto = 'qualificada').

alter table public.client_messages add column auto text check (auto in ('qualificada'));

-- Texto da mensagem: nome, resumo da qualificação (só o que está preenchido) e o convite a responder.
create function private.leads_qualified_message_text(p_lead public.leads) returns text
language sql stable set search_path = public as $$
  select concat_ws(E'\n',
    'Lead qualificada: ' || coalesce(nullif(p_lead.name, ''), 'Sem nome'),
    nullif(concat_ws(' · ',
      nullif(p_lead.qualification ->> 'Objetivo', ''),
      'Budget ' || nullif(p_lead.qualification ->> 'Budget', ''),
      'Prazo: ' || nullif(p_lead.qualification ->> 'Prazo', ''),
      'Financiamento: ' || nullif(p_lead.qualification ->> 'Financiamento', '')), ''),
    'Já está nas vossas leads, com o resumo da chamada. Qualquer dúvida sobre esta lead, respondam aqui.');
$$;

-- Quando o aviso "qualificada" entra na fila (uma vez por qualificação), entra a mensagem na conversa.
-- A notificação no telemóvel passa a sair pela mensagem; a de lead criada pelo cliente fica como estava.
create or replace function private.leads_push_notification() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lead public.leads; v_client public.clients; v_author uuid;
begin
  select * into v_lead from public.leads where id = new.lead_id;
  if v_lead.anonymized then return null; end if;
  select * into v_client from public.clients where id = v_lead.client_id;
  if new.kind = 'qualificada' then
    if not v_client.leads_enabled or v_client.leads_status <> 'ativo' then return null; end if;
    select p.id into v_author from public.profiles p
     where p.leads_status = 'ativo' and (p.id = v_client.manager_id or p.leads_role = 'admin')
     order by (p.id = v_client.manager_id) desc, p.created_at limit 1;
    if v_author is null then return null; end if;
    insert into public.client_messages (client_id, author_id, body, lead_id, auto)
    values (v_lead.client_id, v_author, left(private.leads_qualified_message_text(v_lead), 4000), v_lead.id, 'qualificada');
  elsif new.kind = 'nova_lead_do_cliente' then
    perform private.leads_push(array(select r.id from private.leads_message_readers(v_lead.client_id, 'opera') r),
      v_client.name || ' criou uma lead · ' || v_lead.name, 'A lead está à espera do contacto da OPERA.',
      private.leads_app_link('lead=' || v_lead.id), v_lead.id::text);
  end if;
  return null;
end;
$$;

-- Notificação da mensagem: a automática leva o título "Lead qualificada".
create or replace function private.leads_push_message() returns trigger
language plpgsql security definer set search_path = public as $$
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
      'Lead qualificada · ' || coalesce(v_lead, ''), 'A OPERA qualificou esta lead para ' || v_client.name || '. Toque para ver.',
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
$$;

-- Emails de "mensagens por ler": as mensagens automáticas não contam.
do $do$
declare d text; n int;
begin
  d := pg_get_functiondef('private.leads_message_alerts()'::regprocedure);
  n := length(d);
  d := replace(d, 'where m.deleted_at is null and m.created_at <= now()', 'where m.deleted_at is null and m.auto is null and m.created_at <= now()');
  if length(d) = n then raise exception 'leads_message_alerts: substituição falhou'; end if;
  execute d;
end;
$do$;

-- A conversa devolve também o tipo da mensagem automática, para a destacar.
drop function public.leads_conversation(uuid, timestamptz, integer);
create function public.leads_conversation(p_client_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns table (id uuid, author_id uuid, author_name text, side text, body text, audio_path text, audio_seconds integer,
               lead_id uuid, lead_name text, lead_stage text, lead_open boolean,
               created_at timestamptz, edited_at timestamptz, deleted_at timestamptz, auto text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.leads_can_chat(p_client_id) then raise exception 'Sem acesso a esta conversa.'; end if;
  return query
    select m.id, m.author_id, coalesce(p.full_name, p.email, 'Utilizador apagado'),
           coalesce(private.leads_message_side(m.author_id), 'opera'), m.body, m.audio_path, m.audio_seconds,
           l.id, l.name, s.name,
           -- Abre a ficha só quem a pode ver (por exemplo, não depois de o cliente perder o acesso).
           l.id is not null and private.leads_can_read(l.id),
           m.created_at, m.edited_at, m.deleted_at, m.auto
      from public.client_messages m
      left join public.profiles p on p.id = m.author_id
      left join public.leads l on l.id = m.lead_id and not l.anonymized
      left join public.lead_stages s on s.id = l.stage_id
     where m.client_id = p_client_id and (p_before is null or m.created_at < p_before)
     order by m.created_at desc
     limit least(greatest(p_limit, 1), 200);
end;
$$;
revoke execute on function public.leads_conversation(uuid, timestamptz, integer) from public, anon;
