-- Ciclo de venda: passa a ler também as reuniões do histórico importado do Pipedrive (pedido do Fábio, 2026-11-12).
-- Motivo: leads como o João Marafuz foram importadas já em "Em decisão" e as reuniões (R1 a 27/08, R2 a 01/09)
-- só existem como atividades/notas importadas do Pipedrive, sem mudança de fase.
-- Primeira reunião de uma lead = a data mais antiga entre:
--   1. entrada em R1, R2 ou Em decisão no OPERA Leads;
--   2. primeira tarefa do tipo Reunião não cancelada;
--   3. histórico do Pipedrive: primeira atividade ou nota importada que começa por R1, R2 ou R3.
--      Se essa primeira marca for R2 ou R3 (a R1 não ficou marcada), conta a atividade importada mais antiga
--      até essa data, que é a R1 por registar.

create or replace function private.opera_primeira_reuniao(p_lead uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  with imp as (
    select e.created_at, e.created_at::date dia,
           upper(substring(coalesce(e.body, '') from '(?i)^[^a-z0-9]*(r[1-3])\M')) r
    from lead_events e
    where e.lead_id = p_lead and e.meta->>'via' = 'pipedrive' and e.type in ('call', 'note', 'auto')
  ),
  primeira_r as ( select * from imp where r is not null order by created_at limit 1 )
  select least(
    (select min(e.created_at::date) from lead_events e join lead_stages s on s.id = e.to_stage_id
      where e.lead_id = p_lead and e.type = 'stage' and s.name in ('R1', 'R2', 'Em decisão')),
    (select min((t.due_at at time zone 'Europe/Lisbon')::date) from lead_tasks t
      where t.lead_id = p_lead and t.type = 'meeting' and t.canceled_at is null),
    (select case when p.r = 'R1' then p.dia else (select min(i.dia) from imp i where i.created_at <= p.created_at) end from primeira_r p)
  )
$$;

revoke all on function private.opera_primeira_reuniao(uuid) from public, anon, authenticated;

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$cross join lateral ( select least((select min(e2.dia) from ev e2 where e2.lead_id = f.lead_id and e2.fase in ('R1','R2','Em decisão')), (select min((t.due_at at time zone 'Europe/Lisbon')::date) from lead_tasks t where t.lead_id = f.lead_id and t.type = 'meeting' and t.canceled_at is null)) dia ) s$a$;
  old2 constant text := $a$cross join lateral ( select least((select min(e.created_at::date) from lead_events e join lead_stages st on st.id = e.to_stage_id where e.lead_id = f.lead_id and e.type = 'stage' and st.name in ('R1','R2','Em decisão')), (select min((t.due_at at time zone 'Europe/Lisbon')::date) from lead_tasks t where t.lead_id = f.lead_id and t.type = 'meeting' and t.canceled_at is null)) dia ) s$a$;
  novo constant text := $a$cross join lateral ( select private.opera_primeira_reuniao(f.lead_id) dia ) s$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(replace(d, old1, novo), old2, novo);
  if length(d) - n <> 2 * length(novo) - length(old1) - length(old2) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
