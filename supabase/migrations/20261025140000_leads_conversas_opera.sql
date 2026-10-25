-- OPERA Leads, Fase 8: o cliente interno (a própria OPERA) também tem conversa, como os outros clientes.
-- Serve para a equipa falar com os utilizadores que entram como cliente OPERA (e para testar as conversas).
-- Os KPI e o dashboard geral continuam sem o cliente interno; isto só muda as conversas e os avisos por email.

create or replace function public.leads_conversations()
returns table (client_id uuid, client_name text, client_color text, last_at timestamptz, last_body text,
               last_author text, unread integer)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.color, lm.created_at,
         case when lm.deleted_at is not null then 'Mensagem apagada' else left(private.leads_message_text(lm.body, lm.audio_seconds), 140) end,
         (select coalesce(p.full_name, p.email) from public.profiles p where p.id = lm.author_id),
         (select count(*)::int from public.client_messages m
           where m.client_id = c.id and m.deleted_at is null and m.author_id is distinct from auth.uid()
             and m.created_at > coalesce(r.last_read_at, '-infinity'))
    from public.clients c
    left join public.client_message_reads r on r.client_id = c.id and r.user_id = auth.uid()
    left join lateral (select m.* from public.client_messages m where m.client_id = c.id
                        order by m.created_at desc limit 1) lm on true
   where (private.leads_is_opera() and c.leads_enabled and c.leads_status = 'ativo')
      or c.id = private.leads_my_client_id()
   order by lm.created_at desc nulls last, c.name;
$$;

create or replace function private.leads_message_alerts() returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  insert into public.client_message_notifications (client_id, side, upto)
  select x.client_id, x.side, x.upto
    from (
      select m.client_id, s.side, max(m.created_at) upto
        from public.client_messages m
        join public.clients c on c.id = m.client_id and c.leads_enabled and c.leads_status = 'ativo'
        cross join lateral (select case private.leads_message_side(m.author_id) when 'opera' then 'cliente' else 'opera' end side) s
       where m.deleted_at is null and m.created_at <= now() - interval '15 minutes'
         and m.created_at > now() - interval '3 days'
         -- ninguém do outro lado leu a mensagem
         and not exists (select 1 from private.leads_message_readers(m.client_id, s.side) rd
                           join public.client_message_reads r on r.user_id = rd.id and r.client_id = m.client_id
                          where r.last_read_at >= m.created_at)
         -- ainda não avisado por esta mensagem
         and not exists (select 1 from public.client_message_notifications n
                          where n.client_id = m.client_id and n.side = s.side and n.upto >= m.created_at)
       group by m.client_id, s.side) x
   where exists (select 1 from private.leads_message_readers(x.client_id, x.side))
     and not exists (select 1 from public.client_message_notifications n
                      where n.client_id = x.client_id and n.side = x.side and n.created_at > now() - interval '1 hour');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function private.leads_message_alerts() from public, anon, authenticated;
