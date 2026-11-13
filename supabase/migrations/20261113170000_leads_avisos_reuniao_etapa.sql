-- OPERA Leads: emails aos admins sobre as leads da OPERA (pedido do Fábio, 2026-11-13).
-- * Reunião agendada = tarefa do tipo "Reunião" criada (ou mudada para Reunião) numa lead do cliente OPERA.
-- * Mudança de etapa: sempre que uma lead da OPERA entra em R1, R2 ou Closed (todas as vezes).
-- Usa a fila de avisos que já existe (lead_notifications + função leads-notify, que envia pelo Resend).

alter table public.lead_notifications add column if not exists task_id uuid references public.lead_tasks (id) on delete set null;
alter table public.lead_notifications add column if not exists event_id uuid references public.lead_events (id) on delete set null;
alter table public.lead_notifications drop constraint if exists lead_notifications_kind_check;
alter table public.lead_notifications add constraint lead_notifications_kind_check
  check (kind = any (array['qualificada', 'nova_lead_do_cliente', 'reuniao', 'etapa']));

-- Dados do aviso: junta a tarefa (dia, hora, nota, quem marcou) e, nas reuniões, os destinatários são os admins.
create or replace function private.leads_notification_payload(p_id bigint)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
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
    'task', (select jsonb_build_object('due_at', t.due_at, 'note', t.note, 'created_at', t.created_at,
                                       'by', (select pr.full_name from public.profiles pr where pr.id = t.created_by))
               from public.lead_tasks t where t.id = n.task_id),
    'stage_event', (select jsonb_build_object('at', e.created_at, 'to', ts.name, 'from', fs.name,
                                              'by', (select pr.full_name from public.profiles pr where pr.id = e.author_id))
                      from public.lead_events e left join public.lead_stages ts on ts.id = e.to_stage_id
                      left join public.lead_stages fs on fs.id = e.from_stage_id where e.id = n.event_id),
    'to', case
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
  join public.lead_stages s on s.id = l.stage_id
  where n.id = p_id;
$function$;

-- Reunião agendada numa lead da OPERA: põe o aviso na fila (o envio é automático).
create or replace function private.leads_meeting_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type <> 'meeting' or new.canceled_at is not null or new.done_at is not null then return null; end if;
  if tg_op = 'UPDATE' and old.type = 'meeting' then return null; end if;
  if not exists (select 1 from public.leads l join public.clients c on c.id = l.client_id
                  where l.id = new.lead_id and c.leads_internal and not l.anonymized) then return null; end if;
  insert into public.lead_notifications (lead_id, kind, task_id) values (new.lead_id, 'reuniao', new.id);
  return null;
end $$;
create trigger lead_tasks_meeting_notify after insert or update of type on public.lead_tasks
  for each row execute function private.leads_meeting_notify();

-- Lead da OPERA entra em R1, R2 ou Closed: aviso na fila (todas as vezes que acontece).
create or replace function private.leads_stage_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type <> 'stage' or new.to_stage_id is null then return null; end if;
  if not exists (select 1 from public.lead_stages s where s.id = new.to_stage_id and s.name in ('R1', 'R2', 'Closed')) then return null; end if;
  if not exists (select 1 from public.leads l join public.clients c on c.id = l.client_id
                  where l.id = new.lead_id and c.leads_internal and not l.anonymized) then return null; end if;
  insert into public.lead_notifications (lead_id, kind, event_id) values (new.lead_id, 'etapa', new.id);
  return null;
end $$;
create trigger lead_events_stage_notify after insert on public.lead_events
  for each row execute function private.leads_stage_notify();
