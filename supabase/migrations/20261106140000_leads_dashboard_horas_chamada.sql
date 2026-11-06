-- OPERA Leads: horas em chamada no dashboard, para a ocupação dos gestores (pedido do Fábio, 2026-11-06).
-- Conta todo o tempo em chamada da CloudTalk (total_s: a chamar e em conversa), de todas as chamadas no período:
-- feitas e recebidas, atendidas ou não. Fica de fora só o histórico importado.
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_dashboard(uuid,text,date,date)'::regprocedure;
  anchor constant text := $a$'calls', tot.calls, 'answered', tot.answered, 'attempts', tot.calls - tot.answered,$a$;
  add constant text := $a$
    'call_hours', (select jsonb_build_object('total_s', coalesce(sum(s), 0),
                          'out_s', coalesce(sum(s) filter (where not incoming), 0), 'in_s', coalesce(sum(s) filter (where incoming), 0))
                     from (select coalesce((e.meta ->> 'total_s')::numeric, (e.meta ->> 'duration_s')::numeric, 0) as s,
                                  coalesce(e.meta ->> 'direction', '') = 'incoming' as incoming
                             from public.lead_events e join public.leads l on l.id = e.lead_id
                            where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to and not (e.meta ? 'imported')
                              and l.client_id in (select id from cl)) h),$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, anchor, anchor || add);
  if length(d) - n <> length(add) then raise exception 'leads_dashboard: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;
