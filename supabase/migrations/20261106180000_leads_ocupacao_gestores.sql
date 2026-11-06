-- OPERA Leads: ocupação dos gestores a partir das chamadas, dia a dia (pedido do Fábio, 2026-11-06). Só o admin vê.
--
-- Para cada gestor e cada dia (hora de Lisboa):
-- * ao telefone: soma do tempo total de cada chamada na CloudTalk (a chamar e em conversa), feitas e recebidas;
-- * tempo ativo: o tempo ao telefone mais os intervalos entre chamadas seguidas de até 10 minutos
--   (abrir a lead, ler a ficha, qualificar). Um intervalo de mais de 10 minutos é uma pausa e não conta
--   (o almoço de 1 hora fica assim de fora);
-- * ocupação: tempo ativo sobre um dia de trabalho de 8 horas (sem o almoço).
-- Cada chamada começa quando foi registada (created_at) e dura total_s (ou a conversa, se não houver total).
-- Fica de fora o histórico importado.

create or replace function public.leads_managers_activity(p_period text default '7', p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c_pause constant interval := interval '10 minutes';
  c_workday constant numeric := 8 * 3600;
  v_today date := (now() at time zone 'Europe/Lisbon')::date;
  v_d1 date; v_d2 date;
begin
  if not private.leads_is_admin() then raise exception 'Só o admin vê a ocupação dos gestores.'; end if;
  if p_period = 'custom' then
    if p_from is null or p_to is null or p_to < p_from then raise exception 'Escolha um período válido.'; end if;
    v_d1 := p_from; v_d2 := p_to;
  else
    v_d2 := v_today;
    v_d1 := case p_period when '1' then v_today when '7' then v_today - 6 when '30' then v_today - 29 else v_today - 364 end;
  end if;

  return (
    with c as (
      select e.author_id, (e.created_at at time zone 'Europe/Lisbon')::date as dia, e.created_at as ini,
             e.created_at + make_interval(secs => coalesce((e.meta ->> 'total_s')::numeric, (e.meta ->> 'duration_s')::numeric, 0)) as fim,
             coalesce((e.meta ->> 'total_s')::numeric, (e.meta ->> 'duration_s')::numeric, 0) as s,
             (e.meta ->> 'answered') = 'true' and coalesce((e.meta ->> 'duration_s')::numeric, 0) >= 10 as atendida,
             (e.meta ->> 'answered') = 'true' and coalesce((e.meta ->> 'duration_s')::numeric, 0) >= 60 as conversa
        from public.lead_events e join public.profiles p on p.id = e.author_id
       where e.type = 'call' and not (e.meta ? 'imported') and p.leads_role in ('admin', 'gestor')
         and e.created_at >= v_d1::timestamp at time zone 'Europe/Lisbon'
         and e.created_at < (v_d2 + 1)::timestamp at time zone 'Europe/Lisbon'
    ),
    g as (  -- intervalo desde o fim da chamada anterior do mesmo gestor, no mesmo dia
      select c.*, greatest(extract(epoch from (ini - max(fim) over (partition by author_id, dia order by ini
                                                     rows between unbounded preceding and 1 preceding))), 0) as gap
        from c
    ),
    d as (
      select author_id, dia, count(*) as chamadas, count(*) filter (where atendida) as atendidas,
             count(*) filter (where conversa) as conversas,
             min(ini) as primeira, max(fim) as ultima, sum(s) as phone_s,
             sum(s) + coalesce(sum(gap) filter (where gap <= extract(epoch from c_pause)), 0) as active_s,
             count(*) filter (where gap > extract(epoch from c_pause)) as pausas,
             coalesce(sum(gap) filter (where gap > extract(epoch from c_pause)), 0) as pausas_s
        from g group by author_id, dia
    )
    select jsonb_build_object(
      'from', v_d1, 'to', v_d2, 'pause_min', 10, 'workday_h', 8,
      'days', (select coalesce(jsonb_agg(jsonb_build_object(
                 'user_id', d.author_id, 'name', p.full_name, 'dia', d.dia, 'em_curso', d.dia = v_today,
                 'primeira', to_char(d.primeira at time zone 'Europe/Lisbon', 'HH24:MI'),
                 'ultima', to_char(d.ultima at time zone 'Europe/Lisbon', 'HH24:MI'),
                 'chamadas', d.chamadas, 'atendidas', d.atendidas, 'conversas', d.conversas,
                 'phone_s', round(d.phone_s), 'active_s', round(d.active_s), 'pausas', d.pausas, 'pausas_s', round(d.pausas_s),
                 'ocupacao', round(d.active_s / c_workday, 3)) order by p.full_name, d.dia desc), '[]'::jsonb)
                 from d join public.profiles p on p.id = d.author_id),
      'per_user', (select coalesce(jsonb_agg(jsonb_build_object(
                 'user_id', x.author_id, 'name', p.full_name, 'dias', x.dias, 'chamadas', x.chamadas, 'conversas', x.conversas,
                 'phone_s', round(x.phone_s), 'active_s', round(x.active_s),
                 'active_day_s', round(x.active_s / x.dias), 'phone_day_s', round(x.phone_s / x.dias),
                 'ocupacao', round(x.active_s / x.dias / c_workday, 3)) order by p.full_name), '[]'::jsonb)
                 -- O dia de hoje ainda não acabou: só entra nas médias se o período for só hoje.
                 from (select author_id, count(*) dias, sum(chamadas) chamadas, sum(conversas) conversas,
                              sum(phone_s) phone_s, sum(active_s) active_s from d
                        where d.dia < v_today or v_d1 = v_today group by author_id) x
                 join public.profiles p on p.id = x.author_id)
    )
  );
end;
$$;

revoke execute on function public.leads_managers_activity(text, date, date) from public, anon;
grant execute on function public.leads_managers_activity(text, date, date) to authenticated;
