-- Funil comercial (R1, R2, conversões, lista e gráfico semanal) passa a ler também as reuniões
-- do histórico importado do Pipedrive (pedido do Fábio, 2026-11-12).
-- Antes só contavam as R1/R2 registadas como mudança de fase (a partir de 24/10), o que inflacionava
-- a conversão em períodos com fechos anteriores.
-- Regras do histórico do Pipedrive (só leads do cliente OPERA):
--   * atividade ou nota importada que começa por R1 conta como R1; por R2 ou R3 conta como R2;
--   * se a primeira marca de uma lead for R2 ou R3 (R1 por marcar), conta como R1 a atividade importada
--     mais antiga até essa data (mesma regra do ciclo de venda).

create or replace function private.opera_reunioes_pipedrive()
returns table (lead_id uuid, created_at timestamptz, fase text)
language sql
stable
security definer
set search_path = public
as $$
  with imp as (
    select e.lead_id, e.created_at,
           upper(substring(coalesce(e.body, '') from '(?i)^[^a-z0-9]*(r[1-3])\M')) r
    from lead_events e join leads l on l.id = e.lead_id
    where l.client_id in (select id from clients where leads_internal)
      and e.meta->>'via' = 'pipedrive' and e.type in ('call', 'note', 'auto')
  ),
  pri as ( select distinct on (imp.lead_id) imp.lead_id, imp.created_at, imp.r from imp where imp.r is not null order by imp.lead_id, imp.created_at )
  select imp.lead_id, imp.created_at, case when imp.r = 'R1' then 'R1' else 'R2' end from imp where imp.r is not null
  union all
  select p.lead_id, (select min(i.created_at) from imp i where i.lead_id = p.lead_id and i.created_at <= p.created_at), 'R1' from pri p where p.r <> 'R1'
$$;

revoke all on function private.opera_reunioes_pipedrive() from public, anon, authenticated;

do $do$
declare d text; n int; k1 int; k2 int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  -- periodo e funil_lista (texto igual nos dois)
  old1 constant text := $a$ev as ( select e.lead_id, e.created_at::date dia, s.name fase from lead_events e join leads l on l.id = e.lead_id join lead_stages s on s.id = e.to_stage_id where e.type = 'stage' and l.client_id in (select id from clients where leads_internal) )$a$;
  new1 constant text := $a$ev as ( select e.lead_id, e.created_at::date dia, s.name fase from lead_events e join leads l on l.id = e.lead_id join lead_stages s on s.id = e.to_stage_id where e.type = 'stage' and l.client_id in (select id from clients where leads_internal) union all select h.lead_id, h.created_at::date, h.fase from private.opera_reunioes_pipedrive() h )$a$;
  -- funil_semanal
  old2 constant text := $a$ev as ( select e.lead_id, e.created_at, s.name fase from lead_events e join leads l on l.id = e.lead_id join lead_stages s on s.id = e.to_stage_id where e.type = 'stage' and l.client_id in (select id from clients where leads_internal) )$a$;
  new2 constant text := $a$ev as ( select e.lead_id, e.created_at, s.name fase from lead_events e join leads l on l.id = e.lead_id join lead_stages s on s.id = e.to_stage_id where e.type = 'stage' and l.client_id in (select id from clients where leads_internal) union all select h.lead_id, h.created_at, h.fase from private.opera_reunioes_pipedrive() h )$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  k1 := (length(d) - length(replace(d, old1, ''))) / length(old1);
  k2 := (length(d) - length(replace(d, old2, ''))) / length(old2);
  if k1 <> 2 or k2 <> 1 then
    raise exception 'opera_admin_dados: ocorrências inesperadas (% e %)', k1, k2;
  end if;
  d := replace(replace(d, old1, new1), old2, new2);
  execute d;
end;
$do$;
