-- OPERA Leads: botão "Não feita" nas tarefas (pedido do Fábio, 2026-11-13).
-- A tarefa sai das tarefas em aberto (como cancelada), fica marcada como não feita (missed) e o histórico da lead
-- regista "Reunião não feita" (ou Chamada / Follow up) com o dia e a hora para que estava marcada.
-- No Dashboard Admin, as reuniões não feitas continuam a contar como agendadas e a lista mostra "não feita".

alter table public.lead_tasks add column if not exists missed boolean not null default false;
comment on column public.lead_tasks.missed is 'A tarefa não foi feita (botão Não feita). Também tem canceled_at, por isso já não está em aberto.';

create or replace function public.leads_task_not_done(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.lead_tasks; v_quando text;
begin
  select * into t from public.lead_tasks where id = p_task_id;
  if not found then raise exception 'Tarefa não encontrada.'; end if;
  if not private.leads_can_write(t.lead_id) then raise exception 'Sem permissão para mexer nesta tarefa.'; end if;
  if t.done_at is not null or t.canceled_at is not null then raise exception 'Esta tarefa já não está em aberto.'; end if;
  update public.lead_tasks set canceled_at = now(), missed = true where id = p_task_id;
  v_quando := to_char(t.due_at at time zone 'Europe/Lisbon', 'DD/MM')
    || case when to_char(t.due_at at time zone 'Europe/Lisbon', 'HH24:MI:SS') = '23:59:59' then ''
            else ' às ' || to_char(t.due_at at time zone 'Europe/Lisbon', 'HH24:MI') end;
  insert into public.lead_events (lead_id, type, title, body, author_id, meta)
  values (t.lead_id, 'auto',
          case t.type when 'meeting' then 'Reunião' when 'call' then 'Chamada' when 'followup' then 'Follow up' else 'Tarefa' end || ' não feita',
          'Estava marcada para ' || v_quando || coalesce('. ' || nullif(trim(t.note), ''), '.'),
          auth.uid(), jsonb_build_object('task_id', t.id, 'task_type', t.type, 'missed', true));
end;
$$;
revoke execute on function public.leads_task_not_done(uuid) from public, anon;
grant execute on function public.leads_task_not_done(uuid) to authenticated;

-- Dashboard Admin: as reuniões não feitas contam como agendadas; na lista aparecem como "não feita".
do $do$
declare d text; n int; k int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$t.type = 'meeting' and t.canceled_at is null and l.client_id$a$;
  new1 constant text := $a$t.type = 'meeting' and (t.canceled_at is null or t.missed) and l.client_id$a$;
  old2 constant text := $a$case when t.done_at is not null then ' · feita'$a$;
  new2 constant text := $a$case when t.missed then ' · não feita' when t.done_at is not null then ' · feita'$a$;
begin
  d := pg_get_functiondef(sig);
  k := (length(d) - length(replace(d, old1, ''))) / length(old1);
  if k <> 3 then raise exception 'opera_admin_dados: esperava 3 contagens de reuniões, encontrei %', k; end if;
  n := length(d);
  d := replace(replace(d, old1, new1), old2, new2);
  if length(d) - n <> 3 * (length(new1) - length(old1)) + length(new2) - length(old2) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
