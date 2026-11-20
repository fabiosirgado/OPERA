-- OPERA Leads, Fila: escolher à mão as leads de BD de um cliente que entram na fila (pedido do Fábio, 2026-11-20).
-- As escolhidas entram sempre (mesmo com 2 ou mais tentativas e mesmo com o cliente fora da fila automática),
-- passam à frente da BD automática desse cliente e contam para as leads do dia: a BD automática só completa o que falta.
-- Saem das escolhidas quando se lhes dá um resultado na fila, ou quando se tiram à mão.
-- Uma lead escolhida com tarefa marcada fica fora da fila até à hora da tarefa (como as outras).

alter table public.lead_fila
  add column escolhida_at timestamptz,
  add column escolhida_por uuid references public.profiles(id) on delete set null;

create or replace function public.leads_fila(p_client uuid default null)
returns table (lead_id uuid, grupo text, grupo_ordem integer, ordem bigint, name text, phone text, interest text, source text,
               client_id uuid, client_name text, client_color text, stage_name text, attempts integer, sem_resposta integer,
               new_at timestamptz, next_task_at timestamptz, next_task_type text, motivo text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_end timestamptz := (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '1 day') at time zone 'Europe/Lisbon';
  v_week timestamptz := date_trunc('week', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_days numeric := least(5, extract(isodow from now() at time zone 'Europe/Lisbon'));
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  return query
  with clientes as (
    select c.id, c.name, c.color, coalesce(fc.leads_dia, 25) as leads_dia,
           (p_client is not null or coalesce(fc.ativa, true)) as auto
      from public.clients c
      left join public.lead_fila_clientes fc on fc.client_id = c.id
     where c.id in (select private.leads_active_client_ids())
       and not coalesce(c.leads_internal, false)
       and (case when p_client is not null then c.id = p_client
            else not exists (select 1 from public.lead_fila_exclusoes x where x.user_id = v_me and x.client_id = c.id)
             and (c.id in (select m.client_id from public.client_managers m where m.user_id = v_me)
                  or not exists (select 1 from public.client_managers m where m.user_id = v_me)) end)
  ),
  trab as (
    select l.client_id,
           count(distinct e.lead_id) filter (where e.created_at >= v_today) as hoje,
           count(distinct (e.lead_id, (e.created_at at time zone 'Europe/Lisbon')::date)) as semana
      from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.type = 'call' and e.created_at >= v_week and l.client_id in (select id from clientes)
     group by l.client_id
  ),
  ultimo as (
    select l.client_id from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.author_id = v_me and e.type = 'call' and e.created_at >= v_today and l.entry_stage = 'bd'
       and l.client_id in (select id from clientes)
     order by e.created_at desc limit 1
  ),
  rk as (
    select c.id,
           row_number() over (order by case when c.id = (select u.client_id from ultimo u) then 0 else 1 end,
                                       coalesce(t.semana, 0)::numeric / greatest(1, c.leads_dia * v_days), c.name) as rk,
           greatest(0, c.leads_dia - coalesce(t.hoje, 0)) as resta
      from clientes c left join trab t on t.client_id = c.id
  ),
  base as (
    select l.id, l.name, l.phone, l.interest, l.source, l.client_id, l.attempts, l.new_at, l.next_task_at, l.next_task_type,
           l.created_at, l.source_created_at, s.name as sname, s.key as skey,
           coalesce(f.sem_resposta, 0) as sr, f.escolhida_at, c.name as cname, c.color as ccolor, c.auto, r.rk, r.resta,
           (l.next_task_at at time zone 'Europe/Lisbon')::time = time '23:59:59' as dia_todo
      from public.leads l
      join clientes c on c.id = l.client_id
      join rk r on r.id = l.client_id
      join public.lead_stages s on s.id = l.stage_id
      left join public.lead_fila f on f.lead_id = l.id
     where not l.anonymized and s.position < 50 and f.aguarda_whatsapp_at is null
  ),
  nova as (
    select b.*, 1 as g,
           row_number() over (order by b.new_at asc) as o,
           'Entrou ' || to_char(b.new_at at time zone 'Europe/Lisbon', 'DD/MM "às" HH24:MI') as m
      from base b where b.new_at is not null
  ),
  marcada as (
    select b.*, 2 as g, row_number() over (order by b.next_task_at) as o,
           'Chamada marcada para as ' || to_char(b.next_task_at at time zone 'Europe/Lisbon', 'HH24:MI') as m
      from base b
     where b.new_at is null and b.next_task_type in ('call', 'followup') and not b.dia_todo
       and b.next_task_at <= now() and b.next_task_at > now() - interval '3 hours'
  ),
  fu as (
    select b.*, 4 as g,
           b.rk * 100000 + row_number() over (partition by b.client_id order by b.next_task_at nulls last, b.created_at) as o,
           case when b.next_task_at is null then 'Em Follow Up sem tarefa marcada'
                else (case b.next_task_type when 'call' then 'Chamada' else 'Follow up' end) || ' para '
                     || to_char(b.next_task_at at time zone 'Europe/Lisbon', case when b.dia_todo then 'DD/MM' else 'DD/MM HH24:MI' end) end as m
      from base b
     where b.auto and b.new_at is null
       and ((b.next_task_type in ('call', 'followup')
             and (b.next_task_at <= now() - interval '3 hours'
                  or (b.next_task_at <= now() and b.dia_todo)
                  or (b.dia_todo and b.next_task_at < v_end)))
            or (b.skey = 'followup' and b.next_task_at is null))
  ),
  bd as (
    select x.* from (
      select b.*, 5 as g,
             row_number() over (partition by b.client_id order by b.escolhida_at is null, b.escolhida_at, b.attempts,
                                coalesce(b.source_created_at, b.created_at) desc) as rn,
             case when b.escolhida_at is not null then 'Escolhida para a fila · ' else 'Recuperação · ' end
               || b.attempts || case when b.attempts = 1 then ' tentativa' else ' tentativas' end as m
        from base b
       where b.new_at is null and b.next_task_at is null
         and (b.escolhida_at is not null
              or (b.auto and b.skey in ('meta', 'imoveis', 'bd') and b.attempts < 2 and b.sr < 2))
    ) x where x.escolhida_at is not null or x.rn <= x.resta
  ),
  tudo as (
    select n.id, n.g, n.o, n.m, n.name, n.phone, n.interest, n.source, n.client_id, n.cname, n.ccolor, n.sname, n.attempts, n.sr, n.new_at, n.next_task_at, n.next_task_type from nova n
    union all
    select k.id, k.g, k.o, k.m, k.name, k.phone, k.interest, k.source, k.client_id, k.cname, k.ccolor, k.sname, k.attempts, k.sr, k.new_at, k.next_task_at, k.next_task_type from marcada k
    union all
    select f.id, f.g, f.o, f.m, f.name, f.phone, f.interest, f.source, f.client_id, f.cname, f.ccolor, f.sname, f.attempts, f.sr, f.new_at, f.next_task_at, f.next_task_type from fu f
     where f.id not in (select k2.id from marcada k2)
    union all
    select d.id, d.g, d.rk * 100000 + d.rn, d.m, d.name, d.phone, d.interest, d.source, d.client_id, d.cname, d.ccolor, d.sname, d.attempts, d.sr, d.new_at, d.next_task_at, d.next_task_type from bd d
     where d.id not in (select f2.id from fu f2)
  )
  select t.id, case t.g when 1 then 'Lead nova' when 2 then 'Hora marcada' when 4 then 'Follow up' else 'BD' end,
         t.g, t.o, t.name, t.phone, t.interest, t.source, t.client_id, t.cname, t.ccolor, t.sname, t.attempts, t.sr,
         t.new_at, t.next_task_at, t.next_task_type, t.m
    from tudo t
   order by t.g, t.o
   limit 400;
end;
$$;
revoke execute on function public.leads_fila(uuid) from public, anon;
grant execute on function public.leads_fila(uuid) to authenticated;

create or replace function public.leads_fila_resultado(p_lead uuid, p_resultado text, p_quando timestamptz default null,
                                                     p_nota text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pos numeric;
  v_fu uuid; v_q uuid; v_dq uuid;
  v_sr integer;
  v_msg text;
  v_when timestamptz;
begin
  if not (private.leads_is_opera() and private.leads_can_write(p_lead)) then
    raise exception 'Sem acesso a esta lead.';
  end if;
  if p_resultado not in ('nao_atendeu', 'mais_tarde', 'follow_up', 'qualificada', 'desqualificada') then
    raise exception 'Resultado desconhecido.';
  end if;
  select s.position into v_pos from public.leads l join public.lead_stages s on s.id = l.stage_id where l.id = p_lead for update of l;
  select id into v_fu from public.lead_stages where key = 'followup' and client_id is null;
  select id into v_q from public.lead_stages where key = 'qualificada' and client_id is null;
  select id into v_dq from public.lead_stages where key = 'desq' and client_id is null;
  insert into public.lead_fila (lead_id) values (p_lead) on conflict (lead_id) do nothing;

  if coalesce(trim(p_nota), '') <> '' then
    insert into public.lead_events (lead_id, type, title, body, author_id) values (p_lead, 'note', 'Nota', trim(p_nota), auth.uid());
  end if;

  if p_resultado in ('nao_atendeu', 'mais_tarde', 'follow_up') then
    -- A tarefa que trouxe a lead à fila fica feita.
    update public.lead_tasks set done_at = now()
     where lead_id = p_lead and done_at is null and canceled_at is null and type in ('call', 'followup') and due_at <= now();
  end if;

  if p_resultado = 'nao_atendeu' then
    update public.lead_fila set sem_resposta = sem_resposta + 1, updated_at = now() where lead_id = p_lead returning sem_resposta into v_sr;
    if v_sr >= 2 then
      update public.lead_fila set aguarda_whatsapp_at = now() where lead_id = p_lead;
      update public.lead_tasks set canceled_at = now()
       where lead_id = p_lead and done_at is null and canceled_at is null and type in ('call', 'followup');
      insert into public.lead_events (lead_id, type, title, body, author_id)
      values (p_lead, 'auto', 'Fila: sem resposta 2 vezes',
              'Não atendeu 2 vezes seguidas. Saiu da fila e fica à espera da mensagem de reativação por WhatsApp.', auth.uid());
      v_msg := 'Sem resposta 2 vezes: saiu da fila e fica à espera da mensagem de WhatsApp.';
    else
      v_when := coalesce(p_quando, now() + interval '3 hours');
      -- Fora do horário (depois das 19:00 ou antes das 9:30): passa para o dia útil seguinte às 10:00.
      if p_quando is null and ((v_when at time zone 'Europe/Lisbon')::time > time '19:00'
                               or (v_when at time zone 'Europe/Lisbon')::time < time '09:30') then
        v_when := (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '1 day 10 hours') at time zone 'Europe/Lisbon';
        if extract(isodow from v_when at time zone 'Europe/Lisbon') = 6 then v_when := v_when + interval '2 days';
        elsif extract(isodow from v_when at time zone 'Europe/Lisbon') = 7 then v_when := v_when + interval '1 day'; end if;
      end if;
      insert into public.lead_tasks (lead_id, type, due_at, note, created_by) values (p_lead, 'call', v_when, '2.ª tentativa', auth.uid());
      v_msg := '2.ª tentativa marcada para ' || to_char(v_when at time zone 'Europe/Lisbon', 'DD/MM "às" HH24:MI') || '.';
    end if;
    if v_pos < 40 then update public.leads set stage_id = v_fu where id = p_lead; end if;

  elsif p_resultado in ('mais_tarde', 'follow_up') then
    if p_quando is null then raise exception 'Escolhe quando voltar a contactar.'; end if;
    update public.lead_fila set sem_resposta = 0, updated_at = now() where lead_id = p_lead;
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (p_lead, case when p_resultado = 'mais_tarde' then 'call' else 'followup' end, p_quando,
            case when p_resultado = 'mais_tarde' then 'Pediu para ligar mais tarde' else 'Follow up' end, auth.uid());
    if v_pos < 40 then update public.leads set stage_id = v_fu where id = p_lead; end if;
    v_msg := case when p_resultado = 'mais_tarde' then 'Chamada marcada' else 'Follow up marcado' end || ' para '
             || to_char(p_quando at time zone 'Europe/Lisbon', case when p_resultado = 'follow_up' then 'DD/MM' else 'DD/MM "às" HH24:MI' end) || '.';

  elsif p_resultado = 'qualificada' then
    update public.lead_fila set sem_resposta = 0, updated_at = now() where lead_id = p_lead;
    update public.leads set stage_id = v_q where id = p_lead;
    v_msg := 'Lead qualificada. O cliente vai ser avisado.';

  else
    update public.lead_fila set sem_resposta = 0, updated_at = now() where lead_id = p_lead;
    update public.leads set stage_id = v_dq where id = p_lead;
    v_msg := 'Lead desqualificada.';
  end if;

  -- Já foi trabalhada: deixa de contar como lead nova por pegar e sai das escolhidas para a fila.
  update public.leads set new_at = null where id = p_lead and new_at is not null;
  update public.lead_fila set escolhida_at = null, escolhida_por = null where lead_id = p_lead and escolhida_at is not null;
  return jsonb_build_object('mensagem', v_msg);
end;
$$;
revoke execute on function public.leads_fila_resultado(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.leads_fila_resultado(uuid, text, timestamptz, text) to authenticated;

-- Leads de BD de um cliente que se podem escolher: etapas de entrada, sem tarefa marcada e que não são lead nova.
create or replace function public.leads_fila_bd_candidatas(p_client uuid, p_q text default null)
returns table (lead_id uuid, name text, phone text, stage_name text, attempts integer, last_contact_at timestamptz,
               origem_at timestamptz, escolhida boolean, sem_resposta integer, aguarda_whatsapp boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  return query
  select l.id, l.name, l.phone, s.name, l.attempts, l.last_contact_at, coalesce(l.source_created_at, l.created_at),
         f.escolhida_at is not null, coalesce(f.sem_resposta, 0), f.aguarda_whatsapp_at is not null
    from public.leads l
    join public.lead_stages s on s.id = l.stage_id
    left join public.lead_fila f on f.lead_id = l.id
   where l.client_id = p_client and not l.anonymized
     and s.key in ('meta', 'imoveis', 'bd') and l.new_at is null and l.next_task_at is null
     and (coalesce(trim(p_q), '') = '' or l.name ilike '%' || trim(p_q) || '%'
          or regexp_replace(coalesce(l.phone, ''), '\D', '', 'g') like '%' || regexp_replace(p_q, '\D', '', 'g') || '%'
             and regexp_replace(p_q, '\D', '', 'g') <> '')
   order by f.escolhida_at is null, f.escolhida_at, l.attempts, coalesce(l.source_created_at, l.created_at) desc
   limit 300;
end;
$$;
revoke execute on function public.leads_fila_bd_candidatas(uuid, text) from public, anon;
grant execute on function public.leads_fila_bd_candidatas(uuid, text) to authenticated;

-- Escolher (ou tirar) leads para a fila. Escolher uma lead à espera do WhatsApp tira-a da espera.
create or replace function public.leads_fila_escolher(p_leads uuid[], p_escolher boolean)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  if exists (select 1 from unnest(p_leads) x where not private.leads_can_write(x)) then
    raise exception 'Sem acesso a uma das leads.';
  end if;
  if p_escolher then
    insert into public.lead_fila (lead_id) select x from unnest(p_leads) x on conflict (lead_id) do nothing;
    update public.lead_fila set escolhida_at = now(), escolhida_por = auth.uid(), aguarda_whatsapp_at = null,
           sem_resposta = 0, updated_at = now()
     where lead_id = any(p_leads) and escolhida_at is null;
  else
    update public.lead_fila set escolhida_at = null, escolhida_por = null, updated_at = now()
     where lead_id = any(p_leads) and escolhida_at is not null;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.leads_fila_escolher(uuid[], boolean) from public, anon;
grant execute on function public.leads_fila_escolher(uuid[], boolean) to authenticated;
