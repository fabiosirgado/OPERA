-- OPERA Leads, Fase 8: mensagens de voz nas conversas.
--
-- O áudio é gravado no browser (até 5 minutos) e guardado no armazenamento privado "conversas" do Supabase (UE),
-- numa pasta por cliente: <client_id>/<id>.<webm|mp4|ogg>. Só quem está na conversa envia e ouve (links assinados).
-- Apagar: o Supabase só deixa apagar ficheiros pela API de armazenamento. Quando uma mensagem de voz é apagada (pela
-- pessoa, ou com a conversa quando um cliente desativado é apagado), o ficheiro entra na fila
-- client_message_files_gone e a função leads-notify apaga-o na volta seguinte (no máximo 5 minutos).
-- Ficheiros carregados e nunca enviados também entram na fila ao fim de um dia.

-- ============================================================ ARMAZENAMENTO
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('conversas', 'conversas', false, 10485760, array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/aac'])
on conflict (id) do nothing;

-- Pasta do ficheiro = cliente da conversa. Nome mal formado não dá acesso nenhum.
create function private.leads_chat_file_client(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(webm|mp4|ogg|m4a|mp3|aac)$' then split_part(p_name, '/', 1)::uuid end;
$$;

create policy "conversas: enviar voz" on storage.objects for insert to authenticated
  with check (bucket_id = 'conversas' and private.leads_can_chat(private.leads_chat_file_client(name)));
create policy "conversas: ouvir voz" on storage.objects for select to authenticated
  using (bucket_id = 'conversas' and private.leads_can_chat(private.leads_chat_file_client(name)));

-- ============================================================ MENSAGENS
alter table public.client_messages
  add column audio_path text unique,
  add column audio_seconds integer check (audio_seconds between 1 and 300),
  drop constraint client_messages_texto_ou_apagada,
  add constraint client_messages_texto_ou_apagada
    check ((deleted_at is null) = (body is not null or audio_path is not null)),
  add constraint client_messages_voz_com_duracao check ((audio_path is null) = (audio_seconds is null));

create table public.client_message_files_gone (
  path text primary key,
  created_at timestamptz not null default now()
);
alter table public.client_message_files_gone enable row level security;

-- Texto de uma mensagem para a lista, o email e a exportação: "Mensagem de voz (0:42)" e a legenda, se houver.
create function private.leads_message_text(p_body text, p_audio_seconds integer) returns text
language sql immutable set search_path = '' as $$
  select case when p_audio_seconds is null then p_body
              else 'Mensagem de voz (' || (p_audio_seconds / 60) || ':' || lpad((p_audio_seconds % 60)::text, 2, '0') || ')'
                   || coalesce(E'\n' || p_body, '') end;
$$;

create function private.leads_message_file_gone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.audio_path is not null and (tg_op = 'DELETE' or new.audio_path is distinct from old.audio_path) then
    insert into public.client_message_files_gone (path) values (old.audio_path) on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger client_messages_file_gone after update of audio_path or delete on public.client_messages
  for each row execute function private.leads_message_file_gone();

drop function public.leads_message_send(uuid, text, uuid);
create function public.leads_message_send(p_client_id uuid, p_body text, p_lead_id uuid default null,
                                          p_audio_path text default null, p_audio_seconds integer default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_body text := nullif(trim(p_body), '');
begin
  if not private.leads_can_chat(p_client_id) then raise exception 'Sem acesso a esta conversa.'; end if;
  if v_body is null and p_audio_path is null then raise exception 'Escreve a mensagem primeiro.'; end if;
  if char_length(v_body) > 4000 then raise exception 'A mensagem é demasiado longa (máximo 4000 caracteres).'; end if;
  if p_audio_path is not null then
    if private.leads_chat_file_client(p_audio_path) is distinct from p_client_id
       or not exists (select 1 from storage.objects o
                       where o.bucket_id = 'conversas' and o.name = p_audio_path and o.owner_id = auth.uid()::text) then
      raise exception 'A gravação não foi encontrada. Grava outra vez.';
    end if;
    if exists (select 1 from public.client_messages where audio_path = p_audio_path) then
      raise exception 'Esta gravação já foi enviada.';
    end if;
    if p_audio_seconds is null or p_audio_seconds not between 1 and 300 then
      raise exception 'A mensagem de voz pode ter até 5 minutos.';
    end if;
  end if;
  -- Junta-se qualquer lead deste cliente, em qualquer etapa, desde que quem escreve a veja.
  if p_lead_id is not null and not exists (
       select 1 from public.leads l
        where l.id = p_lead_id and l.client_id = p_client_id and not l.anonymized and private.leads_can_read(l.id)) then
    raise exception 'Só se pode juntar uma lead deste cliente.';
  end if;
  insert into public.client_messages (client_id, author_id, body, lead_id, audio_path, audio_seconds)
  values (p_client_id, auth.uid(), v_body, p_lead_id, p_audio_path, case when p_audio_path is not null then p_audio_seconds end)
  returning id into v_id;
  -- Quem escreve leu a conversa até aqui.
  insert into public.client_message_reads (user_id, client_id, last_read_at) values (auth.uid(), p_client_id, now())
  on conflict (user_id, client_id) do update set last_read_at = greatest(client_message_reads.last_read_at, excluded.last_read_at);
  return v_id;
end;
$$;
revoke execute on function public.leads_message_send(uuid, text, uuid, text, integer) from public, anon;

-- Mudar: numa mensagem de voz muda-se só a legenda (e pode ficar sem legenda).
create or replace function public.leads_message_edit(p_id uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare v_m public.client_messages; v_body text := nullif(trim(p_body), '');
begin
  select * into v_m from public.client_messages where id = p_id for update;
  if v_m.id is null or v_m.author_id is distinct from auth.uid() or not private.leads_can_chat(v_m.client_id) then
    raise exception 'Só quem escreveu pode mudar esta mensagem.';
  end if;
  if v_m.deleted_at is not null then raise exception 'Esta mensagem foi apagada.'; end if;
  if v_m.created_at < now() - interval '15 minutes' then raise exception 'Só se pode mudar uma mensagem nos primeiros 15 minutos.'; end if;
  if v_body is null and v_m.audio_path is null then raise exception 'A mensagem não pode ficar vazia.'; end if;
  if char_length(v_body) > 4000 then raise exception 'A mensagem é demasiado longa (máximo 4000 caracteres).'; end if;
  if v_body is distinct from v_m.body then
    update public.client_messages set body = v_body, edited_at = now() where id = p_id;
  end if;
end;
$$;

create or replace function public.leads_message_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_m public.client_messages;
begin
  select * into v_m from public.client_messages where id = p_id for update;
  if v_m.id is null or v_m.author_id is distinct from auth.uid() or not private.leads_can_chat(v_m.client_id) then
    raise exception 'Só quem escreveu pode apagar esta mensagem.';
  end if;
  if v_m.deleted_at is not null then return; end if;
  if v_m.created_at < now() - interval '15 minutes' then raise exception 'Só se pode apagar uma mensagem nos primeiros 15 minutos.'; end if;
  update public.client_messages set body = null, lead_id = null, audio_path = null, audio_seconds = null, deleted_at = now()
   where id = p_id;
end;
$$;

drop function public.leads_conversation(uuid, timestamptz, integer);
create function public.leads_conversation(p_client_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns table (id uuid, author_id uuid, author_name text, side text, body text, audio_path text, audio_seconds integer,
               lead_id uuid, lead_name text, lead_stage text, lead_open boolean,
               created_at timestamptz, edited_at timestamptz, deleted_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.leads_can_chat(p_client_id) then raise exception 'Sem acesso a esta conversa.'; end if;
  return query
    select m.id, m.author_id, coalesce(p.full_name, p.email, 'Utilizador apagado'),
           coalesce(private.leads_message_side(m.author_id), 'opera'), m.body, m.audio_path, m.audio_seconds,
           l.id, l.name, s.name,
           -- Abre a ficha só quem a pode ver (por exemplo, não depois de o cliente perder o acesso).
           l.id is not null and private.leads_can_read(l.id),
           m.created_at, m.edited_at, m.deleted_at
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

create or replace function public.leads_conversations()
returns table (client_id uuid, client_name text, client_color text, last_at timestamptz, last_body text,
               last_author text, unread integer)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.color, lm.created_at,
         case when lm.deleted_at is not null then 'Mensagem apagada' else left(private.leads_message_text(lm.body, lm.audio_seconds), 140) end,
         (select coalesce(p.full_name, p.email) from public.profiles p where p.id = lm.author_id),
         (select count(*)::int from public.client_messages m
           where m.client_id = c.id and m.deleted_at is null and m.author_id is distinct from auth.uid()
             and m.created_at > coalesce(r.last_read_at, '-infinity'))
    from public.clients c
    left join public.client_message_reads r on r.client_id = c.id and r.user_id = auth.uid()
    left join lateral (select m.* from public.client_messages m where m.client_id = c.id
                        order by m.created_at desc limit 1) lm on true
   where (private.leads_is_opera() and c.leads_enabled and c.leads_status = 'ativo' and not c.leads_internal)
      or c.id = private.leads_my_client_id()
   order by lm.created_at desc nulls last, c.name;
$$;

create or replace function public.leads_messages_export(p_client_id uuid)
returns table (created_at timestamptz, author text, side text, body text, lead text, edited boolean, deleted boolean)
language plpgsql volatile security definer set search_path = public as $$
begin
  if not (private.leads_is_admin() or (private.leads_is_opera() and private.leads_client_active(p_client_id))) then
    raise exception 'Só a equipa OPERA exporta conversas.';
  end if;
  perform public.leads_audit('exportar_conversa', jsonb_build_object('client_id', p_client_id));
  return query
    select m.created_at, coalesce(p.full_name, p.email, 'Utilizador apagado'), coalesce(private.leads_message_side(m.author_id), 'opera'),
           private.leads_message_text(m.body, m.audio_seconds), l.name, m.edited_at is not null, m.deleted_at is not null
      from public.client_messages m
      left join public.profiles p on p.id = m.author_id
      left join public.leads l on l.id = m.lead_id
     where m.client_id = p_client_id
     order by m.created_at;
end;
$$;

-- Email: a mensagem de voz aparece como "Mensagem de voz (0:42)"; ouve-se na plataforma.
create or replace function private.leads_message_notification_payload(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', n.id, 'kind', 'mensagens', 'side', n.side, 'attempts', n.attempts,
    'app_url', (select value from private.leads_config where key = 'app_url'),
    'redirect_to', (select value from private.leads_config where key = 'email_redirect_to'),
    'client_id', c.id, 'client', c.name,
    'manager', (select jsonb_build_object('name', m.full_name, 'email', m.email) from public.profiles m where m.id = c.manager_id),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('author', x.author, 'body', x.body, 'at', x.created_at) order by x.created_at)
        from (select coalesce(p.full_name, p.email) author, private.leads_message_text(m.body, m.audio_seconds) body, m.created_at
                from public.client_messages m left join public.profiles p on p.id = m.author_id
               where m.client_id = c.id and m.deleted_at is null and m.created_at <= n.upto
                 and private.leads_message_side(m.author_id) <> n.side
                 and m.created_at > coalesce((select max(r.last_read_at) from public.client_message_reads r
                                               join private.leads_message_readers(c.id, n.side) rd on rd.id = r.user_id
                                              where r.client_id = c.id), '-infinity')
               order by m.created_at desc limit 5) x), '[]'::jsonb),
    'to', coalesce((select jsonb_agg(rd.email order by rd.email) from private.leads_message_readers(c.id, n.side) rd), '[]'::jsonb))
  from public.client_message_notifications n join public.clients c on c.id = n.client_id
  where n.id = p_id;
$$;

-- ============================================================ FILA DOS FICHEIROS A APAGAR (só a função leads-notify)
create function public.leads_message_files_claim(p_limit integer default 100) returns text[]
language sql security definer set search_path = public as $$
  -- Gravações carregadas há mais de um dia e nunca enviadas também saem.
  with orphans as (
    insert into public.client_message_files_gone (path)
    select o.name from storage.objects o
     where o.bucket_id = 'conversas' and o.created_at < now() - interval '1 day'
       and not exists (select 1 from public.client_messages m where m.audio_path = o.name)
    on conflict do nothing returning path)
  select coalesce(array_agg(path), '{}') from (
    select path from public.client_message_files_gone
    union select path from orphans
    limit greatest(1, least(p_limit, 1000))) x;
$$;

create function public.leads_message_files_done(p_paths text[]) returns void
language sql security definer set search_path = public as $$
  delete from public.client_message_files_gone where path = any(p_paths);
$$;

revoke execute on function public.leads_message_files_claim(integer) from public, anon, authenticated;
revoke execute on function public.leads_message_files_done(text[]) from public, anon, authenticated;
grant execute on function public.leads_message_files_claim(integer) to service_role;
grant execute on function public.leads_message_files_done(text[]) to service_role;
revoke execute on function private.leads_message_file_gone() from public, anon, authenticated;

-- A volta de 5 em 5 minutos também corre quando há ficheiros para apagar (ou gravações esquecidas).
select cron.unschedule('leads-avisos-conversas-reenvio');
select cron.schedule('leads-avisos-conversas-reenvio', '*/5 * * * *', $$
  select private.leads_notify_kick()
   where exists (select 1 from public.client_message_notifications where status = 'pendente' and next_attempt_at <= now())
      or exists (select 1 from public.client_message_files_gone)
      or exists (select 1 from storage.objects o where o.bucket_id = 'conversas' and o.created_at < now() - interval '1 day'
                  and not exists (select 1 from public.client_messages m where m.audio_path = o.name))
$$);
