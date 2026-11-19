-- OPERA Leads, Fila: uma lead à espera do WhatsApp volta à fila quando alguém lhe marca uma chamada ou follow up
-- (pedido do Fábio, 2026-11-19). Sai da espera e a contagem de "não atendeu" recomeça.
-- A 2.ª tentativa automática da fila não é afetada: nesse momento a lead ainda não está à espera.
create or replace function private.lead_fila_volta()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type in ('call', 'followup') and new.done_at is null and new.canceled_at is null then
    update public.lead_fila set aguarda_whatsapp_at = null, sem_resposta = 0, updated_at = now()
     where lead_id = new.lead_id and aguarda_whatsapp_at is not null;
  end if;
  return null;
end;
$$;
revoke execute on function private.lead_fila_volta() from public, anon, authenticated;

create trigger lead_tasks_fila_volta after insert on public.lead_tasks
  for each row execute function private.lead_fila_volta();
