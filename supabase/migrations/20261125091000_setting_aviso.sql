-- OPERA Leads, Setting B2B: o aviso por email ao cliente leva o nome da etapa do cliente (Reunião Agendada em vez de
-- Lead Qualificada), os dados da reunião e os campos de qualificação do cliente. Para clientes de imobiliário o
-- conteúdo é o mesmo de antes (só se juntam chaves novas, que o email de imobiliário não usa).
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
    'task', (select jsonb_build_object('due_at', t.due_at, 'note', t.note, 'created_at', t.created_at,
                                       'by', (select pr.full_name from public.profiles pr where pr.id = t.created_by))
               from public.lead_tasks t where t.id = n.task_id),
    'stage_event', (select jsonb_build_object('at', e.created_at,
                                              'to', private.leads_stage_label(e.to_stage_id, l.client_id),
                                              'from', private.leads_stage_label(e.from_stage_id, l.client_id),
                                              'by', (select pr.full_name from public.profiles pr where pr.id = e.author_id))
                      from public.lead_events e where e.id = n.event_id),
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
  where n.id = p_id;
$function$;
