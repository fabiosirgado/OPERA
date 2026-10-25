-- OPERA Leads: sinal "Nova" nas leads que entraram por uma entrada automática (Meta, portais) e em que
-- ainda ninguém pegou. Deixa de aparecer na primeira chamada ou contacto, ou quando a lead sai das etapas
-- de entrada. As leads criadas à mão ou importadas nunca o têm.
drop function public.leads_pipeline(uuid, uuid, uuid, text, boolean, text, integer, integer, integer);
create function public.leads_pipeline(
  p_client uuid default null, p_stage uuid default null, p_label uuid default null, p_q text default null,
  p_mine boolean default false, p_sort text default 'next', p_dir integer default 1,
  p_offset integer default 0, p_limit integer default 50)
returns table (id uuid, client_id uuid, client_name text, client_color text, name text, phone text, email text,
               source text, interest text, stage_id uuid, stage_name text, attempts integer, created_at timestamptz,
               last_contact_at timestamptz, next_task_at timestamptz, next_task_type text, owner_name text,
               label_ids uuid[], pinned_note text, anonymized boolean, is_new boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  d text := case when p_dir = -1 then 'desc' else 'asc' end;
  ord text;
begin
  -- Só ordenações conhecidas; nunca texto vindo de fora.
  ord := case p_sort
    when 'next' then 'l.next_task_at asc nulls last'
    when 'recent' then 'l.created_at desc'
    when 'old' then 'l.created_at asc'
    when 'stale' then 'l.last_contact_at asc nulls first'
    when 'name' then 'l.name ' || d
    when 'client' then 'c.name ' || d || ', l.name'
    when 'source' then 'l.source ' || d || ' nulls last'
    when 'created' then 'l.created_at ' || d
    when 'last' then 'l.last_contact_at ' || d || case when d = 'asc' then ' nulls first' else ' nulls last' end
    when 'attempts' then 'l.attempts ' || d
    when 'stage' then 's.position ' || d
    when 'nextlist' then 'l.next_task_at ' || d || ' nulls last'
    else 'l.created_at desc' end;

  return query execute
    'select l.id, l.client_id, c.name, c.color, l.name, l.phone, l.email, l.source, l.interest, l.stage_id, s.name,
            l.attempts, l.created_at, l.last_contact_at, l.next_task_at, l.next_task_type,
            (select p.full_name from public.profiles p where p.id = l.owner_user_id),
            coalesce((select array_agg(k.label_id) from public.lead_label_links k where k.lead_id = l.id), ''{}''),
            (select e.body from public.lead_events e where e.lead_id = l.id and e.pinned order by e.created_at desc limit 1),
            l.anonymized,
            (l.created_by is null and not l.imported and l.attempts = 0 and l.last_contact_at is null and s.position < 50)
       from public.leads l
       join public.clients c on c.id = l.client_id
       join public.lead_stages s on s.id = l.stage_id
      where ' || private.leads_filter_sql(p_client, p_label, p_q, p_mine)
      || case when p_stage is not null then ' and l.stage_id = $6' else '' end
      || ' order by ' || ord || ', l.id offset $7 limit $8'
    using p_client, p_label, private.leads_like_escape(lower(trim(p_q))), regexp_replace(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '^351', ''),
          auth.uid(), p_stage, greatest(p_offset, 0), least(greatest(p_limit, 1), 200);
end;
$$;
revoke execute on function public.leads_pipeline(uuid, uuid, uuid, text, boolean, text, integer, integer, integer) from public, anon;
