-- OPERA Leads, Fila: painéis laterais (pedido do Fábio, 2026-11-19).
--   leads_fila_clientes_resumo: por cliente, leads trabalhadas hoje e na semana contra as leads do dia, e se está na fila automática.
--   leads_fila_cliente_ativa: tira ou põe um cliente na fila automática.
--   leads_fila_etapas: quantas leads há em cada etapa base, nos clientes da fila.
-- "Trabalhada" conta como na leads_fila: uma lead com chamada registada, uma vez por dia.

create or replace function public.leads_fila_clientes_resumo()
returns table (client_id uuid, name text, color text, leads_dia integer, ativa boolean, hoje integer, semana integer, dias integer)
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_week timestamptz := date_trunc('week', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  return query
  with clientes as (
    select c.id, c.name, c.color, coalesce(fc.leads_dia, 25) as leads_dia, coalesce(fc.ativa, true) as ativa
      from public.clients c
      left join public.lead_fila_clientes fc on fc.client_id = c.id
     where c.id in (select private.leads_active_client_ids())
       and not coalesce(c.leads_internal, false)
       and not exists (select 1 from public.lead_fila_exclusoes x where x.user_id = v_me and x.client_id = c.id)
       and (c.id in (select m.client_id from public.client_managers m where m.user_id = v_me)
            or not exists (select 1 from public.client_managers m where m.user_id = v_me))
  ),
  trab as (
    select l.client_id,
           count(distinct e.lead_id) filter (where e.created_at >= v_today) as hoje,
           count(distinct (e.lead_id, (e.created_at at time zone 'Europe/Lisbon')::date)) as semana
      from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.type = 'call' and e.created_at >= v_week and l.client_id in (select id from clientes)
     group by l.client_id
  )
  select c.id, c.name, c.color, c.leads_dia, c.ativa, coalesce(t.hoje, 0)::integer, coalesce(t.semana, 0)::integer, 5
    from clientes c left join trab t on t.client_id = c.id
   order by c.ativa desc, c.name;
end;
$$;
revoke execute on function public.leads_fila_clientes_resumo() from public, anon;
grant execute on function public.leads_fila_clientes_resumo() to authenticated;

create or replace function public.leads_fila_cliente_ativa(p_client uuid, p_ativa boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  insert into public.lead_fila_clientes (client_id, ativa) values (p_client, p_ativa)
  on conflict (client_id) do update set ativa = excluded.ativa;
end;
$$;
revoke execute on function public.leads_fila_cliente_ativa(uuid, boolean) from public, anon;
grant execute on function public.leads_fila_cliente_ativa(uuid, boolean) to authenticated;

create or replace function public.leads_fila_etapas()
returns table (stage_id uuid, name text, color text, "position" numeric, n integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  return query
  select s.id, s.name, s.color, s.position::numeric,
         (select count(*) from public.leads l
           where l.stage_id = s.id and not l.anonymized
             and l.client_id in (select private.leads_active_client_ids())
             and l.client_id not in (select c.id from public.clients c where c.leads_internal))::integer
    from public.lead_stages s
   where s.client_id is null
   order by s.position;
end;
$$;
revoke execute on function public.leads_fila_etapas() from public, anon;
grant execute on function public.leads_fila_etapas() to authenticated;
