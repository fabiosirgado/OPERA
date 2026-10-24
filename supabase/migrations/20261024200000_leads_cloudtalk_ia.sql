-- OPERA Leads: resumo, notas inteligentes e transcrição das chamadas (Conversation Intelligence da CloudTalk).
--
-- A função leads-cloudtalk recebe transcript.ready e cidata.ready, vai buscar a análise à API da CloudTalk
-- e guarda-a na chamada registada na lead, em meta.ci:
--   { summary, notes: [texto], sentiment, topics: [texto], transcript: [{ s: quem, t: segundos, x: texto }], lang }
-- Vê-a quem vê a lead. Ao apagar os dados pessoais de uma lead, a análise também é apagada.

-- p_call_id: id da chamada na CloudTalk. p: a análise já normalizada pela função.
create function public.leads_cloudtalk_ci(p_call_id text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_lead uuid;
begin
  update public.lead_events
     set meta = meta || jsonb_build_object('ci', coalesce(meta -> 'ci', '{}'::jsonb)
                || jsonb_strip_nulls(p) || jsonb_build_object('at', now()))
   where type = 'call' and meta ->> 'call_id' = p_call_id
     and not exists (select 1 from public.leads l where l.id = lead_id and l.anonymized)
  returning lead_id into v_lead;
  -- Chamada que não é de nenhuma lead: a análise não se guarda (RGPD).
  return jsonb_build_object('status', case when v_lead is null then 'sem_lead' else 'processado' end, 'lead_id', v_lead);
end;
$$;
revoke execute on function public.leads_cloudtalk_ci(text, jsonb) from public, anon, authenticated;
grant execute on function public.leads_cloudtalk_ci(text, jsonb) to service_role;

-- Anonimização: além do texto, sai também a análise da chamada.
create or replace function private.leads_anonymize(p_lead_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('opera.leads_rpc', 'on', true);
  update public.leads
     set name = 'Titular apagado', phone = null, email = null, interest = null, source = null,
         qualification = '{}'::jsonb, owner_user_id = null, external_id = null, anonymized = true,
         stage_id = (select id from public.lead_stages where key = 'desq')
   where id = p_lead_id;
  delete from public.lead_label_links where lead_id = p_lead_id;
  delete from public.lead_events where lead_id = p_lead_id and type not in ('call', 'stage');
  update public.lead_events set title = null, body = null, pinned = false,
         meta = meta - 'recording_url' - 'notes' - 'ci'
   where lead_id = p_lead_id;
  delete from public.lead_tasks where lead_id = p_lead_id and done_at is null;
  update public.lead_tasks set note = null where lead_id = p_lead_id;
  insert into public.lead_events (lead_id, type, title, body, author_id)
  values (p_lead_id, 'auto', 'Dados pessoais apagados', 'Motivo: ' || p_reason, auth.uid());
end;
$$;
revoke execute on function private.leads_anonymize(uuid, text) from public, anon, authenticated;
