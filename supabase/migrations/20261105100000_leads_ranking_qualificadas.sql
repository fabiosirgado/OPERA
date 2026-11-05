-- OPERA Leads: rankings de leads qualificadas no dashboard da OPERA (pedido do Fábio, 2026-11-05).
--
-- Por cliente, por gestor (quem qualificou) e por tipo de qualificação (Objetivo), no período do dashboard.
-- Conta cada lead uma vez: a primeira passagem a Lead Qualificada dentro do período. Fica de fora o histórico
-- importado (eventos com meta.imported). Uma lead pode ter vários tipos (ex.: "Comprador, Crédito").
-- Só a equipa OPERA vê.

create or replace function public.leads_qualified_ranking(p_client uuid default null, p_period text default '0',
                                                          p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_from timestamptz;
  v_to timestamptz := 'infinity'::timestamptz;
  v_qual uuid;
begin
  if not private.leads_is_opera() then raise exception 'Só a equipa OPERA vê os rankings.'; end if;
  if p_period = 'custom' then
    if p_from is null or p_to is null or p_to < p_from then raise exception 'Escolha um período válido.'; end if;
    v_from := p_from::timestamp at time zone 'Europe/Lisbon';
    v_to := (p_to + 1)::timestamp at time zone 'Europe/Lisbon';
  else
    v_from := case p_period when '1' then v_today when '7' then now() - interval '7 days'
                            when '30' then now() - interval '30 days' else '-infinity'::timestamptz end;
  end if;
  select id into v_qual from public.lead_stages where key = 'qualificada';

  return (
    with q as (
      select distinct on (e.lead_id) e.lead_id, e.author_id, l.client_id,
             private.leads_objetivo_tipos(l.qualification ->> 'Objetivo') as tipos
        from public.lead_events e join public.leads l on l.id = e.lead_id
       where e.type = 'stage' and e.to_stage_id = v_qual and e.created_at >= v_from and e.created_at < v_to
         and not (e.meta ? 'imported') and (p_client is null or l.client_id = p_client)
       order by e.lead_id, e.created_at
    ),
    t as (
      select q.*,
             ('Comprador' = any (tipos))::int as comprador, ('Proprietário' = any (tipos))::int as proprietario,
             ('Crédito' = any (tipos))::int as credito, ('Arrendamento' = any (tipos))::int as arrendamento,
             ('Senhorio' = any (tipos))::int as senhorio, (cardinality(tipos) = 0)::int as sem_tipo
        from q
    ),
    by_client as (
      select c.id, c.name, c.color, count(*) total, sum(comprador) comprador, sum(proprietario) proprietario,
             sum(credito) credito, sum(arrendamento) arrendamento, sum(senhorio) senhorio, sum(sem_tipo) sem_tipo
        from t join public.clients c on c.id = t.client_id group by c.id, c.name, c.color
    ),
    by_person as (
      select coalesce(p.full_name, 'Sem autor') as name, count(*) total, sum(comprador) comprador,
             sum(proprietario) proprietario, sum(credito) credito, sum(arrendamento) arrendamento,
             sum(senhorio) senhorio, sum(sem_tipo) sem_tipo
        from t left join public.profiles p on p.id = t.author_id group by 1
    )
    select jsonb_build_object(
      'total', (select count(*) from t),
      'types', (select jsonb_build_object('comprador', coalesce(sum(comprador), 0), 'proprietario', coalesce(sum(proprietario), 0),
                  'credito', coalesce(sum(credito), 0), 'arrendamento', coalesce(sum(arrendamento), 0),
                  'senhorio', coalesce(sum(senhorio), 0), 'sem_tipo', coalesce(sum(sem_tipo), 0)) from t),
      'by_client', (select coalesce(jsonb_agg(to_jsonb(b) order by b.total desc, b.name), '[]'::jsonb) from by_client b),
      'by_person', (select coalesce(jsonb_agg(to_jsonb(b) order by b.total desc, b.name), '[]'::jsonb) from by_person b))
  );
end;
$$;

revoke execute on function public.leads_qualified_ranking(uuid, text, date, date) from public, anon;
grant execute on function public.leads_qualified_ranking(uuid, text, date, date) to authenticated;
