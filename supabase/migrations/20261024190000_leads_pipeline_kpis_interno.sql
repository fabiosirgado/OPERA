-- Números do Pipeline geral: com "Todos os clientes", o cliente interno (OPERA) não conta.
-- Só conta quando é escolhido no filtro, como no dashboard.
create or replace function public.leads_pipeline_kpis(p_client uuid default null)
returns table(entraram_hoje bigint, por_contactar bigint, tarefas_atrasadas bigint, qualificadas bigint)
language plpgsql stable security definer set search_path = 'public' as $$
declare
  w text := private.leads_filter_sql(p_client, null, null, false)
    || ' and ($1 is not null or l.client_id not in (select c.id from public.clients c where c.leads_internal))';
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
begin
  return query execute
    'select count(*) filter (where l.created_at >= $9),
            count(*) filter (where s.key in (''meta'', ''imoveis'', ''bd'')),
            (select count(*) from public.lead_tasks t join public.leads l on l.id = t.lead_id
              where t.done_at is null and t.canceled_at is null and t.due_at < now() and ' || w || '),
            count(*) filter (where s.key = ''qualificada'')
       from public.leads l join public.lead_stages s on s.id = l.stage_id
      where ' || w
    using p_client, null::uuid, null::text, null::text, auth.uid(), null::uuid, 0, 0, v_today;
end;
$$;
revoke execute on function public.leads_pipeline_kpis(uuid) from public, anon;
