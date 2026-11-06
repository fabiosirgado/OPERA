-- OPERA Leads: tempo médio de chamada no dashboard (pedido do Fábio, 2026-11-06).
-- Conta as mesmas chamadas que "Chamadas atendidas": feitas pela OPERA no período (não as recebidas nem as importadas),
-- atendidas e com conversa de 10 segundos ou mais. Tempo de conversa da CloudTalk (duration_s), em segundos.
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_dashboard(uuid,text,date,date)'::regprocedure;
  anchor constant text := $a$'calls', tot.calls, 'answered', tot.answered, 'attempts', tot.calls - tot.answered,$a$;
  add constant text := $a$
    'call_time', (select jsonb_build_object('avg_s', avg(s), 'median_s', percentile_cont(0.5) within group (order by s), 'total_s', coalesce(sum(s), 0))
                    from (select (e.meta ->> 'duration_s')::numeric as s from public.lead_events e join public.leads l on l.id = e.lead_id
                           where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to
                             and coalesce(e.meta ->> 'direction', '') <> 'incoming' and not (e.meta ? 'imported')
                             and (e.meta ->> 'answered') = 'true' and coalesce((e.meta ->> 'duration_s')::numeric, 0) >= 10
                             and l.client_id in (select id from cl)) c),$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, anchor, anchor || add);
  if length(d) - n <> length(add) then raise exception 'leads_dashboard: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;
