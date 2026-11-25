-- OPERA Leads, WhatsApp: o quadro Métricas do ecrã WhatsApp ficava em "A carregar…" porque wa_metricas falhava
-- sempre ("aggregate functions are not allowed in GROUP BY"): nas tentativas por dia, o "group by 1" apontava para o
-- jsonb com o count(*). Passa a agrupar pelo dia. O resto da função fica igual.
create or replace function public.wa_metricas(p_de date, p_ate date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_de timestamptz := p_de::timestamp at time zone 'Europe/Lisbon'; v_ate timestamptz := (p_ate + 1)::timestamp at time zone 'Europe/Lisbon';
begin
  perform private.wa_admin();
  return jsonb_build_object(
    'por_cliente', coalesce((select jsonb_agg(x order by x ->> 'cliente') from (
       select jsonb_build_object('cliente', c.name, 'cor', c.color,
         'enviadas', count(*) filter (where m.status <> 'failed'),
         'entregues', count(*) filter (where m.status in ('delivered', 'read')),
         'lidas', count(*) filter (where m.status = 'read'),
         'falhadas', count(*) filter (where m.status = 'failed'),
         'bloqueios', count(*) filter (where m.status = 'failed' and m.error ~ '131049|131026|131047|130472')) x
         from public.wa_messages m join public.clients c on c.id = m.client_id
        where m.direction = 'out' and m.kind = 'template' and m.created_at >= v_de and m.created_at < v_ate
        group by c.name, c.color) s), '[]'::jsonb),
    'respostas', coalesce((select jsonb_agg(jsonb_build_object('modelo', z.modelo, 'tipo', z.tipo, 'n', z.n) order by z.modelo, z.tipo) from (
       select coalesce(o.template, '?') as modelo, t.tipo, count(*) as n
         from public.wa_messages i
         left join public.wa_messages o on o.wa_message_id = i.context_id
         cross join lateral (select case
             when i.kind = 'text' then 'texto'
             when lower(i.body) in ('procuro e tenho para vender', 'só procuro comprar', 'sim, quero vender', 'quero comprar', 'quero vender', 'sim, tenho interesse') then 'sim'
             when lower(i.body) in ('talvez mais tarde', 'agora não', 'mais tarde') then 'mais_tarde'
             when lower(i.body) in ('já comprei', 'já vendi', 'já não procuro', 'já não tenho interesse') then 'ja_nao'
             when lower(i.body) = 'não quero contactos' then 'nao_contactar'
             when lower(i.body) in ('assim que possível', 'amanhã de manhã', 'amanhã à tarde') then 'marcar_chamada'
             else 'outro' end as tipo) t
        where i.direction = 'in' and i.created_at >= v_de and i.created_at < v_ate
        group by 1, 2) z), '[]'::jsonb),
    'leads_com_modelo', (select count(distinct lead_id) from public.wa_messages where direction = 'out' and kind = 'template'
                           and status in ('delivered', 'read') and created_at >= v_de and created_at < v_ate),
    'leads_que_responderam', (select count(distinct i.lead_id) from public.wa_messages i join public.wa_messages o on o.wa_message_id = i.context_id
                                where i.direction = 'in' and o.kind = 'template' and i.created_at >= v_de and i.created_at < v_ate),
    'reativadas', (select count(*) from public.leads where reactivated_at >= v_de and reactivated_at < v_ate),
    'reativadas_qualificadas', (select count(*) from public.leads l join public.lead_stages s on s.id = l.stage_id
                                  where l.reactivated_at >= v_de and l.reactivated_at < v_ate and s.key = 'qualificada'),
    'ttl_reativacao_min', (select round(percentile_cont(0.5) within group (order by extract(epoch from (f.primeira - l.reactivated_at)) / 60)::numeric, 1)
                             from public.leads l
                             cross join lateral (select min(e.created_at) primeira from public.lead_events e
                                                  where e.lead_id = l.id and e.type = 'call' and e.created_at >= l.reactivated_at) f
                            where l.reactivated_at >= v_de and l.reactivated_at < v_ate and f.primeira is not null),
    'reativadas_por_ligar_hoje', (select count(*) from public.leads l
                                    where l.reactivated_at >= date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon'
                                      and not exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'call' and e.created_at >= l.reactivated_at)),
    'tentativas_por_dia', coalesce((select jsonb_agg(d order by d ->> 'dia') from (
       select jsonb_build_object('dia', (e.created_at at time zone 'Europe/Lisbon')::date, 'gestor', coalesce(p.full_name, p.email), 'chamadas', count(*)) d
         from public.lead_events e join public.profiles p on p.id = e.author_id
        where e.type = 'call' and e.created_at >= v_de and e.created_at < v_ate and coalesce(e.meta ->> 'direction', '') <> 'incoming'
        group by (e.created_at at time zone 'Europe/Lisbon')::date, p.full_name, p.email) w), '[]'::jsonb));
end $function$;
