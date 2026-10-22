-- OPERA Leads: as exportações ficam no registo de atividade (quem, quando, quantas leads).
-- O ficheiro é gerado no browser; esta função só regista e confirma que quem exporta pode ver essas leads.
create function public.leads_log_export(p_scope text, p_count integer, p_lead_id uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.leads_role() is null then raise exception 'Sem acesso ao OPERA Leads.'; end if;
  if p_lead_id is not null and not private.leads_can_read(p_lead_id) then raise exception 'Sem acesso a esta lead.'; end if;
  perform public.leads_audit(case when p_scope = 'titular' then 'pedido_titular_exportar' else 'exportacao' end,
                             jsonb_build_object('ambito', p_scope, 'leads', greatest(coalesce(p_count, 0), 0), 'lead_id', p_lead_id));
end;
$$;
revoke execute on function public.leads_log_export(text, integer, uuid) from public, anon;
