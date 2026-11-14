-- Dashboard Admin, separador Comercial: reuniões realizadas (pedido do Fábio, 2026-11-14).
-- Reunião realizada = tarefa do tipo "Reunião" numa lead do cliente OPERA marcada como Feita no período.
-- * reunioes_realizadas: feitas no período (pela data em que se carregou em Feita).
-- * reunioes_nao_feitas: marcadas como Não feita, com data dentro do período.
-- * cartoes_lista ganha a lista 'reunioes_feitas'.

do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$and t.done_at is null and t.due_at >= now() and l.client_id in (select id from clients where leads_internal))::int reunioes_por_fazer,$a$;
  new1 constant text := $a$and t.done_at is null and t.due_at >= now() and l.client_id in (select id from clients where leads_internal))::int reunioes_por_fazer, (select count(*) from lead_tasks t join leads l on l.id = t.lead_id where t.type = 'meeting' and t.done_at is not null and not t.missed and l.client_id in (select id from clients where leads_internal) and (t.done_at at time zone 'Europe/Lisbon')::date between par.i and par.f)::int reunioes_realizadas, (select count(*) from lead_tasks t join leads l on l.id = t.lead_id where t.type = 'meeting' and t.missed and l.client_id in (select id from clients where leads_internal) and (t.due_at at time zone 'Europe/Lisbon')::date between par.i and par.f)::int reunioes_nao_feitas,$a$;
  old2 constant text := $a$  union all select 'reunioes', $a$;
  new2 constant text := $a$  union all select 'reunioes_feitas', l.id, l.name, (t.done_at at time zone 'Europe/Lisbon')::date, null, null::numeric, 'marcada para ' || to_char(t.due_at at time zone 'Europe/Lisbon', 'DD/MM HH24:MI') || coalesce(' por ' || nullif(split_part(trim(pc.full_name), ' ', 1), ''), '') || coalesce(' · feita por ' || nullif(split_part(trim(pd.full_name), ' ', 1), ''), '') from lead_tasks t join leads l on l.id = t.lead_id left join profiles pc on pc.id = t.created_by left join profiles pd on pd.id = t.done_by, par where t.type = 'meeting' and t.done_at is not null and not t.missed and l.client_id in (select id from clients where leads_internal) and (t.done_at at time zone 'Europe/Lisbon')::date between par.i and par.f
  union all select 'reunioes', $a$;
begin
  d := pg_get_functiondef(sig);
  if (length(d) - length(replace(d, old1, ''))) / length(old1) <> 1 or (length(d) - length(replace(d, old2, ''))) / length(old2) <> 1 then
    raise exception 'opera_admin_dados: pontos de inserção não encontrados (ou repetidos)';
  end if;
  n := length(d);
  d := replace(replace(d, old1, new1), old2, new2);
  if length(d) - n <> length(new1) - length(old1) + length(new2) - length(old2) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
