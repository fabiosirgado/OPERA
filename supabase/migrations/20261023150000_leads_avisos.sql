-- OPERA Leads, Fase 7: avisos por email (Resend, UE). A fila lead_notifications já existia desde a Fase 2.
--
-- Avisos:
--   qualificada           ao cliente: o responsável da lead ou, sem responsável, todos os utilizadores ativos
--                         do cliente. As respostas vão para o gestor do cliente.
--   nova_lead_do_cliente  à OPERA: o gestor do cliente (ou os admins, se não houver gestor).
-- Envio: quando entra um aviso na fila, a base de dados pede à função leads-notify que envie (pg_net, sem
-- esperar pela resposta). De 5 em 5 minutos volta a pedir, para os que falharam (até 5 tentativas).
-- As leads importadas (por exemplo do Pipedrive) entram diretamente na etapa e não geram avisos.

-- Configuração de cada ambiente (não é segredo): endereço das funções e da aplicação, para os links dos emails.
create table private.leads_config (key text primary key, value text not null);
comment on table private.leads_config is
  'functions_url: https://<projeto>.supabase.co/functions/v1 ; app_url: endereço da aplicação (ex.: https://opera-os.com/leads/) ; '
  'email_redirect_to: só no ambiente de testes, todos os emails vão para este endereço em vez dos destinatários reais';

alter table public.lead_notifications
  add column attempts integer not null default 0,
  add column next_attempt_at timestamptz not null default now(),
  add column recipients text[],
  add column provider_id text;

-- ============================================================ CONTEÚDO DE UM AVISO
create function private.leads_notification_payload(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', n.id, 'kind', n.kind, 'channel', n.channel, 'attempts', n.attempts,
    'app_url', (select value from private.leads_config where key = 'app_url'),
    'redirect_to', (select value from private.leads_config where key = 'email_redirect_to'),
    'lead', jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source,
                               'interest', l.interest, 'qualification', l.qualification, 'created_at', l.created_at,
                               'stage', s.name),
    'client', c.name,
    'manager', (select jsonb_build_object('name', m.full_name, 'email', m.email) from public.profiles m where m.id = c.manager_id),
    'pinned', (select coalesce(jsonb_agg(e.body order by e.created_at), '[]'::jsonb) from public.lead_events e
                where e.lead_id = l.id and e.pinned and e.type = 'note' and coalesce(e.body, '') <> ''),
    'to', case
      when n.kind = 'qualificada' then coalesce(
        (select jsonb_agg(p.email) from public.profiles p
          where p.id = l.owner_user_id and p.leads_status = 'ativo' and p.client_id = l.client_id and p.email is not null),
        (select jsonb_agg(p.email order by p.email) from public.profiles p
          where p.client_id = l.client_id and p.leads_status = 'ativo' and p.leads_role in ('cliente_admin', 'cliente')
            and p.email is not null),
        '[]'::jsonb)
      else coalesce(
        (select jsonb_agg(m.email) from public.profiles m where m.id = c.manager_id and m.leads_status = 'ativo' and m.email is not null),
        (select jsonb_agg(p.email order by p.email) from public.profiles p
          where p.leads_role = 'admin' and p.leads_status = 'ativo' and p.email is not null),
        '[]'::jsonb)
    end)
  from public.lead_notifications n
  join public.leads l on l.id = n.lead_id
  join public.clients c on c.id = l.client_id
  join public.lead_stages s on s.id = l.stage_id
  where n.id = p_id;
$$;

-- A função leads-notify reserva os avisos a enviar (sem dois envios ao mesmo tempo) e recebe o conteúdo.
create function public.leads_notifications_claim(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ids bigint[];
begin
  with c as (
    select n.id from public.lead_notifications n
     where n.status = 'pendente' and n.channel = 'email' and n.next_attempt_at <= now()
     order by n.created_at limit greatest(1, least(p_limit, 100))
     for update skip locked),
  u as (
    update public.lead_notifications n
       set attempts = n.attempts + 1,
           next_attempt_at = now() + make_interval(mins => 5 * power(2, n.attempts)::int)
      from c where n.id = c.id
    returning n.id)
  select array_agg(id) into v_ids from u;
  return coalesce((select jsonb_agg(private.leads_notification_payload(id) order by id) from unnest(v_ids) id), '[]'::jsonb);
end;
$$;

-- Resultado do envio. Depois de 5 tentativas falhadas, o aviso fica em erro e a lead regista-o.
create function public.leads_notification_done(p_id bigint, p_ok boolean, p_error text default null,
                                               p_provider_id text default null, p_recipients text[] default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_n public.lead_notifications;
begin
  select * into v_n from public.lead_notifications where id = p_id for update;
  if v_n.id is null then return; end if;
  if p_ok then
    update public.lead_notifications set status = 'enviado', sent_at = now(), error = null,
           provider_id = p_provider_id, recipients = p_recipients where id = p_id;
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (v_n.lead_id, 'auto',
            case when v_n.kind = 'qualificada' then 'Cliente avisado por email' else 'Gestor avisado por email' end,
            'Para: ' || array_to_string(p_recipients, ', '), null);
  elsif v_n.attempts >= 5 or p_error = 'Sem destinatários.' then
    update public.lead_notifications set status = 'erro', error = left(p_error, 500), recipients = p_recipients where id = p_id;
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (v_n.lead_id, 'auto', 'O email de aviso não foi enviado', left(p_error, 300), null);
  else
    update public.lead_notifications set error = left(p_error, 500) where id = p_id;
  end if;
end;
$$;

create function public.leads_notification_preview(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select private.leads_notification_payload(p_id);
$$;

revoke execute on function public.leads_notifications_claim(integer) from public, anon, authenticated;
revoke execute on function public.leads_notification_done(bigint, boolean, text, text, text[]) from public, anon, authenticated;
revoke execute on function public.leads_notification_preview(bigint) from public, anon, authenticated;
grant execute on function public.leads_notifications_claim(integer) to service_role;
grant execute on function public.leads_notification_done(bigint, boolean, text, text, text[]) to service_role;
grant execute on function public.leads_notification_preview(bigint) to service_role;

-- ============================================================ PEDIR O ENVIO
-- A chave é a mesma das entradas automáticas (Vault). Sem configuração neste ambiente, não faz nada.
create function private.leads_notify_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text;
begin
  select value into v_url from private.leads_config where key = 'functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'leads_inbound_secret';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := v_url || '/leads-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-opera-secret', v_key),
    body := '{"action": "process"}'::jsonb,
    timeout_milliseconds := 30000);
end;
$$;

create function private.leads_notifications_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.leads_notify_kick();
  return null;
end;
$$;
create trigger leads_notifications_after_insert after insert on public.lead_notifications
  for each statement execute function private.leads_notifications_after_insert();

select cron.schedule('leads-avisos', '*/5 * * * *', $$
  select private.leads_notify_kick()
   where exists (select 1 from public.lead_notifications where status = 'pendente' and channel = 'email' and next_attempt_at <= now())
$$);
