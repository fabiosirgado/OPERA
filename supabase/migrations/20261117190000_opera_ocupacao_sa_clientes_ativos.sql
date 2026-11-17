-- Dashboard Admin, "Ocupação OPERA SA" (pedido do Fábio, 2026-11-17: "conta os clientes ativos SA, é simples").
-- Antes: todos os clientes do Leads (incluindo desativados e em onboarding), no mínimo 1 slot cada e mais
-- conforme as chamadas por dia. Agora: cada cliente SA ativo ocupa 1 slot. Cliente SA ativo = mesmo critério
-- do cartão "Clientes ativos hoje" (contrato SA ou Bundle ativo, em Entrega de serviço, a decorrer hoje).

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$with carga as ( select c.id, greatest(1, coalesce((select count(distinct (e.lead_id, e.created_at::date))::float8 / greatest(count(distinct e.created_at::date),1) from lead_events e join leads l on l.id = e.lead_id where e.type = 'call' and e.created_at >= now() - interval '30 days' and l.client_id = c.id),0) / 25) slots from clients c where c.leads_enabled and not c.leads_internal ),$a$;
  new1 constant text := $a$with carga as ( select distinct lower(cliente) id, 1::float8 slots from opera_contratos_metricas where estado = 'ativo' and servico in ('SA','BUNDLE') and current_date between data_inicio and fim_previsto ),$a$;
begin
  d := pg_get_functiondef(sig);
  if (length(d) - length(replace(d, old1, ''))) / length(old1) <> 1 then
    raise exception 'opera_admin_dados: ponto de alteração não encontrado (ou repetido)';
  end if;
  n := length(d);
  d := replace(d, old1, new1);
  if length(d) - n <> length(new1) - length(old1) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
