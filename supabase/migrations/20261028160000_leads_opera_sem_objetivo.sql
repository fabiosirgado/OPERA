-- OPERA Leads: as leads do cliente interno (a própria OPERA) podem ser qualificadas sem Objetivo
-- (Comprador, Proprietário ou Crédito). Decisão do Fábio, 2026-10-28. Para os outros clientes, a regra fica.
create or replace function public.leads_require_objetivo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage_id is distinct from old.stage_id and not new.anonymized
     and (select key from public.lead_stages where id = new.stage_id) = 'qualificada'
     and coalesce((select position from public.lead_stages where id = old.stage_id), 0) < 50
     and not coalesce((select leads_internal from public.clients where id = new.client_id), false)
     and cardinality(private.leads_objetivo_tipos(new.qualification ->> 'Objetivo')) = 0 then
    raise exception 'Indica o Objetivo da lead (Comprador, Proprietário ou Crédito) antes de a qualificar.';
  end if;
  return new;
end;
$$;
revoke execute on function public.leads_require_objetivo() from public, anon, authenticated;
