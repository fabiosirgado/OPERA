-- Dashboard Admin: o ticket médio (geral, SA e BO) passa a ser o valor mensal do contrato
-- (valor total / duração em meses), em vez do valor do pack (pedido do Fábio, 2026-11-13).

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$(select avg(valor_total) from novos)::float8 ticket_medio, (select avg(valor_total) from novos where servico = 'SA')::float8 ticket_medio_sa, (select avg(valor_total) from novos where servico = 'BO')::float8 ticket_medio_bo,$a$;
  new1 constant text := $a$(select avg(valor_total / nullif(duracao_meses, 0)) from novos)::float8 ticket_medio, (select avg(valor_total / nullif(duracao_meses, 0)) from novos where servico = 'SA')::float8 ticket_medio_sa, (select avg(valor_total / nullif(duracao_meses, 0)) from novos where servico = 'BO')::float8 ticket_medio_bo,$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, old1, new1);
  if length(d) - n <> length(new1) - length(old1) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
