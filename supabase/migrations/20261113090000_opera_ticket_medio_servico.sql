-- Dashboard Admin, separador Comercial: ticket médio por serviço (pedido do Fábio, 2026-11-13).
-- Regras (as mesmas do cartão Ticket médio já existente):
-- * Contratos novos (origem automático ou manual, não cancelados) com data de fecho no período.
-- * ticket_medio_sa: só contratos OPERA SA. ticket_medio_bo: só contratos OPERA BO.
-- * ticket_medio (geral): todos os contratos novos, incluindo bundle SA + BO e outros.
-- * Também devolve o nº de contratos usado em cada média.

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$(select avg(valor_total) from novos)::float8 ticket_medio,$a$;
  new1 constant text := $a$(select avg(valor_total) from novos)::float8 ticket_medio, (select avg(valor_total) from novos where servico = 'SA')::float8 ticket_medio_sa, (select avg(valor_total) from novos where servico = 'BO')::float8 ticket_medio_bo, (select count(valor_total) from novos where servico = 'SA')::int ticket_n_sa, (select count(valor_total) from novos where servico = 'BO')::int ticket_n_bo, (select count(valor_total) from novos)::int ticket_n,$a$;
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
