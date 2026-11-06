-- OPERA Leads: "Conversas" no dashboard (pedido do Fábio, 2026-11-06).
-- O tempo de chamada passa a contar só conversas: chamadas feitas pela OPERA, atendidas e com 1 minuto ou mais
-- (as atendidas mais curtas são quase sempre "agora não posso" ou "já não tenho interesse" e enviesavam a média).
-- Devolve também quantas conversas houve. As "Chamadas atendidas" continuam a contar a partir de 10 segundos.
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_dashboard(uuid,text,date,date)'::regprocedure;
  old constant text := $a$
    'call_time', (select jsonb_build_object('avg_s', avg(s), 'median_s', percentile_cont(0.5) within group (order by s), 'total_s', coalesce(sum(s), 0))
                    from (select (e.meta ->> 'duration_s')::numeric as s from public.lead_events e join public.leads l on l.id = e.lead_id
                           where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to
                             and coalesce(e.meta ->> 'direction', '') <> 'incoming' and not (e.meta ? 'imported')
                             and (e.meta ->> 'answered') = 'true' and coalesce((e.meta ->> 'duration_s')::numeric, 0) >= 10
                             and l.client_id in (select id from cl)) c),$a$;
  new constant text := $a$
    'call_time', (select jsonb_build_object('n', count(*), 'avg_s', avg(s), 'median_s', percentile_cont(0.5) within group (order by s), 'total_s', coalesce(sum(s), 0))
                    from (select (e.meta ->> 'duration_s')::numeric as s from public.lead_events e join public.leads l on l.id = e.lead_id
                           where e.type = 'call' and e.created_at >= v_from and e.created_at < v_to
                             and coalesce(e.meta ->> 'direction', '') <> 'incoming' and not (e.meta ? 'imported')
                             and (e.meta ->> 'answered') = 'true' and coalesce((e.meta ->> 'duration_s')::numeric, 0) >= 60
                             and l.client_id in (select id from cl)) c),$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, old, new);
  if length(d) - n <> length(new) - length(old) then raise exception 'leads_dashboard: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;
