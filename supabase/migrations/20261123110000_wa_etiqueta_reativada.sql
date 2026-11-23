-- OPERA Leads, WhatsApp: uma lead reativada pelo WhatsApp recebe a etiqueta "Lead reativada" (pedido do Fábio,
-- 2026-11-23), para se saber sempre que veio da reativação. As etiquetas são de cada cliente: a etiqueta é criada
-- no cliente da lead se ainda não existir (verde). Só acrescenta: uma função e um gatilho novos.
create or replace function private.wa_etiqueta_reativada() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_label uuid;
begin
  if new.reactivated_at is null or new.reactivated_at is not distinct from old.reactivated_at then return null; end if;
  select id into v_label from public.lead_labels
   where client_id = new.client_id and lower(name) = 'lead reativada' order by created_at limit 1;
  if v_label is null then
    insert into public.lead_labels (name, color, client_id) values ('Lead reativada', 'verde', new.client_id) returning id into v_label;
  end if;
  insert into public.lead_label_links (lead_id, label_id) values (new.id, v_label) on conflict do nothing;
  return null;
end $$;

drop trigger if exists leads_wa_etiqueta_reativada on public.leads;
create trigger leads_wa_etiqueta_reativada after update of reactivated_at on public.leads
  for each row execute function private.wa_etiqueta_reativada();
