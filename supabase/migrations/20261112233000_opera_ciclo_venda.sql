-- Dashboard Admin, separador Comercial: ciclo de venda médio (pedido do Fábio, 2026-11-12).
-- Regras:
-- * Só leads do cliente OPERA com fecho no período. Fecho = primeira entrada em Closed, Em Onboarding ou Entrega de serviço
--   (a mesma regra dos cartões Fechos e Conversão).
-- * Início = primeira reunião registada: a data mais antiga entre a primeira entrada em R1, R2 ou Em decisão
--   e a data da primeira tarefa do tipo Reunião (não cancelada) dessa lead.
-- * Ciclo = dias entre o início e o fecho.
-- * Ficam de fora os fechos sem reunião registada e os que têm início no próprio dia do fecho ou depois
--   (lead registada já fechada, ex.: referências criadas no dia do fecho). Ficam contados em ciclo_excluidos.
-- * Mostra média, mediana e nº de fechos usados. A lista "ciclo" abre a partir do cartão.
-- Também: objetivo de conversão da Ana passa de 10% para 20% (reunião → fecho).

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$fecho as ( select lead_id, min(dia) dia from ev where fase in ('Closed','Em Onboarding','Entrega de serviço') group by 1 ), novos as ($a$;
  new1 constant text := $a$fecho as ( select lead_id, min(dia) dia from ev where fase in ('Closed','Em Onboarding','Entrega de serviço') group by 1 ), ciclo as ( select f.lead_id, s.dia inicio, f.dia fim, (f.dia - s.dia) dias from fecho f cross join lateral ( select least((select min(e2.dia) from ev e2 where e2.lead_id = f.lead_id and e2.fase in ('R1','R2','Em decisão')), (select min((t.due_at at time zone 'Europe/Lisbon')::date) from lead_tasks t where t.lead_id = f.lead_id and t.type = 'meeting' and t.canceled_at is null)) dia ) s, par where f.dia between par.i and par.f and s.dia < f.dia ), novos as ($a$;
  old2 constant text := $a$(select count(*) from fecho where dia between par.i and par.f)::int fechos,$a$;
  new2 constant text := $a$(select count(*) from fecho where dia between par.i and par.f)::int fechos, (select avg(dias) from ciclo)::float8 ciclo_medio_dias, (select percentile_cont(0.5) within group (order by dias) from ciclo)::float8 ciclo_mediano_dias, (select count(*) from ciclo)::int ciclo_n, ((select count(*) from fecho where dia between par.i and par.f) - (select count(*) from ciclo))::int ciclo_excluidos,$a$;
  old3 constant text := $a$
)
select lista, lead_id::text lead_id, cliente, dia::text dia, servico, valor::float8 valor, detalhe from x order by lista, dia desc nulls last, cliente$q$$a$;
  new3 constant text := $a$
  union all select 'ciclo', l.id, l.name, c.fim, (select oc.servico from opera_contratos oc where oc.lead_id = c.lead_id and oc.estado <> 'cancelado' order by oc.created_at desc limit 1), null::numeric, c.dias || case when c.dias = 1 then ' dia' else ' dias' end || ' · 1.ª reunião a ' || to_char(c.inicio, 'DD/MM') from ( select f.lead_id, s.dia inicio, f.dia fim, f.dia - s.dia dias from ( select e.lead_id, min(e.created_at::date) dia from lead_events e join lead_stages st on st.id = e.to_stage_id join leads l2 on l2.id = e.lead_id where e.type = 'stage' and st.name in ('Closed','Em Onboarding','Entrega de serviço') and l2.client_id in (select id from clients where leads_internal) group by 1 ) f cross join lateral ( select least((select min(e.created_at::date) from lead_events e join lead_stages st on st.id = e.to_stage_id where e.lead_id = f.lead_id and e.type = 'stage' and st.name in ('R1','R2','Em decisão')), (select min((t.due_at at time zone 'Europe/Lisbon')::date) from lead_tasks t where t.lead_id = f.lead_id and t.type = 'meeting' and t.canceled_at is null)) dia ) s, par where f.dia between par.i and par.f and s.dia < f.dia ) c join leads l on l.id = c.lead_id
)
select lista, lead_id::text lead_id, cliente, dia::text dia, servico, valor::float8 valor, detalhe from x order by lista, dia desc nulls last, cliente$q$$a$;
  old4 constant text := $a$0.10::float8 obj_conversao$a$;
  new4 constant text := $a$0.20::float8 obj_conversao$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(replace(replace(replace(d, old1, new1), old2, new2), old3, new3), old4, new4);
  if length(d) - n <> length(new1) - length(old1) + length(new2) - length(old2) + length(new3) - length(old3) + length(new4) - length(old4) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
