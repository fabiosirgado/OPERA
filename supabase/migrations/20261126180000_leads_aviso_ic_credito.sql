-- OPERA Leads: aviso por email ao intermediário de crédito (IC) do cliente.
--   * cada cliente pode ter um ou mais emails de IC (clients.ic_emails), guardados pela equipa OPERA em Clientes e acessos;
--   * quando uma lead fica em Lead Qualificada com Crédito no Objetivo, sai um email para o IC com o contacto,
--     a qualificação, as notas afixadas e o resumo da última chamada (aviso do tipo "credito");
--   * sem IC definido não sai nada. O aviso normal de lead qualificada ao cliente não muda.

alter table public.clients add column if not exists ic_emails text[] not null default '{}';
comment on column public.clients.ic_emails is
  'Emails do intermediário de crédito (IC) do cliente. Recebem um aviso quando uma lead em Lead Qualificada tem Crédito no Objetivo. Vazio: não sai aviso.';

alter table public.lead_notifications drop constraint if exists lead_notifications_kind_check;
alter table public.lead_notifications add constraint lead_notifications_kind_check
  check (kind = any (array['qualificada'::text, 'nova_lead_do_cliente'::text, 'reuniao'::text, 'etapa'::text, 'credito'::text]));

-- Dispara quando a lead passa a estar em Lead Qualificada com Crédito no Objetivo, venha a mudança da etapa ou do Objetivo.
-- Uma só vez por lead, só quando quem mexe é a OPERA (ou o sistema), e só para clientes com IC definido.
create or replace function private.leads_credito_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_key text; v_from numeric;
begin
  if new.anonymized then return null; end if;
  if new.stage_id is not distinct from old.stage_id and new.qualification is not distinct from old.qualification then return null; end if;
  select key into v_key from public.lead_stages where id = new.stage_id;
  if v_key is distinct from 'qualificada' then return null; end if;
  if not ('Crédito' = any (private.leads_objetivo_tipos(new.qualification ->> 'Objetivo'))) then return null; end if;

  if new.stage_id is distinct from old.stage_id then
    -- Entrou em Lead Qualificada: só conta vinda de uma etapa anterior (não quando o cliente a devolve).
    select position into v_from from public.lead_stages where id = old.stage_id;
    if coalesce(v_from, 0) >= 50 then return null; end if;
  elsif 'Crédito' = any (private.leads_objetivo_tipos(old.qualification ->> 'Objetivo')) then
    -- Já estava qualificada com Crédito: nada de novo.
    return null;
  end if;

  if not (auth.uid() is null or private.leads_is_opera()) then return null; end if;
  if not exists (select 1 from public.clients c
                  where c.id = new.client_id and cardinality(c.ic_emails) > 0
                    and c.leads_status = 'ativo' and coalesce(c.leads_enabled, false)
                    and not coalesce(c.leads_internal, false)
                    and c.service_type is distinct from 'setting') then return null; end if;
  if exists (select 1 from public.lead_notifications n
              where n.lead_id = new.id and n.kind = 'credito' and n.status in ('pendente', 'enviado')) then return null; end if;

  insert into public.lead_notifications (lead_id, kind) values (new.id, 'credito');
  insert into public.lead_events (lead_id, type, title, body, author_id)
  values (new.id, 'auto', 'Intermediário de crédito vai ser avisado',
          'O contacto e o contexto da lead seguem por email para o intermediário de crédito do cliente.',
          auth.uid());
  return null;
end $function$;

revoke all on function private.leads_credito_notify() from public;

drop trigger if exists leads_credito_notify on public.leads;
create trigger leads_credito_notify after update of stage_id, qualification on public.leads
  for each row execute function private.leads_credito_notify();

-- Dados do aviso: destinatários do IC e resumo da última chamada.
create or replace function private.leads_notification_payload(p_id bigint)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', n.id, 'kind', n.kind, 'channel', n.channel, 'attempts', n.attempts,
    'app_url', (select value from private.leads_config where key = 'app_url'),
    'redirect_to', (select value from private.leads_config where key = 'email_redirect_to'),
    'lead', jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source,
                               'interest', l.interest, 'qualification', l.qualification, 'created_at', l.created_at,
                               'stage', private.leads_stage_label(l.stage_id, l.client_id),
                               'meeting_at', l.meeting_at, 'meeting_with', l.meeting_with, 'meeting_link', l.meeting_link,
                               'reschedules', l.reschedules),
    'client', c.name,
    'setting', c.service_type = 'setting',
    'qual_fields', (select coalesce(jsonb_agg(f ->> 'key'), '[]'::jsonb) from jsonb_array_elements(coalesce(c.qual_fields, '[]'::jsonb)) f),
    'manager', (select jsonb_build_object('name', m.full_name, 'email', m.email) from public.profiles m where m.id = c.manager_id),
    'pinned', (select coalesce(jsonb_agg(e.body order by e.created_at), '[]'::jsonb) from public.lead_events e
                where e.lead_id = l.id and e.pinned and e.type = 'note' and coalesce(e.body, '') <> ''),
    'last_call', case when n.kind = 'credito' then
                   (select jsonb_build_object('summary', left(i.ci ->> 'summary', 1500), 'at', i.updated_at)
                      from public.lead_call_insights i
                     where i.lead_id = l.id and coalesce(i.ci ->> 'summary', '') <> ''
                     order by i.updated_at desc limit 1) end,
    'task', (select jsonb_build_object('due_at', t.due_at, 'note', t.note, 'created_at', t.created_at,
                                       'by', (select pr.full_name from public.profiles pr where pr.id = t.created_by))
               from public.lead_tasks t where t.id = n.task_id),
    'stage_event', (select jsonb_build_object('at', e.created_at,
                                              'to', private.leads_stage_label(e.to_stage_id, l.client_id),
                                              'from', private.leads_stage_label(e.from_stage_id, l.client_id),
                                              'by', (select pr.full_name from public.profiles pr where pr.id = e.author_id))
                      from public.lead_events e where e.id = n.event_id),
    'to', case
      when n.kind = 'credito' then to_jsonb(coalesce(c.ic_emails, '{}'::text[]))
      when n.kind = 'qualificada' then coalesce(
        (select jsonb_agg(p.email) from public.profiles p
          where p.id = l.owner_user_id and p.leads_status = 'ativo' and p.client_id = l.client_id and p.email is not null),
        (select jsonb_agg(p.email order by p.email) from public.profiles p
          where p.client_id = l.client_id and p.leads_status = 'ativo' and p.leads_role in ('cliente_admin', 'cliente')
            and p.email is not null),
        '[]'::jsonb)
      when n.kind in ('reuniao', 'etapa') then coalesce(
        (select jsonb_agg(p.email order by p.email) from public.profiles p
          where p.leads_role = 'admin' and p.leads_status = 'ativo' and p.email is not null),
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
  where n.id = p_id;
$function$;

-- Registo na ficha da lead: título próprio para o aviso ao IC.
create or replace function public.leads_notification_done(p_id bigint, p_ok boolean, p_error text default null::text, p_provider_id text default null::text, p_recipients text[] default null::text[])
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_n public.lead_notifications;
begin
  select * into v_n from public.lead_notifications where id = p_id for update;
  if v_n.id is null then return; end if;
  if p_ok then
    update public.lead_notifications set status = 'enviado', sent_at = now(), error = null,
           provider_id = p_provider_id, recipients = p_recipients where id = p_id;
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (v_n.lead_id, 'auto',
            case when v_n.kind = 'qualificada' then 'Cliente avisado por email'
                 when v_n.kind = 'credito' then 'Intermediário de crédito avisado por email'
                 else 'Gestor avisado por email' end,
            'Para: ' || array_to_string(p_recipients, ', '), null);
  elsif v_n.attempts >= 5 or p_error = 'Sem destinatários.' then
    update public.lead_notifications set status = 'erro', error = left(p_error, 500), recipients = p_recipients where id = p_id;
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (v_n.lead_id, 'auto', 'O email de aviso não foi enviado', left(p_error, 300), null);
  else
    update public.lead_notifications set error = left(p_error, 500) where id = p_id;
  end if;
end;
$function$;

-- Guardar os emails do IC de um cliente, a partir do ecrã Clientes e acessos. Só a equipa OPERA.
create or replace function public.leads_cliente_ic_guardar(p_client uuid, p_emails text[])
returns text[] language plpgsql security definer set search_path = '' as $$
declare v text[]; e text;
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA pode mudar o intermediário de crédito do cliente.'; end if;
  select coalesce(array_agg(distinct s.x), array[]::text[]) into v
    from (select lower(btrim(u)) as x from unnest(coalesce(p_emails, array[]::text[])) u) s where s.x <> '';
  if cardinality(v) > 5 then raise exception 'No máximo 5 emails de intermediário de crédito.'; end if;
  foreach e in array v loop
    if char_length(e) > 254 or e !~ '^[^@[:space:],;]+@[^@[:space:],;]+\.[^@[:space:],;]+$' then
      raise exception 'Email inválido: %', e;
    end if;
  end loop;
  update public.clients set ic_emails = v where id = p_client;
  if not found then raise exception 'Cliente não encontrado.'; end if;
  return v;
end $$;

revoke all on function public.leads_cliente_ic_guardar(uuid, text[]) from public, anon;
grant execute on function public.leads_cliente_ic_guardar(uuid, text[]) to authenticated;
