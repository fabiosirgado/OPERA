-- OPERA Leads, Fila: chamadas e follow ups com hora marcada vão para o topo da fila quando chega a hora, à frente das
-- leads novas (pedido do Fábio, 2026-11-20). O grupo continua a ser o 2 ("Hora marcada"); muda a ordem e o texto
-- distingue chamada de follow up.

create or replace function public.leads_fila(p_client uuid default null)
returns table (lead_id uuid, grupo text, grupo_ordem integer, ordem bigint, name text, phone text, interest text, source text,
               client_id uuid, client_name text, client_color text, stage_name text, attempts integer, sem_resposta integer,
               new_at timestamptz, next_task_at timestamptz, next_task_type text, motivo text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_end timestamptz := (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '1 day') at time zone 'Europe/Lisbon';
  v_week timestamptz := date_trunc('week', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_days numeric := least(5, extract(isodow from now() at time zone 'Europe/Lisbon'));
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  return query
  with clientes as (
    select c.id, c.name, c.color, coalesce(fc.leads_dia, 25) as leads_dia,
           (p_client is not null or coalesce(fc.ativa, true)) as auto
      from public.clients c
      left join public.lead_fila_clientes fc on fc.client_id = c.id
     where c.id in (select private.leads_active_client_ids())
       and not coalesce(c.leads_internal, false)
       and (case when p_client is not null then c.id = p_client
            else not exists (select 1 from public.lead_fila_exclusoes x where x.user_id = v_me and x.client_id = c.id)
             and (c.id in (select m.client_id from public.client_managers m where m.user_id = v_me)
                  or not exists (select 1 from public.client_managers m where m.user_id = v_me)) end)
  ),
  trab as (
    select l.client_id,
           count(distinct e.lead_id) filter (where e.created_at >= v_today) as hoje,
           count(distinct (e.lead_id, (e.created_at at time zone 'Europe/Lisbon')::date)) as semana
      from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.type = 'call' and e.created_at >= v_week and l.client_id in (select id from clientes)
     group by l.client_id
  ),
  ultimo as (
    select l.client_id from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.author_id = v_me and e.type = 'call' and e.created_at >= v_today and l.entry_stage = 'bd'
       and l.client_id in (select id from clientes)
     order by e.created_at desc limit 1
  ),
  rk as (
    select c.id,
           row_number() over (order by case when c.id = (select u.client_id from ultimo u) then 0 else 1 end,
                                       coalesce(t.semana, 0)::numeric / greatest(1, c.leads_dia * v_days), c.name) as rk,
           greatest(0, c.leads_dia - coalesce(t.hoje, 0)) as resta
      from clientes c left join trab t on t.client_id = c.id
  ),
  base as (
    select l.id, l.name, l.phone, l.interest, l.source, l.client_id, l.attempts, l.new_at, l.next_task_at, l.next_task_type,
           l.created_at, l.source_created_at, s.name as sname, s.key as skey,
           (s.key in ('meta', 'imoveis', 'bd') or (s.client_id is not null and s.position < 40)) as sbd,
           coalesce(f.sem_resposta, 0) as sr, f.escolhida_at, c.name as cname, c.color as ccolor, c.auto, r.rk, r.resta,
           (l.next_task_at at time zone 'Europe/Lisbon')::time = time '23:59:59' as dia_todo
      from public.leads l
      join clientes c on c.id = l.client_id
      join rk r on r.id = l.client_id
      join public.lead_stages s on s.id = l.stage_id
      left join public.lead_fila f on f.lead_id = l.id
     where not l.anonymized and s.position < 50 and f.aguarda_whatsapp_at is null
  ),
  nova as (
    select b.*, 1 as g,
           row_number() over (order by b.new_at asc) as o,
           'Entrou ' || to_char(b.new_at at time zone 'Europe/Lisbon', 'DD/MM "às" HH24:MI') as m
      from base b where b.new_at is not null
  ),
  marcada as (
    select b.*, 2 as g, row_number() over (order by b.next_task_at) as o,
           case b.next_task_type when 'call' then 'Chamada marcada' else 'Follow up marcado' end || ' para as '
             || to_char(b.next_task_at at time zone 'Europe/Lisbon', 'HH24:MI') as m
      from base b
     where b.new_at is null and b.next_task_type in ('call', 'followup') and not b.dia_todo
       and b.next_task_at <= now() and b.next_task_at > now() - interval '3 hours'
  ),
  fu as (
    select b.*, 4 as g,
           b.rk * 100000 + row_number() over (partition by b.client_id order by b.next_task_at nulls last, b.created_at) as o,
           case when b.next_task_at is null then 'Em Follow Up sem tarefa marcada'
                else (case b.next_task_type when 'call' then 'Chamada' else 'Follow up' end) || ' para '
                     || to_char(b.next_task_at at time zone 'Europe/Lisbon', case when b.dia_todo then 'DD/MM' else 'DD/MM HH24:MI' end) end as m
      from base b
     where b.auto and b.new_at is null
       and ((b.next_task_type in ('call', 'followup')
             and (b.next_task_at <= now() - interval '3 hours'
                  or (b.next_task_at <= now() and b.dia_todo)
                  or (b.dia_todo and b.next_task_at < v_end)))
            or (b.skey = 'followup' and b.next_task_at is null))
  ),
  bd as (
    select x.* from (
      select b.*, 5 as g,
             row_number() over (partition by b.client_id order by b.escolhida_at is null, b.escolhida_at, b.attempts,
                                coalesce(b.source_created_at, b.created_at) desc) as rn,
             case when b.escolhida_at is not null then 'Escolhida para a fila · ' else 'Recuperação · ' end
               || b.attempts || case when b.attempts = 1 then ' tentativa' else ' tentativas' end as m
        from base b
       where b.new_at is null and b.next_task_at is null
         and (b.escolhida_at is not null
              or (b.auto and b.sbd and b.attempts < 2 and b.sr < 2))
    ) x where x.rn <= x.resta
  ),
  tudo as (
    select n.id, n.g, n.o, n.m, n.name, n.phone, n.interest, n.source, n.client_id, n.cname, n.ccolor, n.sname, n.attempts, n.sr, n.new_at, n.next_task_at, n.next_task_type from nova n
    union all
    select k.id, k.g, k.o, k.m, k.name, k.phone, k.interest, k.source, k.client_id, k.cname, k.ccolor, k.sname, k.attempts, k.sr, k.new_at, k.next_task_at, k.next_task_type from marcada k
    union all
    select f.id, f.g, f.o, f.m, f.name, f.phone, f.interest, f.source, f.client_id, f.cname, f.ccolor, f.sname, f.attempts, f.sr, f.new_at, f.next_task_at, f.next_task_type from fu f
     where f.id not in (select k2.id from marcada k2)
    union all
    select d.id, d.g, d.rk * 100000 + d.rn, d.m, d.name, d.phone, d.interest, d.source, d.client_id, d.cname, d.ccolor, d.sname, d.attempts, d.sr, d.new_at, d.next_task_at, d.next_task_type from bd d
     where d.id not in (select f2.id from fu f2)
  )
  select t.id, case t.g when 1 then 'Lead nova' when 2 then 'Hora marcada' when 4 then 'Follow up' else 'BD' end,
         t.g, t.o, t.name, t.phone, t.interest, t.source, t.client_id, t.cname, t.ccolor, t.sname, t.attempts, t.sr,
         t.new_at, t.next_task_at, t.next_task_type, t.m
    from tudo t
   order by case t.g when 2 then 0 else t.g end, t.o
   limit 2000;
end;
$$;
revoke execute on function public.leads_fila(uuid) from public, anon;
grant execute on function public.leads_fila(uuid) to authenticated;
