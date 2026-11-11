-- Dashboard Admin: clicar num cartão mostra os clientes que estão por trás do número (pedido do Fábio, 2026-11-11).
-- Novas listas em opera_admin_dados:
-- * cartoes_lista (acesso total): vendas novas, PIF, bundle, MRR novo, renovações, clientes ativos (início, fim e hoje),
--   clientes perdidos, faturação, caixa, por receber e pagamentos vencidos. Mesmas regras dos números dos cartões.
-- * ana_lista (também para o acesso comercial): fechos e R1 da Ana no período de comissão atual.

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$    'ana_bonus', private.opera_j($q$$a$;
  new1 constant text := $a$    'ana_lista', private.opera_j($q$
with per as ( select g::date fim from generate_series(date '2026-11-25', (date_trunc('month', current_date) + interval '3 months 24 days')::date, interval '1 month') g ),
p as ( select fim, greatest((fim - interval '1 month' + interval '1 day')::date, date '2026-11-09') inicio from per ),
a as ( select * from p where current_date between inicio and fim ),
ana as ( select user_id id from opera_admin_acessos where vendedor ilike 'Ana%' ),
vend as ( select c.*, case when c.modalidade = 3 and opera_preco_tabela(c.servico,1) is not null and c.valor_total > opera_preco_tabela(c.servico,1) * c.duracao_meses / 3 then opera_preco_tabela(c.servico,1) * c.duracao_meses / 3 else c.valor_total end valor_integral from opera_contratos c where c.estado <> 'cancelado' and c.vendedor ilike 'Ana%' and c.tipo_venda in ('nova','cross_sell') ),
r1 as ( select e.lead_id, min(e.created_at::date) dia from lead_events e join lead_stages s on s.id = e.to_stage_id join leads l on l.id = e.lead_id, a where e.type = 'stage' and s.name = 'R1' and e.author_id in (select id from ana) and l.client_id in (select id from clients where leads_internal) and e.created_at::date between a.inicio and a.fim group by 1 ),
x as (
  select 'ana_fechos' lista, v.lead_id, v.cliente, v.data_fecho dia, v.servico, v.valor_integral valor, case when v.modalidade = 1 then 'PIF' when v.modalidade > 1 then v.modalidade || ' prestações' else 'prestações por definir' end || ' · ao preço integral' detalhe from vend v, a where v.data_fecho between a.inicio and a.fim
  union all select 'ana_r1', l.id, l.name, r1.dia, null, null, 'fase atual: ' || coalesce(s.name, '?') from r1 join leads l on l.id = r1.lead_id left join lead_stages s on s.id = l.stage_id
)
select lista, lead_id::text lead_id, cliente, dia::text dia, servico, valor::float8 valor, detalhe from x order by lista, dia desc nulls last, cliente
$q$),
    'ana_bonus', private.opera_j($q$$a$;
  old2 constant text := $a$  out := out || jsonb_build_object('unit_servico',$a$;
  new2 constant text := $a$  out := out || jsonb_build_object('cartoes_lista', private.opera_j('with ' || par || $q$
, ct as ( select c.*, c.fim_previsto fim_real, case when not c.servico_unico then c.valor_total / c.duracao_meses end mensal from opera_contratos_metricas c where c.estado in ('ativo','terminado') and c.valor_total is not null ),
hoje as ( select c.*, case when not c.servico_unico then c.valor_total / c.duracao_meses end mensal from opera_contratos_metricas c where c.estado = 'ativo' and current_date between c.data_inicio and c.fim_previsto ),
novos as ( select c.*, case when c.modalidade = 1 then 'PIF' when c.modalidade > 1 then c.modalidade || ' prestações' else 'prestações por definir' end || coalesce(' · vendedor ' || c.vendedor, '') det from opera_contratos c, par where c.origem in ('automatico','manual') and c.estado <> 'cancelado' and c.data_fecho between par.i and par.f ),
pg as ( select p.*, c.cliente, c.lead_id, c.servico, c.modalidade, case when c.modalidade = 1 then 'PIF' else 'prestação ' || p.numero || ' de ' || coalesce(c.modalidade::text, '?') end || case when p.estado = 'pago' then ' · paga' when p.data_prevista < current_date then ' · vencida' else ' · por receber' end det from opera_pagamentos p join opera_contratos c on c.id = p.contrato_id where p.estado <> 'cancelado' and c.estado <> 'cancelado' ),
x as (
  select 'novos' lista, lead_id, cliente, data_fecho dia, servico, valor_total valor, det detalhe from novos
  union all select 'novos_pif', lead_id, cliente, data_fecho, servico, valor_total, det from novos where modalidade = 1
  union all select 'novos_bundle', lead_id, cliente, data_fecho, servico, valor_total, det from novos where servico = 'BUNDLE'
  union all select 'mrr_novo', lead_id, cliente, data_fecho, servico, valor_total / duracao_meses, 'por mês · ' || det from novos where valor_total is not null and not servico_unico
  union all select 'renovacoes', lead_id, cliente, data_inicio, servico, valor_total, 'renovação' || coalesce(' · vendedor ' || vendedor, '') from opera_contratos, par where origem = 'renovacao' and estado <> 'cancelado' and data_inicio between par.i and par.f
  union all select 'ativos_inicio', lead_id, cliente, data_inicio, servico, mensal, case when fim_real >= date '2099-01-01' then 'por mês · sem data de fim' else 'por mês · até ' || to_char(fim_real, 'DD/MM/YYYY') end from ct, par where data_inicio <= par.i and fim_real >= par.i
  union all select 'ativos_fim', lead_id, cliente, data_inicio, servico, mensal, case when fim_real >= date '2099-01-01' then 'por mês · sem data de fim' else 'por mês · até ' || to_char(fim_real, 'DD/MM/YYYY') end from ct, par where data_inicio <= par.f and fim_real >= par.f
  union all select 'perdidos', lead_id, cliente, fim_real, servico, mensal, 'por mês · terminou' || case when renovacao = 'nao_renovou' then ', não renovou' else '' end from ct, par where fim_real < date '2099-12-31' and not servico_unico and coalesce(renovacao, '') <> 'renovado' and fim_real between par.i and par.f
  union all select 'fat', lead_id, cliente, data_prevista, servico, valor, det from pg, par where data_prevista between par.i and par.f
  union all select 'fat_pif', lead_id, cliente, data_prevista, servico, valor, det from pg, par where data_prevista between par.i and par.f and modalidade = 1
  union all select 'fat_mensal', lead_id, cliente, data_prevista, servico, valor, det from pg, par where data_prevista between par.i and par.f and modalidade > 1
  union all select 'por_receber', lead_id, cliente, data_prevista, servico, valor, det from pg, par where estado = 'pendente' and data_prevista between par.i and par.f
  union all select 'caixa', lead_id, cliente, data_pagamento, servico, valor, det from pg, par where estado = 'pago' and data_pagamento between par.i and par.f
  union all select 'caixa_pif', lead_id, cliente, data_pagamento, servico, valor, det from pg, par where estado = 'pago' and data_pagamento between par.i and par.f and modalidade = 1
  union all select 'caixa_mensal', lead_id, cliente, data_pagamento, servico, valor, det from pg, par where estado = 'pago' and data_pagamento between par.i and par.f and modalidade > 1
  union all select 'ativos_hoje', lead_id, cliente, data_inicio, servico, mensal, case when fim_previsto >= date '2099-01-01' then 'por mês · sem data de fim' else 'por mês · até ' || to_char(fim_previsto, 'DD/MM/YYYY') end from hoje
  union all select 'em_atraso', lead_id, cliente, data_prevista, servico, valor, det from pg where estado = 'pendente' and data_prevista < current_date
)
select lista, lead_id::text lead_id, cliente, dia::text dia, servico, valor::float8 valor, detalhe from x order by lista, dia desc nulls last, cliente$q$));

  out := out || jsonb_build_object('unit_servico',$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(replace(d, old1, new1), old2, new2);
  if length(d) - n <> length(new1) - length(old1) + length(new2) - length(old2) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
