-- OPERA Leads: carregar várias vezes em Ligar para a mesma lead criava um registo de chamada por clique,
-- mas a CloudTalk só faz uma chamada. Os registos sem resultado contavam como tentativas a mais (no dashboard
-- e no contador da lead). Agora, enquanto a chamada anterior da CloudTalk ainda não tem resultado (até 3 minutos),
-- um novo clique não cria outro registo. E saem os registos repetidos que já existiam.

create or replace function public.leads_register_call(p_lead_id uuid, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (private.leads_is_opera() and private.leads_can_write(p_lead_id)) and auth.role() <> 'service_role' then
    raise exception 'Só a equipa OPERA regista chamadas.';
  end if;
  -- Clique repetido: a chamada anterior da CloudTalk ainda está à espera do resultado.
  if p_meta ->> 'via' = 'cloudtalk' and exists (
       select 1 from public.lead_events e
        where e.lead_id = p_lead_id and e.type = 'call' and e.meta ->> 'via' = 'cloudtalk'
          and e.meta ->> 'call_id' is null and e.created_at > now() - interval '3 minutes') then
    return;
  end if;
  perform private.leads_apply_call(p_lead_id,
    case when p_meta ->> 'via' = 'cloudtalk' then 'Chamada CloudTalk' else 'Chamada' end,
    p_meta, now(), auth.uid());
end;
$$;

-- Limpeza: um registo do botão sem resultado seguido, na mesma lead e até 3 minutos depois, de outra chamada
-- é um clique repetido. Sai, e o contador de tentativas da lead desce na mesma medida.
with dup as (
  delete from public.lead_events e
   where e.type = 'call' and e.meta ->> 'via' = 'cloudtalk' and e.meta ->> 'call_id' is null and not (e.meta ? 'imported')
     and exists (select 1 from public.lead_events x
                  where x.lead_id = e.lead_id and x.type = 'call' and x.id <> e.id
                    and x.created_at > e.created_at and x.created_at <= e.created_at + interval '3 minutes')
  returning e.lead_id
), n as (select lead_id, count(*) c from dup group by lead_id)
update public.leads l set attempts = greatest(l.attempts - n.c, 0) from n where l.id = n.lead_id;
