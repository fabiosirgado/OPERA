-- OPERA Leads: o cliente escreve notas e mexe nas suas leads em qualquer etapa (decisão do Fábio, 2026-10-28).
-- Antes só podia a partir de Lead Qualificada; as etapas anteriores eram só da OPERA.
-- Quando é o próprio cliente a qualificar uma lead, não há aviso ao cliente (email, mensagem, notificação)
-- nem a tarefa "Confirmar com o cliente": isso fica para quando é a OPERA a qualificar.

create or replace function private.leads_can_write(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.leads l
     where l.id = p_lead_id
       and ((private.leads_is_opera() and private.leads_client_active(l.client_id))
            or l.client_id = private.leads_my_client_id()));
$$;

drop policy "cliente edita leads qualificadas" on public.leads;
create policy "cliente edita as suas leads" on public.leads for update
  using (client_id = (select private.leads_my_client_id()))
  with check (client_id = (select private.leads_my_client_id()) and private.lead_stage_fits(stage_id, client_id));

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
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (new.id, 'followup', now() + interval '24 hours', 'Confirmar com o cliente', auth.uid());
    insert into public.lead_notifications (lead_id, kind) values (new.id, 'qualificada');
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (new.id, 'auto', 'Cliente vai ser avisado',
            'O resumo da lead segue por email para o responsável no cliente ou, sem responsável, para todos os utilizadores ativos do cliente.',
            auth.uid());
  end if;
  return null;
end;
$$;
