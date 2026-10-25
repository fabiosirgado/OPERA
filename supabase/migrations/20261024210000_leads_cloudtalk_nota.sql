-- OPERA Leads: a análise da CloudTalk entra no histórico como uma nota normal, como no Pipedrive.
--
-- A chamada continua a guardar as partes em meta.ci (chegam em dois avisos: análise e transcrição).
-- Cada vez que chega uma parte, a nota "Resumo da chamada (CloudTalk)" dessa chamada é escrita de novo
-- com tudo o que já existe: resumo, notas inteligentes, sentimento e temas, e a transcrição.
create or replace function public.leads_cloudtalk_ci(p_call_id text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid; v_at timestamptz; v_ci jsonb; v_body text; v_note uuid;
begin
  update public.lead_events
     set meta = meta || jsonb_build_object('ci', coalesce(meta -> 'ci', '{}'::jsonb)
                || jsonb_strip_nulls(p) || jsonb_build_object('at', now()))
   where type = 'call' and meta ->> 'call_id' = p_call_id
     and not exists (select 1 from public.leads l where l.id = lead_id and l.anonymized)
  returning lead_id, created_at, meta -> 'ci' into v_lead, v_at, v_ci;
  -- Chamada que não é de nenhuma lead: a análise não se guarda (RGPD).
  if v_lead is null then
    return jsonb_build_object('status', 'sem_lead');
  end if;

  v_body := concat_ws(E'\n\n',
    nullif(trim(v_ci ->> 'summary'), ''),
    (select string_agg('• ' || x, E'\n') from jsonb_array_elements_text(coalesce(v_ci -> 'notes', '[]')) x),
    nullif(concat_ws(' · ',
      'Sentimento ' || case lower(v_ci ->> 'sentiment') when 'positive' then 'positivo' when 'neutral' then 'neutro'
                         when 'negative' then 'negativo' else nullif(v_ci ->> 'sentiment', '') end,
      'Temas: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(v_ci -> 'topics', '[]')) x)), ''),
    'Transcrição' || E'\n' || (select string_agg(coalesce(nullif(e ->> 's', '') || ': ', '') || (e ->> 'x'), E'\n')
                                 from jsonb_array_elements(coalesce(v_ci -> 'transcript', '[]')) e));

  select id into v_note from public.lead_events
   where lead_id = v_lead and type = 'note' and meta ->> 'ci_call_id' = p_call_id limit 1;
  if v_note is null then
    insert into public.lead_events (lead_id, type, title, body, meta, author_id, created_at)
    values (v_lead, 'note', 'Resumo da chamada (CloudTalk)', v_body,
            jsonb_build_object('via', 'cloudtalk', 'ci_call_id', p_call_id), null, v_at + interval '1 second');
  else
    update public.lead_events set body = v_body where id = v_note;
    -- Escrita pelo sistema: não aparece como "editada".
    update public.lead_events set edited_at = null where id = v_note;
  end if;
  return jsonb_build_object('status', 'processado', 'lead_id', v_lead);
end;
$$;
revoke execute on function public.leads_cloudtalk_ci(text, jsonb) from public, anon, authenticated;
grant execute on function public.leads_cloudtalk_ci(text, jsonb) to service_role;
