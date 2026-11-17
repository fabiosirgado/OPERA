-- Dashboard Admin, separador Ana: "Reuniões" (pedido do Fábio, 2026-11-17: "a Ana já fez mais reuniões";
-- "só as já realizadas é que devem contar").
-- Antes contava só as leads que a própria Ana passou para R1 (as passagens a R1 são quase sempre feitas pelo André).
-- Agora conta as reuniões realizadas da Ana: tarefas do tipo Reunião em leads da OPERA, marcadas por ela ou feitas
-- por ela, marcadas como Feita, pela data em que se carregou em Feita. Agendadas, canceladas e "Não feita" não contam.

do $do$
declare d text; n int; k int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$r1 as ( select e.lead_id, e.created_at::date dia from lead_events e join lead_stages s on s.id = e.to_stage_id join leads l on l.id = e.lead_id where e.type = 'stage' and s.name = 'R1' and e.author_id in (select id from ana) and l.client_id in (select id from clients where leads_internal) ),$a$;
  new1 constant text := $a$r1 as ( select t.lead_id, (t.done_at at time zone 'Europe/Lisbon')::date dia, true feita from lead_tasks t join leads l on l.id = t.lead_id where t.type = 'meeting' and t.done_at is not null and t.canceled_at is null and not t.missed and (t.created_by in (select id from ana) or t.done_by in (select id from ana)) and l.client_id in (select id from clients where leads_internal) ),$a$;
  old2 constant text := $a$(select count(distinct lead_id) from r1 where dia between p.inicio and p.fim)::int reunioes,$a$;
  new2 constant text := $a$(select count(*) from r1 where dia between p.inicio and p.fim)::int reunioes,$a$;
  old3 constant text := $a$r1 as ( select e.lead_id, min(e.created_at::date) dia from lead_events e join lead_stages s on s.id = e.to_stage_id join leads l on l.id = e.lead_id, a where e.type = 'stage' and s.name = 'R1' and e.author_id in (select id from ana) and l.client_id in (select id from clients where leads_internal) and e.created_at::date between a.inicio and a.fim group by 1 ),$a$;
  new3 constant text := $a$r1 as ( select t.lead_id, (t.done_at at time zone 'Europe/Lisbon')::date dia, true feita from lead_tasks t join leads l on l.id = t.lead_id, a where t.type = 'meeting' and t.done_at is not null and t.canceled_at is null and not t.missed and (t.created_by in (select id from ana) or t.done_by in (select id from ana)) and l.client_id in (select id from clients where leads_internal) and (t.done_at at time zone 'Europe/Lisbon')::date between a.inicio and a.fim ),$a$;
  old4 constant text := $a$'fase atual: ' || coalesce(s.name, '?') from r1$a$;
  new4 constant text := $a$'fase atual: ' || coalesce(s.name, '?') from r1$a$;
begin
  d := pg_get_functiondef(sig);
  foreach k in array array[1,2,3,4] loop
    if (length(d) - length(replace(d, (array[old1,old2,old3,old4])[k], ''))) / length((array[old1,old2,old3,old4])[k]) <> 1 then
      raise exception 'opera_admin_dados: ponto de alteração % não encontrado (ou repetido)', k;
    end if;
  end loop;
  n := length(d);
  d := replace(replace(replace(replace(d, old1, new1), old2, new2), old3, new3), old4, new4);
  if length(d) - n <> length(new1) - length(old1) + length(new2) - length(old2) + length(new3) - length(old3) + length(new4) - length(old4) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
