-- OPERA Leads, ecrã "Hoje" (pedido do Fábio, 2026-11-18: "no Hoje, ainda hoje e amanhã a Ana não vê as suas tarefas").
-- A função devolvia no máximo 500 tarefas por ordem de data. Com mais de 500 atrasadas (553), o limite esgotava-se
-- nas atrasadas e as tarefas de hoje e de amanhã não chegavam ao ecrã.
-- Agora as atrasadas e as de hoje/amanhã têm cada uma o seu limite de 500.

create or replace function public.leads_today(p_client uuid default null::uuid, p_q text default null::text)
returns table(task_id uuid, task_type text, due_at timestamp with time zone, task_note text, lead_id uuid, lead_name text,
              phone text, interest text, client_name text, client_color text, stage_name text)
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_sel constant text := 'select t.id, t.type, t.due_at, t.note, l.id, l.name, l.phone, l.interest, c.name, c.color, s.name
       from public.lead_tasks t
       join public.leads l on l.id = t.lead_id
       join public.clients c on c.id = l.client_id
       join public.lead_stages s on s.id = l.stage_id
      where t.done_at is null and t.canceled_at is null and ';
  v_filter text := private.leads_filter_sql(p_client, null, p_q, false);
begin
  return query execute
    'select * from ((' || v_sel || 't.due_at < now() and ' || v_filter || ' order by t.due_at limit 500)
      union all (' || v_sel || 't.due_at >= now() and t.due_at < $6 and ' || v_filter || ' order by t.due_at limit 500)) x
      order by 3'
    using p_client, null::uuid, private.leads_like_escape(lower(trim(p_q))),
          regexp_replace(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '^351', ''), auth.uid(),
          (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '2 days') at time zone 'Europe/Lisbon';
end;
$function$;
