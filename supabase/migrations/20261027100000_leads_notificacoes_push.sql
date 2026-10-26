-- OPERA Leads como app instalável (PWA): notificações no telemóvel (web push).
--
-- Cada telemóvel ou computador onde a pessoa ativa as notificações fica em push_subscriptions.
-- Avisos que saem por push, logo na hora:
--   lead nova (entrada automática ou criada pela OPERA)  à equipa OPERA do cliente (gestor; sem gestor, o admin)
--   lead criada pelo cliente                              à equipa OPERA do cliente
--   lead qualificada                                      ao cliente: o responsável da lead ou todos os utilizadores ativos
--   mensagem nova na conversa                             a quem está do outro lado da conversa
-- Quem fez a ação não é avisado. As leads importadas (Excel, Pipedrive) não geram aviso.
-- Envio: a fila lead_push_queue é lida pela função leads-notify, que também cria as chaves VAPID na primeira vez
-- (a chave privada fica só aqui, em private.leads_push_keys, e nunca sai da base de dados e da função).

-- ============================================================ DISPOSITIVOS
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  user_agent text check (char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
create policy "cada um vê os seus dispositivos" on public.push_subscriptions for select
  using (user_id = (select auth.uid()));

-- Ativar neste dispositivo. O mesmo browser com outra pessoa passa a ser dessa pessoa.
create function public.leads_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if private.leads_role() is null then raise exception 'Sem acesso ao OPERA Leads.'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, created_at = now();
end;
$$;

create function public.leads_push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- ============================================================ CHAVES VAPID
create table private.leads_push_keys (
  id boolean primary key default true check (id),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);

-- Chave pública, para o browser poder subscrever (null até a função leads-notify a criar).
create function public.leads_push_public_key() returns text
language sql stable security definer set search_path = '' as $$
  select public_key from private.leads_push_keys;
$$;

-- Só para a função leads-notify: devolve as chaves, criando-as com as que a função gerou se ainda não existirem.
create function public.leads_push_keys(p_public text default null, p_private text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_public is not null and p_private is not null then
    insert into private.leads_push_keys (public_key, private_key) values (p_public, p_private) on conflict do nothing;
  end if;
  return (select jsonb_build_object('public', public_key, 'private', private_key) from private.leads_push_keys);
end;
$$;

-- ============================================================ FILA
create table public.lead_push_queue (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  body text,
  url text,
  tag text,
  status text not null default 'pendente' check (status in ('pendente', 'enviado', 'erro')),
  sent_at timestamptz,
  error text
);
create index lead_push_queue_pendente_idx on public.lead_push_queue (created_at) where status = 'pendente';
alter table public.lead_push_queue enable row level security;

create function private.leads_app_link(p_query text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select value from private.leads_config where key = 'app_url'), '/leads/') || '?' || p_query;
$$;

-- Põe um aviso na fila para cada pessoa (com algum dispositivo ativo), exceto quem fez a ação.
create function private.leads_push(p_users uuid[], p_title text, p_body text, p_url text, p_tag text) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  insert into public.lead_push_queue (user_id, title, body, url, tag)
  select distinct u, left(p_title, 120), left(p_body, 240), p_url, p_tag
    from unnest(p_users) u
   where u is not null and u is distinct from auth.uid()
     and exists (select 1 from public.push_subscriptions s where s.user_id = u);
  get diagnostics v_count = row_count;
  -- Só chama a função de envio quando há mesmo alguém a avisar.
  if v_count > 0 then perform private.leads_notify_kick(); end if;
  return v_count;
end;
$$;

-- A função leads-notify reserva os avisos (sem dois envios do mesmo) e recebe os dispositivos de cada pessoa.
create function public.leads_push_claim(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ids bigint[];
begin
  delete from public.lead_push_queue where created_at < now() - interval '30 days';
  with picked as (
    select q.id from public.lead_push_queue q
     where q.status = 'pendente' order by q.id limit p_limit for update skip locked),
  upd as (
    update public.lead_push_queue q set status = 'enviado', sent_at = now()
      from picked where q.id = picked.id
    returning q.id)
  select array_agg(id) into v_ids from upd;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'title', q.title, 'body', q.body, 'url', q.url, 'tag', q.tag,
             'subs', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                        from public.push_subscriptions s where s.user_id = q.user_id)) order by q.id)
      from public.lead_push_queue q where q.id = any (v_ids)), '[]'::jsonb);
end;
$$;

-- Resultado: dispositivos que já não existem saem; os que receberam ficam com a hora; avisos sem nenhum envio ficam com erro.
create function public.leads_push_done(p_ok uuid[], p_gone uuid[], p_failed bigint[], p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions where id = any (coalesce(p_gone, '{}'));
  update public.push_subscriptions set last_used_at = now() where id = any (coalesce(p_ok, '{}'));
  update public.lead_push_queue set status = 'erro', error = left(p_error, 500) where id = any (coalesce(p_failed, '{}'));
end;
$$;

-- ============================================================ QUANDO AVISAR
-- Lead nova: no fim da transação, para saber se foi importada ou criada pelo cliente (esses têm outro caminho).
create function private.leads_push_new_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_client public.clients;
begin
  if new.anonymized then return null; end if;
  if exists (select 1 from public.lead_events e where e.lead_id = new.id
              and e.title in ('Lead importada de Excel', 'Lead importada do Pipedrive')) then return null; end if;
  if exists (select 1 from public.lead_notifications n where n.lead_id = new.id and n.kind = 'nova_lead_do_cliente') then return null; end if;
  select * into v_client from public.clients where id = new.client_id;
  perform private.leads_push(
    array(select r.id from private.leads_message_readers(new.client_id, 'opera') r where r.id is distinct from new.created_by),
    'Nova lead · ' || coalesce(nullif(new.name, ''), 'Sem nome'),
    concat_ws(' · ', v_client.name, nullif(new.source, ''), nullif(new.interest, '')),
    private.leads_app_link('lead=' || new.id), new.id::text);
  return null;
end;
$$;
create constraint trigger leads_push_new_lead after insert on public.leads
  deferrable initially deferred for each row execute function private.leads_push_new_lead();

-- Lead qualificada (ao cliente) e lead criada pelo cliente (à OPERA): os mesmos destinatários do email.
create function private.leads_push_notification() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lead public.leads; v_client public.clients; v_users uuid[];
begin
  select * into v_lead from public.leads where id = new.lead_id;
  if v_lead.anonymized then return null; end if;
  select * into v_client from public.clients where id = v_lead.client_id;
  if new.kind = 'qualificada' then
    v_users := coalesce(
      (select array_agg(p.id) from public.profiles p
        where p.id = v_lead.owner_user_id and p.leads_status = 'ativo' and p.client_id = v_lead.client_id),
      (select array_agg(p.id) from public.profiles p
        where p.client_id = v_lead.client_id and p.leads_status = 'ativo' and p.leads_role in ('cliente_admin', 'cliente')));
    perform private.leads_push(v_users, 'Lead qualificada · ' || v_lead.name,
      'A OPERA qualificou esta lead para ' || v_client.name || '. O contacto é vosso a partir de agora.',
      private.leads_app_link('lead=' || v_lead.id), v_lead.id::text);
  elsif new.kind = 'nova_lead_do_cliente' then
    perform private.leads_push(array(select r.id from private.leads_message_readers(v_lead.client_id, 'opera') r),
      v_client.name || ' criou uma lead · ' || v_lead.name, 'A lead está à espera do contacto da OPERA.',
      private.leads_app_link('lead=' || v_lead.id), v_lead.id::text);
  end if;
  return null;
end;
$$;
create trigger lead_notifications_push after insert on public.lead_notifications
  for each row execute function private.leads_push_notification();

-- Mensagem nova: a quem está do outro lado (as notificações da mesma conversa substituem-se umas às outras).
create function private.leads_push_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_side text; v_client public.clients; v_author text;
begin
  if new.deleted_at is not null then return null; end if;
  select * into v_client from public.clients where id = new.client_id;
  if not v_client.leads_enabled or v_client.leads_status <> 'ativo' then return null; end if;
  v_side := case private.leads_message_side(new.author_id) when 'opera' then 'cliente' else 'opera' end;
  select coalesce(nullif(full_name, ''), email) into v_author from public.profiles where id = new.author_id;
  perform private.leads_push(
    array(select r.id from private.leads_message_readers(new.client_id, v_side) r where r.id is distinct from new.author_id),
    case v_side when 'cliente' then 'Mensagem da OPERA' else 'Mensagem de ' || v_client.name end,
    concat_ws(': ', v_author, private.leads_message_text(new.body, new.audio_seconds)),
    private.leads_app_link('conversa=' || new.client_id), 'conversa-' || new.client_id);
  return null;
end;
$$;
create trigger client_messages_push after insert on public.client_messages
  for each row execute function private.leads_push_message();

-- ============================================================ PERMISSÕES
revoke execute on function public.leads_push_subscribe(text, text, text, text) from public, anon;
revoke execute on function public.leads_push_unsubscribe(text) from public, anon;
revoke execute on function public.leads_push_public_key() from public, anon;
grant execute on function public.leads_push_subscribe(text, text, text, text) to authenticated;
grant execute on function public.leads_push_unsubscribe(text) to authenticated;
grant execute on function public.leads_push_public_key() to authenticated;
revoke execute on function public.leads_push_keys(text, text) from public, anon, authenticated;
revoke execute on function public.leads_push_claim(integer) from public, anon, authenticated;
revoke execute on function public.leads_push_done(uuid[], uuid[], bigint[], text) from public, anon, authenticated;
grant execute on function public.leads_push_keys(text, text) to service_role;
grant execute on function public.leads_push_claim(integer) to service_role;
grant execute on function public.leads_push_done(uuid[], uuid[], bigint[], text) to service_role;
revoke execute on function private.leads_push(uuid[], text, text, text, text) from public, anon, authenticated;
revoke execute on function private.leads_app_link(text) from public, anon, authenticated;
