-- OPERA Leads: passar para Lead Qualificada deixa de criar o Follow up "Confirmar com o cliente" a 24 h
-- (decisão do Fábio, 2026-10-29). Continua a cancelar as tarefas em aberto e a avisar o cliente.

create or replace function public.leads_stage_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_key text; v_from numeric;
begin
  if new.stage_id is not distinct from old.stage_id then return null; end if;
  select key into v_key from public.lead_stages where id = new.stage_id;
  select position into v_from from public.lead_stages where id = old.stage_id;

  if v_key in ('qualificada', 'desq') then
    update public.lead_tasks set canceled_at = now()
     where lead_id = new.id and done_at is null and canceled_at is null;
  end if;

  -- Avisar o cliente só quando quem qualifica é a OPERA (ou o sistema), não o próprio cliente.
  if v_key = 'qualificada' and v_from < 50 and not new.anonymized
     and (auth.uid() is null or private.leads_is_opera()) then
    insert into public.lead_notifications (lead_id, kind) values (new.id, 'qualificada');
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (new.id, 'auto', 'Cliente vai ser avisado',
            'O resumo da lead segue por email para o responsável no cliente ou, sem responsável, para todos os utilizadores ativos do cliente.',
            auth.uid());
  end if;
  return null;
end;
$$;
