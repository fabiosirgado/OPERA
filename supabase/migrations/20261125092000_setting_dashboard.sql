-- OPERA Leads, Setting B2B: dados do Dashboard de Setting (docs/setting/especificacao_setting.md, secção Dashboard de
-- Setting; desenho em docs/setting/dashboard_setting_vista_*.html). Uma só função devolve tudo em jsonb.
--
-- Filtros: cliente (um ou todos os de setting), Gestor de Leads, período (como o dashboard atual: '1', '7', '30', '0' =
-- tudo, ou 'custom' com início e fim, dias de Lisboa) e origem da lead ('nova', 'reativada', 'bd' ou todas).
-- A equipa OPERA vê os clientes de setting; um cliente vê só os seus dados (o filtro é imposto aqui) e não recebe a
-- comparação entre clientes nem a lista de gestores.
--
-- Funil (leads distintas, no período):
--   recebidas   leads que entraram no período (inclui as importadas de base de dados)
--   trabalhadas com pelo menos uma tentativa de contacto (chamada feita, ou mensagem de WhatsApp enviada) no período
--   atendidas   com pelo menos uma chamada atendida (10 s ou mais) ou uma resposta recebida no período
--   agendadas   entraram em Reunião Agendada no período
--   realizadas  passaram a Compareceu, Fechado ou Perdido no período
--   fechados    passaram a Fechado no período
-- Origem: reativada quando a lead foi reativada; senão nova (entrada meta ou imóveis) ou bd (entrada bd).
-- Gestor de Leads: só as leads em que esse gestor fez pelo menos uma chamada.
create or replace function public.leads_setting_dashboard(
  p_client uuid default null, p_manager uuid default null, p_period text default '30',
  p_from date default null, p_to date default null, p_origem text default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public' set work_mem to '32MB'
as $function$
declare
  v_opera boolean := private.leads_is_opera();
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_from timestamptz; v_to timestamptz;
  v_target integer;
  v_qual uuid; v_desq uuid;
  v_out jsonb;
begin
  if not v_opera then
    p_client := private.leads_my_client_id();
    p_manager := null;
    if p_client is null or not private.leads_is_setting(p_client) then raise exception 'Sem acesso ao dashboard de setting.'; end if;
  end if;
  if p_origem is not null and p_origem not in ('nova', 'reativada', 'bd') then p_origem := null; end if;
  if p_period = 'custom' then
    if p_from is null or p_to is null or p_to < p_from then raise exception 'Escolha um período válido.'; end if;
    if p_to - p_from > 1095 then raise exception 'O período máximo é de 3 anos.'; end if;
    v_from := p_from::timestamp at time zone 'Europe/Lisbon';
    v_to := (p_to + 1)::timestamp at time zone 'Europe/Lisbon';
  else
    v_from := case p_period when '1' then v_today when '7' then now() - interval '7 days'
                            when '30' then now() - interval '30 days' else '-infinity'::timestamptz end;
    v_to := 'infinity'::timestamptz;
  end if;
  select ttl_target_minutes into v_target from public.leads_settings;
  select id into v_qual from public.lead_stages where key = 'qualificada' and client_id is null;
  select id into v_desq from public.lead_stages where key = 'desq' and client_id is null;

  with cl as (
    select c.id, c.name, c.color from public.clients c
     where c.service_type = 'setting' and c.leads_enabled and (p_client is null or c.id = p_client)
  ),
  out_st as (  -- etapas de resultado da reunião dos clientes de setting
    select s.id, s.client_id, s.outcome from public.lead_stages s where s.client_id in (select id from cl) and s.outcome is not null
  ),
  ld as (
    select l.id, l.client_id, l.created_at, l.first_call_at, l.entry_stage, l.stage_id, l.meeting_at, l.desq_reason, l.name,
           l.qualification, l.meeting_with, l.meeting_link, l.reschedules,
           case when l.reactivated_at is not null then 'reativada' when l.entry_stage = 'bd' then 'bd' else 'nova' end as origem
      from public.leads l
     where l.client_id in (select id from cl) and not l.anonymized
       and (p_manager is null or exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'call' and e.author_id = p_manager))
  ),
  lf as (select * from ld where p_origem is null or origem = p_origem),
  ev as (  -- histórico do período, só o que conta para o dashboard
    select e.lead_id, e.type, e.created_at, e.to_stage_id, e.meta, e.author_id, lf.client_id, lf.origem
      from public.lead_events e join lf on lf.id = e.lead_id
     where e.created_at >= v_from and e.created_at < v_to and not (e.meta ? 'imported')
       and (e.type in ('call', 'whatsapp') or (e.type = 'stage' and (e.to_stage_id in (v_qual, v_desq) or e.to_stage_id in (select id from out_st))))
  ),
  flags as (
    select lf.id, lf.client_id, lf.origem,
           (lf.created_at >= v_from and lf.created_at < v_to) as recebida,
           exists (select 1 from ev where ev.lead_id = lf.id and ((ev.type = 'call' and coalesce(ev.meta ->> 'direction', '') <> 'incoming')
                                                                  or (ev.type = 'whatsapp' and ev.meta ->> 'direcao' = 'out'))) as trabalhada,
           exists (select 1 from ev where ev.lead_id = lf.id and ((ev.type = 'call' and (ev.meta ->> 'answered') = 'true'
                                                                    and coalesce((ev.meta ->> 'duration_s')::numeric, 0) >= 10)
                                                                  or (ev.type = 'whatsapp' and ev.meta ->> 'direcao' = 'in'))) as atendida,
           exists (select 1 from ev where ev.lead_id = lf.id and ev.type = 'stage' and ev.to_stage_id = v_qual) as agendada,
           exists (select 1 from ev join out_st o on o.id = ev.to_stage_id where ev.lead_id = lf.id and o.outcome in ('compareceu', 'fechado', 'perdido')) as realizada,
           exists (select 1 from ev join out_st o on o.id = ev.to_stage_id where ev.lead_id = lf.id and o.outcome = 'fechado') as fechada,
           (select count(*) from ev join out_st o on o.id = ev.to_stage_id where ev.lead_id = lf.id and o.outcome = 'nao_compareceu') as faltas,
           (select count(*) from ev where ev.lead_id = lf.id and ev.type = 'stage' and ev.to_stage_id = v_qual) as marcacoes,
           (lf.meeting_at is not null and lf.meeting_at <= now()) as data_passou
      from lf
  ),
  funil as (  -- por cliente e origem; os totais saem da soma
    select client_id, origem,
           count(*) filter (where recebida) as recebidas,
           count(*) filter (where trabalhada) as trabalhadas,
           count(*) filter (where atendida) as atendidas,
           count(*) filter (where agendada) as agendadas,
           count(*) filter (where agendada and (data_passou or realizada or faltas > 0)) as agendadas_passadas,
           count(*) filter (where realizada) as realizadas,
           count(*) filter (where fechada) as fechados,
           coalesce(sum(faltas), 0) as faltas,
           coalesce(sum(greatest(marcacoes - 1, 0)) filter (where faltas > 0 or marcacoes > 1), 0) as remarcadas
      from flags group by client_id, origem
  ),
  tot as (
    select coalesce(sum(recebidas), 0) recebidas, coalesce(sum(trabalhadas), 0) trabalhadas, coalesce(sum(atendidas), 0) atendidas,
           coalesce(sum(agendadas), 0) agendadas, coalesce(sum(agendadas_passadas), 0) agendadas_passadas,
           coalesce(sum(realizadas), 0) realizadas, coalesce(sum(fechados), 0) fechados,
           coalesce(sum(faltas), 0) faltas, coalesce(sum(remarcadas), 0) remarcadas
      from funil
  ),
  ttl as (  -- Time to Lead das leads novas (minutos de trabalho), como no dashboard atual
    select percentile_cont(0.5) within group (order by public.leads_business_minutes(created_at, first_call_at)) as mediana,
           count(*) as n,
           count(*) filter (where public.leads_business_minutes(created_at, first_call_at) <= v_target) as no_objetivo
      from lf where entry_stage in ('meta', 'imoveis') and first_call_at is not null and created_at >= v_from and created_at < v_to
  ),
  semanas as (
    select date_trunc('week', ev.created_at at time zone 'Europe/Lisbon')::date as semana, count(distinct ev.lead_id) as n
      from ev where ev.type = 'stage' and ev.to_stage_id = v_qual group by 1
  ),
  atividade as (
    select count(*) filter (where (type = 'call' and coalesce(meta ->> 'direction', '') <> 'incoming') or (type = 'whatsapp' and meta ->> 'direcao' = 'out')) as contactos,
           count(*) filter (where type = 'call' and coalesce(meta ->> 'direction', '') <> 'incoming') as chamadas
      from ev
  ),
  lead_reuniao as (  -- tempo médio da entrada da lead à primeira reunião agendada no período (dias)
    select avg(extract(epoch from (x.primeira - lf.created_at)) / 86400.0) as dias
      from (select lead_id, min(created_at) as primeira from ev where type = 'stage' and to_stage_id = v_qual group by lead_id) x
      join lf on lf.id = x.lead_id
  ),
  atrasados as (
    select count(distinct t.lead_id) as n from public.lead_tasks t join lf on lf.id = t.lead_id
      join public.leads l on l.id = t.lead_id join public.lead_stages s on s.id = l.stage_id
     where t.done_at is null and t.canceled_at is null and t.type in ('call', 'followup') and t.due_at < now() and s.position < 50
  ),
  motivos as (
    select coalesce(nullif(split_part(lf.desq_reason, ':', 1), ''), 'Sem motivo') as motivo, count(distinct lf.id) as n
      from ev join lf on lf.id = ev.lead_id
     where ev.type = 'stage' and ev.to_stage_id = v_desq group by 1
  )
  select jsonb_build_object(
    'clientes', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'color', color) order by name), '[]'::jsonb) from cl),
    'ttl', (select jsonb_build_object('mediana', round(mediana::numeric, 1), 'n', n, 'no_objetivo', no_objetivo, 'objetivo', v_target) from ttl),
    'funil', (select to_jsonb(tot) from tot),
    'por_origem', (select coalesce(jsonb_object_agg(origem, x), '{}'::jsonb) from (
        select origem, jsonb_build_object('recebidas', sum(recebidas), 'trabalhadas', sum(trabalhadas), 'atendidas', sum(atendidas),
                                          'agendadas', sum(agendadas), 'agendadas_passadas', sum(agendadas_passadas),
                                          'realizadas', sum(realizadas), 'fechados', sum(fechados)) as x
          from funil group by origem) o),
    'semanas', (select coalesce(jsonb_agg(jsonb_build_object('semana', semana, 'n', n) order by semana), '[]'::jsonb) from semanas),
    'atividade', (select jsonb_build_object(
        'contactos', a.contactos,
        'tentativas_por_lead', case when t.trabalhadas > 0 then round(a.chamadas::numeric / t.trabalhadas, 1) end,
        'followups_atraso', (select n from atrasados),
        'lead_a_reuniao_dias', (select round(dias::numeric, 1) from lead_reuniao),
        'recuperadas_bd', (select coalesce(sum(agendadas), 0) from funil where origem = 'bd'))
      from atividade a, tot t),
    'motivos', (select coalesce(jsonb_agg(jsonb_build_object('motivo', motivo, 'n', n) order by n desc, motivo), '[]'::jsonb) from motivos),
    'por_cliente', case when v_opera then (select coalesce(jsonb_agg(jsonb_build_object(
        'id', cl.id, 'name', cl.name, 'color', cl.color,
        'recebidas', coalesce(f.recebidas, 0), 'atendidas', coalesce(f.atendidas, 0), 'agendadas', coalesce(f.agendadas, 0),
        'agendadas_passadas', coalesce(f.agendadas_passadas, 0), 'realizadas', coalesce(f.realizadas, 0),
        'fechados', coalesce(f.fechados, 0), 'faltas', coalesce(f.faltas, 0), 'remarcadas', coalesce(f.remarcadas, 0)) order by cl.name), '[]'::jsonb)
      from cl left join (select client_id, sum(recebidas) recebidas, sum(atendidas) atendidas, sum(agendadas) agendadas,
                                sum(agendadas_passadas) agendadas_passadas, sum(realizadas) realizadas, sum(fechados) fechados,
                                sum(faltas) faltas, sum(remarcadas) remarcadas from funil group by client_id) f on f.client_id = cl.id) end,
    'proximas', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'client_id', client_id, 'meeting_at', meeting_at,
                                                             'meeting_with', meeting_with, 'meeting_link', meeting_link,
                                                             'qualification', qualification) order by meeting_at), '[]'::jsonb)
                   from (select * from lf where stage_id = v_qual and meeting_at >= now() order by meeting_at limit 20) x),
    'por_marcar', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'client_id', client_id, 'meeting_at', meeting_at,
                                                               'meeting_with', meeting_with) order by meeting_at), '[]'::jsonb)
                     from (select * from lf where stage_id = v_qual and meeting_at < now() order by meeting_at limit 50) x),
    'gestores', case when v_opera then (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email)) order by coalesce(p.full_name, p.email)), '[]'::jsonb)
                   from public.profiles p where p.client_id is null and p.leads_status = 'ativo' and p.leads_role in ('admin', 'gestor')) end
  ) into v_out;
  return v_out;
end;
$function$;

revoke all on function public.leads_setting_dashboard(uuid, uuid, text, date, date, text) from public, anon;
grant execute on function public.leads_setting_dashboard(uuid, uuid, text, date, date, text) to authenticated;
