-- OPERA Leads, Fase 8: uma conversa por cliente, entre a equipa OPERA e os utilizadores desse cliente.
-- Plano: docs/leads/fase-8-plano.md. Decidido a 2026-10-25: só texto (anexos ficam para uma 8b); o email de aviso
-- do lado da OPERA vai para o gestor do cliente; os avisos ao cliente saem a qualquer hora.
--
-- Mensagens: texto até 4000 caracteres, com quem escreveu e quando. Pode juntar uma lead do mesmo
-- cliente, em qualquer etapa. Quem escreveu pode editar ou apagar durante 15 minutos.
-- Por ler: cada pessoa tem a hora da última leitura de cada conversa (client_message_reads).
-- Aviso por email: uma mensagem por ler há 15 minutos gera um aviso a quem a devia ler; no máximo 1 por hora
-- por conversa e por lado. Sai pela função leads-notify, como os avisos das leads.

-- ============================================================ TABELAS
create table public.client_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  body text check (body is null or char_length(body) between 1 and 4000),
  lead_id uuid references public.leads (id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint client_messages_texto_ou_apagada check ((deleted_at is null) = (body is not null))
);
create index client_messages_conversa_idx on public.client_messages (client_id, created_at desc);

create table public.client_message_reads (
  user_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

-- Fila dos avisos por email (side: quem é avisado).
create table public.client_message_notifications (
  id bigserial primary key,
  client_id uuid not null references public.clients (id) on delete cascade,
  side text not null check (side in ('cliente', 'opera')),
  upto timestamptz not null,
  status text not null default 'pendente' check (status in ('pendente', 'enviado', 'erro')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  recipients text[],
  provider_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index client_message_notifications_fila_idx on public.client_message_notifications (status, next_attempt_at);
create index client_message_notifications_conversa_idx on public.client_message_notifications (client_id, side, created_at desc);

alter table public.client_messages enable row level security;
alter table public.client_message_reads enable row level security;
alter table public.client_message_notifications enable row level security;

-- ============================================================ ACESSO
-- Conversa de um cliente: equipa OPERA (dois passos) nos clientes ativos, ou utilizador desse cliente.
create function private.leads_can_chat(p_client_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (private.leads_is_opera() and private.leads_client_active(p_client_id))
      or p_client_id = private.leads_my_client_id();
$$;

-- As mensagens leem-se diretamente (tempo real) e escrevem-se só pelas funções abaixo.
create policy "ver mensagens da conversa" on public.client_messages for select
  using (private.leads_can_chat(client_id));
create policy "ver as minhas leituras" on public.client_message_reads for select
  using (user_id = auth.uid());
create policy "opera vê os avisos das conversas" on public.client_message_notifications for select
  using (private.leads_is_opera());

-- Lado de quem escreveu: OPERA (admin ou gestor) ou cliente.
create function private.leads_message_side(p_author uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when leads_role in ('admin', 'gestor') then 'opera' else 'cliente' end
    from public.profiles where id = p_author;
$$;

-- ============================================================ ESCREVER
create function public.leads_message_send(p_client_id uuid, p_body text, p_lead_id uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_body text := nullif(trim(p_body), '');
begin
  if not private.leads_can_chat(p_client_id) then raise exception 'Sem acesso a esta conversa.'; end if;
  if v_body is null then raise exception 'Escreve a mensagem primeiro.'; end if;
  if char_length(v_body) > 4000 then raise exception 'A mensagem é demasiado longa (máximo 4000 caracteres).'; end if;
  -- Junta-se qualquer lead deste cliente, em qualquer etapa, desde que quem escreve a veja.
  if p_lead_id is not null and not exists (
       select 1 from public.leads l
        where l.id = p_lead_id and l.client_id = p_client_id and not l.anonymized and private.leads_can_read(l.id)) then
    raise exception 'Só se pode juntar uma lead deste cliente.';
  end if;
  insert into public.client_messages (client_id, author_id, body, lead_id)
  values (p_client_id, auth.uid(), v_body, p_lead_id)
  returning id into v_id;
  -- Quem escreve leu a conversa até aqui.
  insert into public.client_message_reads (user_id, client_id, last_read_at) values (auth.uid(), p_client_id, now())
  on conflict (user_id, client_id) do update set last_read_at = greatest(client_message_reads.last_read_at, excluded.last_read_at);
  return v_id;
end;
$$;

-- Editar ou apagar: só quem escreveu, durante 15 minutos. Apagar tira o texto e fica a indicação.
create function public.leads_message_edit(p_id uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare v_m public.client_messages; v_body text := nullif(trim(p_body), '');
begin
  select * into v_m from public.client_messages where id = p_id for update;
  if v_m.id is null or v_m.author_id is distinct from auth.uid() or not private.leads_can_chat(v_m.client_id) then
    raise exception 'Só quem escreveu pode mudar esta mensagem.';
  end if;
  if v_m.deleted_at is not null then raise exception 'Esta mensagem foi apagada.'; end if;
  if v_m.created_at < now() - interval '15 minutes' then raise exception 'Só se pode mudar uma mensagem nos primeiros 15 minutos.'; end if;
  if v_body is null then raise exception 'A mensagem não pode ficar vazia.'; end if;
  if char_length(v_body) > 4000 then raise exception 'A mensagem é demasiado longa (máximo 4000 caracteres).'; end if;
  if v_body is distinct from v_m.body then
    update public.client_messages set body = v_body, edited_at = now() where id = p_id;
  end if;
end;
$$;

create function public.leads_message_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_m public.client_messages;
begin
  select * into v_m from public.client_messages where id = p_id for update;
  if v_m.id is null or v_m.author_id is distinct from auth.uid() or not private.leads_can_chat(v_m.client_id) then
    raise exception 'Só quem escreveu pode apagar esta mensagem.';
  end if;
  if v_m.deleted_at is not null then return; end if;
  if v_m.created_at < now() - interval '15 minutes' then raise exception 'Só se pode apagar uma mensagem nos primeiros 15 minutos.'; end if;
  update public.client_messages set body = null, lead_id = null, deleted_at = now() where id = p_id;
end;
$$;

create function public.leads_conversation_mark_read(p_client_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_can_chat(p_client_id) then raise exception 'Sem acesso a esta conversa.'; end if;
  insert into public.client_message_reads (user_id, client_id, last_read_at) values (auth.uid(), p_client_id, now())
  on conflict (user_id, client_id) do update set last_read_at = excluded.last_read_at;
end;
$$;

-- ============================================================ LER
-- Mensagens de uma conversa, das mais recentes para trás (p_before para carregar as anteriores).
create function public.leads_conversation(p_client_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns table (id uuid, author_id uuid, author_name text, side text, body text, lead_id uuid, lead_name text,
               lead_stage text, lead_open boolean, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.leads_can_chat(p_client_id) then raise exception 'Sem acesso a esta conversa.'; end if;
  return query
    select m.id, m.author_id, coalesce(p.full_name, p.email, 'Utilizador apagado'),
           coalesce(private.leads_message_side(m.author_id), 'opera'), m.body, l.id, l.name, s.name,
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

-- Lista de conversas de quem chama, com a última mensagem e as por ler (as escritas por outras pessoas
-- depois da última leitura). A equipa OPERA vê os clientes ativos, sem o cliente interno (a própria OPERA).
create function public.leads_conversations()
returns table (client_id uuid, client_name text, client_color text, last_at timestamptz, last_body text,
               last_author text, unread integer)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.color, lm.created_at,
         case when lm.deleted_at is not null then 'Mensagem apagada' else left(lm.body, 140) end,
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

-- Exportação da conversa quando o cliente sai (equipa OPERA).
create function public.leads_messages_export(p_client_id uuid)
returns table (created_at timestamptz, author text, side text, body text, lead text, edited boolean, deleted boolean)
language plpgsql volatile security definer set search_path = public as $$
begin
  if not (private.leads_is_admin() or (private.leads_is_opera() and private.leads_client_active(p_client_id))) then
    raise exception 'Só a equipa OPERA exporta conversas.';
  end if;
  perform public.leads_audit('exportar_conversa', jsonb_build_object('client_id', p_client_id));
  return query
    select m.created_at, coalesce(p.full_name, p.email, 'Utilizador apagado'), coalesce(private.leads_message_side(m.author_id), 'opera'),
           m.body, l.name, m.edited_at is not null, m.deleted_at is not null
      from public.client_messages m
      left join public.profiles p on p.id = m.author_id
      left join public.leads l on l.id = m.lead_id
     where m.client_id = p_client_id
     order by m.created_at;
end;
$$;

-- ============================================================ AVISOS POR EMAIL
-- Quem devia ler: do lado do cliente, os utilizadores ativos; do lado da OPERA, o gestor do cliente
-- (sem gestor, os admins).
create function private.leads_message_readers(p_client_id uuid, p_side text) returns setof public.profiles
language sql stable security definer set search_path = public as $$
  select p.* from public.profiles p
   where p_side = 'cliente' and p.client_id = p_client_id and p.leads_status = 'ativo'
     and p.leads_role in ('cliente_admin', 'cliente') and p.email is not null
  union all
  select p.* from public.profiles p join public.clients c on c.id = p_client_id
   where p_side = 'opera' and p.leads_status = 'ativo' and p.email is not null
     and (p.id = c.manager_id
          or (p.leads_role = 'admin' and not exists (select 1 from public.profiles m
                                                      where m.id = c.manager_id and m.leads_status = 'ativo')));
$$;

-- De 5 em 5 minutos: conversas com mensagens do outro lado por ler há 15 minutos por todos os que as deviam
-- ler. No máximo 1 aviso por hora por conversa e lado, e nunca duas vezes pelas mesmas mensagens.
create function private.leads_message_alerts() returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  insert into public.client_message_notifications (client_id, side, upto)
  select x.client_id, x.side, x.upto
    from (
      select m.client_id, s.side, max(m.created_at) upto
        from public.client_messages m
        join public.clients c on c.id = m.client_id and c.leads_enabled and c.leads_status = 'ativo' and not c.leads_internal
        cross join lateral (select case private.leads_message_side(m.author_id) when 'opera' then 'cliente' else 'opera' end side) s
       where m.deleted_at is null and m.created_at <= now() - interval '15 minutes'
         and m.created_at > now() - interval '3 days'
         -- ninguém do outro lado leu a mensagem
         and not exists (select 1 from private.leads_message_readers(m.client_id, s.side) rd
                           join public.client_message_reads r on r.user_id = rd.id and r.client_id = m.client_id
                          where r.last_read_at >= m.created_at)
         -- ainda não avisado por esta mensagem
         and not exists (select 1 from public.client_message_notifications n
                          where n.client_id = m.client_id and n.side = s.side and n.upto >= m.created_at)
       group by m.client_id, s.side) x
   where exists (select 1 from private.leads_message_readers(x.client_id, x.side))
     and not exists (select 1 from public.client_message_notifications n
                      where n.client_id = x.client_id and n.side = x.side and n.created_at > now() - interval '1 hour');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function private.leads_message_notification_payload(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', n.id, 'kind', 'mensagens', 'side', n.side, 'attempts', n.attempts,
    'app_url', (select value from private.leads_config where key = 'app_url'),
    'redirect_to', (select value from private.leads_config where key = 'email_redirect_to'),
    'client_id', c.id, 'client', c.name,
    'manager', (select jsonb_build_object('name', m.full_name, 'email', m.email) from public.profiles m where m.id = c.manager_id),
    -- As mensagens do outro lado ainda por ler (até 5), da mais antiga para a mais recente.
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('author', x.author, 'body', x.body, 'at', x.created_at) order by x.created_at)
        from (select coalesce(p.full_name, p.email) author, m.body, m.created_at
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

create function public.leads_message_notifications_claim(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ids bigint[];
begin
  with c as (
    select n.id from public.client_message_notifications n
     where n.status = 'pendente' and n.next_attempt_at <= now()
     order by n.created_at limit greatest(1, least(p_limit, 100))
     for update skip locked),
  u as (
    update public.client_message_notifications n
       set attempts = n.attempts + 1,
           next_attempt_at = now() + make_interval(mins => 5 * power(2, n.attempts)::int)
      from c where n.id = c.id
    returning n.id)
  select array_agg(id) into v_ids from u;
  return coalesce((select jsonb_agg(private.leads_message_notification_payload(id) order by id) from unnest(v_ids) id), '[]'::jsonb);
end;
$$;

create function public.leads_message_notification_done(p_id bigint, p_ok boolean, p_error text default null,
                                                       p_provider_id text default null, p_recipients text[] default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_n public.client_message_notifications;
begin
  select * into v_n from public.client_message_notifications where id = p_id for update;
  if v_n.id is null then return; end if;
  if p_ok then
    update public.client_message_notifications set status = 'enviado', sent_at = now(), error = null,
           provider_id = p_provider_id, recipients = p_recipients where id = p_id;
  elsif v_n.attempts >= 5 or p_error = 'Sem destinatários.' then
    update public.client_message_notifications set status = 'erro', error = left(p_error, 500), recipients = p_recipients where id = p_id;
  else
    update public.client_message_notifications set error = left(p_error, 500) where id = p_id;
  end if;
end;
$$;

create function public.leads_message_notification_preview(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select private.leads_message_notification_payload(p_id);
$$;

-- Ao entrar um aviso na fila, pede logo o envio (como os avisos das leads).
create trigger client_message_notifications_after_insert after insert on public.client_message_notifications
  for each statement execute function private.leads_notifications_after_insert();

select cron.schedule('leads-avisos-conversas', '*/5 * * * *', $$ select private.leads_message_alerts() $$);
-- Os pedidos de envio que falharam voltam a ser pedidos pelo mesmo relógio dos avisos das leads.
select cron.schedule('leads-avisos-conversas-reenvio', '*/5 * * * *', $$
  select private.leads_notify_kick()
   where exists (select 1 from public.client_message_notifications where status = 'pendente' and next_attempt_at <= now())
$$);

-- ============================================================ RGPD
-- As mensagens apagam-se com o resto quando os dados de um cliente inativo são apagados (à mão ou ao fim dos
-- 6 meses): as duas rotinas apagam as etapas do cliente depois das leads.
create function private.leads_purge_messages() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.client_messages m using public.clients c
   where m.client_id = c.id and c.leads_status = 'inativo' and c.id in (select g.client_id from gone g);
  delete from public.client_message_reads r using public.clients c
   where r.client_id = c.id and c.leads_status = 'inativo' and c.id in (select g.client_id from gone g);
  delete from public.client_message_notifications n using public.clients c
   where n.client_id = c.id and c.leads_status = 'inativo' and c.id in (select g.client_id from gone g);
  return null;
end;
$$;
create trigger leads_purge_messages after delete on public.lead_stages
  referencing old table as gone for each statement execute function private.leads_purge_messages();

-- ============================================================ TEMPO REAL E PERMISSÕES
alter publication supabase_realtime add table public.client_messages, public.client_message_reads;

revoke execute on function public.leads_message_send(uuid, text, uuid) from public, anon;
revoke execute on function public.leads_message_edit(uuid, text) from public, anon;
revoke execute on function public.leads_message_delete(uuid) from public, anon;
revoke execute on function public.leads_conversation_mark_read(uuid) from public, anon;
revoke execute on function public.leads_conversation(uuid, timestamptz, integer) from public, anon;
revoke execute on function public.leads_conversations() from public, anon;
revoke execute on function public.leads_messages_export(uuid) from public, anon;
revoke execute on function public.leads_message_notifications_claim(integer) from public, anon, authenticated;
revoke execute on function public.leads_message_notification_done(bigint, boolean, text, text, text[]) from public, anon, authenticated;
revoke execute on function public.leads_message_notification_preview(bigint) from public, anon, authenticated;
grant execute on function public.leads_message_notifications_claim(integer) to service_role;
grant execute on function public.leads_message_notification_done(bigint, boolean, text, text, text[]) to service_role;
grant execute on function public.leads_message_notification_preview(bigint) to service_role;
revoke execute on function private.leads_message_alerts() from public, anon, authenticated;
revoke execute on function private.leads_purge_messages() from public, anon, authenticated;
