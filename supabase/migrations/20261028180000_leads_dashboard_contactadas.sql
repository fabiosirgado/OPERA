-- OPERA Leads: o dashboard devolve também as leads contactadas no período (com pelo menos uma chamada) e
-- as chamadas feitas às leads que entraram no período, para "chamadas por lead" usar a base certa.
do $do$
declare d text; n int;
begin
  d := pg_get_functiondef('public.leads_dashboard(uuid,text,date,date)'::regprocedure);
  n := length(d);
  d := replace(d, $a$'calls', tot.calls, 'answered', tot.answered, 'attempts', tot.calls - tot.answered,$a$,
$a$'calls', tot.calls, 'answered', tot.answered, 'attempts', tot.calls - tot.answered,
    -- Leads diferentes com pelo menos uma chamada no período, e chamadas às leads que entraram no período.
    'leads_called', (select count(distinct e.lead_id) from public.lead_events e join public.leads l on l.id = e.lead_id
                      where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to
                        and l.client_id in (select id from cl) and not (e.meta ? 'imported')),
    'calls_new', (select count(*) from public.lead_events e join public.leads l on l.id = e.lead_id
                   where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to
                     and l.client_id in (select id from cl) and not (e.meta ? 'imported')
                     and l.created_at >= v_from and l.created_at < v_to and not l.imported),$a$);
  if length(d) = n then raise exception 'leads_dashboard: substituição falhou'; end if;
  execute d;
end;
$do$;
