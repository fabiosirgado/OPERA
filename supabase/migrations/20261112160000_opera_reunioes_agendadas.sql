-- Dashboard Admin, separador Comercial: nº de reuniões agendadas (pedido do Fábio, 2026-11-12).
-- Reunião agendada = tarefa do tipo "Reunião" numa lead do cliente OPERA, não cancelada.
-- * reunioes_agendadas: marcadas (criadas) no período.
-- * reunioes_no_periodo: com data dentro do período.
-- * reunioes_por_fazer: com data a partir de agora e ainda não feitas (a agenda).
-- * cartoes_lista ganha a lista 'reunioes' (reuniões marcadas no período), para abrir a partir do cartão.

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$(select count(distinct lead_id) from ev where fase in ('R1','R2') and dia between par.i and par.f)::int r1_total,$a$;
  new1 constant text := $a$(select count(distinct lead_id) from ev where fase in ('R1','R2') and dia between par.i and par.f)::int r1_total, (select count(*) from lead_tasks t join leads l on l.id = t.lead_id where t.type = 'meeting' and t.canceled_at is null and l.client_id in (select id from clients where leads_internal) and (t.created_at at time zone 'Europe/Lisbon')::date between par.i and par.f)::int reunioes_agendadas, (select count(*) from lead_tasks t join leads l on l.id = t.lead_id where t.type = 'meeting' and t.canceled_at is null and l.client_id in (select id from clients where leads_internal) and (t.due_at at time zone 'Europe/Lisbon')::date between par.i and par.f)::int reunioes_no_periodo, (select count(*) from lead_tasks t join leads l on l.id = t.lead_id where t.type = 'meeting' and t.canceled_at is null and t.done_at is null and t.due_at >= now() and l.client_id in (select id from clients where leads_internal))::int reunioes_por_fazer,$a$;
  old2 constant text := $a$  union all select 'em_atraso', lead_id, cliente, data_prevista, servico, valor, det from pg where estado = 'pendente' and data_prevista < current_date
)$a$;
  new2 constant text := $a$  union all select 'em_atraso', lead_id, cliente, data_prevista, servico, valor, det from pg where estado = 'pendente' and data_prevista < current_date
  union all select 'reunioes', l.id, l.name, (t.due_at at time zone 'Europe/Lisbon')::date, null, null::numeric, 'às ' || to_char(t.due_at at time zone 'Europe/Lisbon', 'HH24:MI') || ' · marcada a ' || to_char(t.created_at at time zone 'Europe/Lisbon', 'DD/MM') || coalesce(' por ' || nullif(split_part(trim(p.full_name), ' ', 1), ''), '') || case when t.done_at is not null then ' · feita' when t.due_at < now() then ' · por fechar' else ' · por fazer' end from lead_tasks t join leads l on l.id = t.lead_id left join profiles p on p.id = t.created_by, par where t.type = 'meeting' and t.canceled_at is null and l.client_id in (select id from clients where leads_internal) and (t.created_at at time zone 'Europe/Lisbon')::date between par.i and par.f
)$a$;
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
