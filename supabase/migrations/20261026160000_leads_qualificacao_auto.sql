-- OPERA Leads: a nota da chamada escrita pelo Claude também preenche a qualificação da lead.
--
-- O Claude devolve, além da nota, o que ouviu na chamada para cada campo de qualificação (Objetivo, Budget, Prazo,
-- Financiamento, Tem imóvel para vender, Disponibilidade para visita). Só se preenchem os campos vazios: o que a
-- equipa já escreveu nunca muda. O que foi preenchido fica no histórico da lead.

drop function public.leads_cloudtalk_ai_note(text, text, text);
create function public.leads_cloudtalk_ai_note(p_call_id text, p_body text, p_model text, p_fields jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid; v_at timestamptz; v_author uuid; v_q jsonb; v_filled jsonb := '{}'::jsonb; k text; v text;
begin
  if nullif(trim(p_body), '') is null then raise exception 'Nota vazia.'; end if;
  select e.lead_id, e.created_at into v_lead, v_at
    from public.lead_events e join public.leads l on l.id = e.lead_id
   where e.type = 'call' and e.meta ->> 'call_id' = p_call_id and not l.anonymized
   order by e.created_at desc limit 1;
  if v_lead is null then return jsonb_build_object('status', 'sem_lead'); end if;
  select c.manager_id, l.qualification into v_author, v_q
    from public.leads l join public.clients c on c.id = l.client_id where l.id = v_lead for update of l;

  -- O resumo curto sai e entra a nota do Claude, com a mesma hora (o autor de uma nota não muda).
  delete from public.lead_events where lead_id = v_lead and type = 'note' and meta ->> 'ci_call_id' = p_call_id;
  insert into public.lead_events (lead_id, type, title, body, meta, author_id, created_at)
  values (v_lead, 'note', 'Resumo da chamada', trim(p_body),
          jsonb_build_object('via', 'cloudtalk', 'ci_call_id', p_call_id, 'ai', p_model), v_author, v_at + interval '1 second');

  -- Qualificação: só os campos conhecidos e só os que ainda estão vazios.
  for k, v in select key, left(trim(value), 200) from jsonb_each_text(coalesce(p_fields, '{}'::jsonb)) loop
    continue when k not in ('Objetivo', 'Budget', 'Prazo', 'Financiamento', 'Tem imóvel para vender', 'Disponibilidade para visita');
    continue when nullif(v, '') is null or nullif(trim(coalesce(v_q ->> k, '')), '') is not null;
    v_filled := v_filled || jsonb_build_object(k, v);
  end loop;
  if v_filled <> '{}'::jsonb then
    update public.leads set qualification = coalesce(qualification, '{}'::jsonb) || v_filled where id = v_lead;
    insert into public.lead_events (lead_id, type, title, body, meta, author_id, created_at)
    values (v_lead, 'auto', 'Qualificação preenchida pela nota da chamada',
            (select string_agg(key || ': ' || value, E'\n' order by key) from jsonb_each_text(v_filled)),
            jsonb_build_object('via', 'cloudtalk', 'ci_call_id', p_call_id, 'fields', v_filled), null, v_at + interval '2 seconds');
  end if;
  return jsonb_build_object('status', 'processado', 'lead_id', v_lead, 'preenchidos', v_filled);
end;
$$;
revoke execute on function public.leads_cloudtalk_ai_note(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.leads_cloudtalk_ai_note(text, text, text, jsonb) to service_role;
