-- OPERA Leads, WhatsApp: duas regras pedidas pelo Fábio (2026-11-25), a partir do caso do Jorge Silva (Alberto
-- Liberal), que carregou em "Quero comprar", recebeu em 5 minutos a R1, uma chamada e a M3, e carregou depois em
-- "Não quero contactos" na mesma mensagem.
--   1. Ritmo: numa lead reativada, a M3 (botões de horário) só sai depois da 2.ª chamada sem resposta desde a
--      reativação, e não logo a seguir à primeira; só no dia do "Sim" ou no dia seguinte.
--   2. Engano: "Não quero contactos" até 24 horas depois de um "Sim" bloqueia na mesma, mas cria uma tarefa e um
--      aviso para o gestor rever se foi engano (a lead só é desbloqueada à mão, na ficha).
-- O resto das duas funções fica igual.

create or replace function private.wa_apos_chamada()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare l public.leads;
begin
  if new.type <> 'call' or coalesce(new.meta ->> 'answered', '') <> 'false' or coalesce(new.meta ->> 'direction', '') = 'incoming' then
    return null;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.meta ->> 'answered', '') = 'false' then return null; end if;
  select * into l from public.leads where id = new.lead_id;
  if l.id is null or not private.wa_cliente_ativo(l.client_id) then return null; end if;
  if l.reactivated_at is null and l.entry_stage in ('meta', 'imoveis')
     and (select count(*) from public.lead_events e where e.lead_id = l.id and e.type = 'call'
           and coalesce(e.meta ->> 'direction', '') <> 'incoming') = 1
     and private.wa_motivo_bloqueio(l.id, 'M1') is null then
    insert into public.wa_queue (lead_id, client_id, template, scheduled_for)
    values (l.id, l.client_id, 'M1', now() + interval '150 seconds')
    on conflict (lead_id) where template = 'M1' do nothing;
  elsif l.reactivated_at is not null and l.wa_status in ('respondeu_sim', 'respondeu_mais_tarde', 'respondeu_texto')
     -- Ritmo: só à 2.ª chamada sem resposta desde a reativação (a primeira chamada vem logo a seguir ao "Sim").
     and (select count(*) from public.lead_events e where e.lead_id = l.id and e.type = 'call'
           and coalesce(e.meta ->> 'direction', '') <> 'incoming' and coalesce(e.meta ->> 'answered', '') = 'false'
           and e.created_at >= l.reactivated_at) >= 2
     -- No dia do "Sim" ou no dia seguinte (dias de Lisboa).
     and (now() at time zone 'Europe/Lisbon')::date <= (l.reactivated_at at time zone 'Europe/Lisbon')::date + 1
     and not exists (select 1 from public.wa_queue q where q.lead_id = l.id and q.template = 'M3' and q.created_at >= l.reactivated_at)
     and private.wa_motivo_bloqueio(l.id, 'M3') is null then
    insert into public.wa_queue (lead_id, client_id, template, scheduled_for) values (l.id, l.client_id, 'M3', now());
  end if;
  return null;
end $function$;

create or replace function private.wa_resposta(p_lead uuid, p_tipo text, p_texto text, p_modelo text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  l public.leads; t text := lower(trim(coalesce(p_texto, ''))); v_nome text; v_dia date; v_sessao text;
  v_reat boolean;
begin
  select * into l from public.leads where id = p_lead for update;
  if l.id is null then return '{}'::jsonb; end if;
  v_nome := coalesce(private.wa_primeiro_nome(l.name), '');
  update public.leads set wa_replied_at = now(), wa_reply = left(p_texto, 500) where id = p_lead;
  insert into public.lead_events (lead_id, type, title, body, meta, author_id)
  values (p_lead, 'whatsapp',
          case when p_tipo = 'botao' then 'Respondeu no WhatsApp: ' || p_texto else 'Escreveu no WhatsApp' end,
          case when p_tipo = 'botao' then null else p_texto end,
          jsonb_build_object('direcao', 'in', 'modelo', p_modelo, 'tipo', p_tipo), null);
  if l.do_not_contact then return '{}'::jsonb; end if;
  v_reat := coalesce(p_modelo, l.wa_template) in ('D', 'B', 'C', 'N', 'B2', 'C2', 'D2');

  if p_tipo = 'botao' and t = 'assim que possível' then
    update public.leads set wa_asap_at = now(), new_at = now() where id = p_lead;
    update public.lead_fila set aguarda_whatsapp_at = null, updated_at = now() where lead_id = p_lead;
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (p_lead, 'call', now(), 'Pediu no WhatsApp para ligar assim que possível.', null);
    perform private.wa_avisar('Ligar já', p_lead, 'Pediu no WhatsApp para ligar assim que possível');
    return '{}'::jsonb;
  elsif p_tipo = 'botao' and t in ('amanhã de manhã', 'amanhã à tarde') then
    v_dia := private.wa_amanha(l.client_id);
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (p_lead, 'call',
            (v_dia + case when t = 'amanhã de manhã' then time '10:00' else time '14:00' end) at time zone 'Europe/Lisbon',
            case when t = 'amanhã de manhã' then 'Janela da manhã (10h às 13h), pedido no WhatsApp.'
                 else 'Janela da tarde (14h às 19h), pedido no WhatsApp.' end, null);
    return '{}'::jsonb;
  elsif p_tipo = 'botao' and t = 'já não tenho interesse' then
    update public.leads set wa_status = 'respondeu_ja_nao' where id = p_lead;
    perform private.wa_desqualificar(p_lead, 'Respondeu no WhatsApp: Já não tenho interesse.');
    return '{}'::jsonb;
  elsif p_tipo = 'botao' and t in ('procuro e tenho para vender', 'só procuro comprar', 'sim, quero vender', 'quero comprar',
                                   'quero vender', 'sim, tenho interesse') then
    if t = 'procuro e tenho para vender' then update public.leads set buy_and_sell = true where id = p_lead; end if;
    perform private.wa_reativar(p_lead, 'respondeu_sim', p_texto);
    v_sessao := 'R1';
  elsif p_tipo = 'botao' and t in ('talvez mais tarde', 'agora não', 'mais tarde') then
    -- "Mais tarde": não entra hoje na fila. Fica em Follow Up com um follow up daqui a 15 dias (no próximo dia em
    -- que alguém trabalha para o cliente) e recebe a R4 (pedido do Fábio, 2026-11-23).
    v_dia := (now() at time zone 'Europe/Lisbon')::date + 15;
    if not coalesce((select weekend_enabled from public.clients where id = l.client_id), false) then
      while not private.wa_dia_util(v_dia) loop v_dia := v_dia + 1; end loop;
    end if;
    update public.leads
       set wa_status = 'respondeu_mais_tarde', new_at = null, wa_asap_at = null,
           stage_id = case when (select s.position from public.lead_stages s where s.id = l.stage_id) < 40
                           then (select id from public.lead_stages where key = 'followup' and client_id is null) else stage_id end
     where id = p_lead;
    update public.lead_fila set aguarda_whatsapp_at = null, sem_resposta = 0, updated_at = now() where lead_id = p_lead;
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (p_lead, 'followup', (v_dia + time '23:59:59') at time zone 'Europe/Lisbon',
            'Respondeu "' || p_texto || '" no WhatsApp. Follow up combinado para daqui a 15 dias.', null);
    v_sessao := 'R4';
  elsif p_tipo = 'botao' and t in ('já comprei', 'já vendi', 'já não procuro') then
    update public.leads set wa_status = 'respondeu_ja_nao' where id = p_lead;
    perform private.wa_desqualificar(p_lead, 'Respondeu no WhatsApp: ' || p_texto || '.');
    v_sessao := 'R2';
  elsif p_tipo = 'botao' and t = 'não quero contactos' then
    update public.leads set wa_status = 'nao_contactar', do_not_contact = true where id = p_lead;
    update public.lead_tasks set canceled_at = now() where lead_id = p_lead and done_at is null and canceled_at is null;
    perform private.wa_desqualificar(p_lead, 'Pediu para não ser contactado.');
    -- Engano? Disse "Sim" há menos de 24 horas: fica bloqueada na mesma, mas o gestor revê.
    if l.wa_status = 'respondeu_sim' and l.wa_replied_at > now() - interval '24 hours' then
      insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
      values (p_lead, 'followup', now(),
              format('Rever se foi engano: respondeu "%s" às %s e %s min depois carregou em "Não quero contactos". A lead está bloqueada; se for engano, desbloquear na ficha.',
                     coalesce(l.wa_reply, 'Sim'), to_char(l.wa_replied_at at time zone 'Europe/Lisbon', 'HH24:MI'),
                     greatest(1, round(extract(epoch from (now() - l.wa_replied_at)) / 60))::int),
              null);
      perform private.wa_avisar('Rever: pode ter sido engano', p_lead,
                                'Disse "' || coalesce(l.wa_reply, 'Sim') || '" e logo depois "Não quero contactos"');
    end if;
    v_sessao := 'R3';
  else
    -- Resposta escrita (ou botão desconhecido): nunca respondemos por texto. Fica no histórico e cria uma tarefa de chamada.
    update public.leads
       set new_at = now(),
           wa_status = case when v_reat and wa_status not in ('respondeu_sim', 'respondeu_mais_tarde') then 'respondeu_texto' else wa_status end,
           reactivated_at = case when v_reat then coalesce(reactivated_at, now()) else reactivated_at end
     where id = p_lead;
    update public.lead_fila set aguarda_whatsapp_at = null, updated_at = now() where lead_id = p_lead;
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (p_lead, 'call', now(), 'Escreveu no WhatsApp: "' || left(coalesce(p_texto, ''), 300) || '". Ligar.', null);
    perform private.wa_avisar('Escreveu no WhatsApp', p_lead, left(coalesce(p_texto, ''), 120));
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('sessao', v_sessao, 'texto', private.wa_texto(v_sessao, jsonb_build_object('nome', v_nome)));
end $function$;
