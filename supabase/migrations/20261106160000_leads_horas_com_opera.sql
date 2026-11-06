-- OPERA Leads: as horas em chamada contam também o cliente interno (a própria OPERA), mesmo sem filtro de cliente
-- (pedido do Fábio, 2026-11-06). As chamadas da OPERA também ocupam os gestores. O resto do dashboard continua sem ele.
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_dashboard(uuid,text,date,date)'::regprocedure;
  old constant text := $a$where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to and not (e.meta ? 'imported')
                              and l.client_id in (select id from cl)) h),$a$;
  new constant text := $a$where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to and not (e.meta ? 'imported')
                              and l.client_id in (select c.id from public.clients c where c.leads_enabled and c.leads_status = 'ativo'
                                                     and (c.id = p_client or p_client is null))) h),$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, old, new);
  if length(d) - n <> length(new) - length(old) then raise exception 'leads_dashboard: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;
