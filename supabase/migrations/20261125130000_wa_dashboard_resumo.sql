-- OPERA Leads, Dashboard: zona "Reativação por WhatsApp" na vista OPERA (pedido do Fábio, 2026-11-25), para se ver o
-- volume real do WhatsApp ao lado das chamadas. Mesmo período e mesmo filtro de cliente do dashboard.
-- Só a equipa OPERA; devolve null enquanto o WhatsApp não estiver em funcionamento (wa_live).
create or replace function public.wa_dashboard_resumo(p_client uuid default null, p_period text default '7',
                                                       p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon'; v_from timestamptz; v_to timestamptz;
begin
  if not private.leads_is_opera() then raise exception 'Sem acesso.'; end if;
  if not coalesce((select wa_live from public.leads_settings limit 1), false) then return null; end if;
  if p_period = 'custom' then
    v_from := p_from::timestamp at time zone 'Europe/Lisbon'; v_to := (p_to + 1)::timestamp at time zone 'Europe/Lisbon';
  else
    v_from := case p_period when '1' then v_today when '7' then now() - interval '7 days' when '30' then now() - interval '30 days' else '-infinity'::timestamptz end;
    v_to := 'infinity'::timestamptz;
  end if;
  return (
    with cl as (select id from public.clients where id in (select private.leads_active_client_ids()) and (p_client is null or id = p_client)),
    mo as (select * from public.wa_messages m where m.direction = 'out' and m.created_at >= v_from and m.created_at < v_to and m.client_id in (select id from cl)),
    mi as (select * from public.wa_messages m where m.direction = 'in' and m.created_at >= v_from and m.created_at < v_to and m.client_id in (select id from cl)),
    re as (select l.id, l.reactivated_at from public.leads l
            where l.client_id in (select id from cl) and l.reactivated_at >= v_from and l.reactivated_at < v_to)
    select jsonb_build_object(
      -- Mensagens de reativação (modelos) e mensagens automáticas (respostas e pedidos de horário).
      'modelos_enviados', (select count(*) from mo where kind = 'template' and status <> 'failed'),
      'modelos_entregues', (select count(*) from mo where kind = 'template' and status in ('delivered', 'read')),
      'modelos_lidos', (select count(*) from mo where kind = 'template' and status = 'read'),
      'modelos_falhados', (select count(*) from mo where kind = 'template' and status = 'failed'),
      'automaticas_entregues', (select count(*) from mo where kind <> 'template' and status in ('delivered', 'read')),
      'leads_contactadas', (select count(distinct lead_id) from mo where status in ('delivered', 'read')),
      'leads_responderam', (select count(distinct lead_id) from mi),
      'reativadas', (select count(*) from re),
      'reativadas_qualificadas', (select count(*) from re where exists (
          select 1 from public.lead_events e join public.lead_stages s on s.id = e.to_stage_id
           where e.lead_id = re.id and e.type = 'stage' and s.key = 'qualificada' and e.created_at >= re.reactivated_at)),
      'mais_tarde', (select count(distinct lead_id) from mi where lower(body) in ('talvez mais tarde', 'agora não', 'mais tarde')),
      'ja_nao', (select count(distinct lead_id) from mi where lower(body) in ('já comprei', 'já vendi', 'já não procuro', 'já não tenho interesse')),
      'nao_contactar', (select count(distinct lead_id) from mi where lower(body) = 'não quero contactos'),
      'texto', (select count(distinct lead_id) from mi where kind = 'text')
    ));
end $function$;

revoke all on function public.wa_dashboard_resumo(uuid, text, date, date) from public, anon;
grant execute on function public.wa_dashboard_resumo(uuid, text, date, date) to authenticated;
