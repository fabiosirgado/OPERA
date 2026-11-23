-- OPERA Leads, WhatsApp: resposta "mais tarde" ("Talvez mais tarde", "Agora não", "Mais tarde"), pedido do Fábio, 2026-11-23.
-- Antes (como na especificação) entrava logo na fila e recebia a R1 ("vamos entrar em contacto assim que possível"),
-- o que não fazia sentido para quem disse "agora não". Agora: recebe a R4 ("Combinado, falamos mais à frente"),
-- não entra hoje na fila, passa para Follow Up e fica com um follow up daqui a 15 dias (próximo dia de trabalho
-- para o cliente). Não conta como reativada (sem reactivated_at nem etiqueta).

create or replace function private.wa_texto(p_modelo text, p jsonb) returns text
language sql immutable set search_path = '' as $$
  select case p_modelo
    when 'D' then format('Olá %s, aqui é a equipa do %s. Há algum tempo procurava %s. Ainda está à procura? E para comprar, tem algum imóvel que precise de vender primeiro?', p ->> 'nome', p ->> 'consultor', p ->> 'interesse')
    when 'B' then format('Olá %s, aqui é a equipa do %s. Há algum tempo falou connosco sobre a venda de %s. Ainda pensa vender?', p ->> 'nome', p ->> 'consultor', p ->> 'interesse')
    when 'C' then format('Olá %s, aqui é a equipa do %s. Há algum tempo entrou em contacto connosco sobre um imóvel. Neste momento está a pensar comprar ou vender casa?', p ->> 'nome', p ->> 'consultor')
    when 'N' then format('Olá %s, aqui é a equipa do %s. Há uns dias pediu informações sobre %s e não conseguimos falar consigo. Ainda tem interesse?', p ->> 'nome', p ->> 'consultor', p ->> 'interesse')
    when 'M1' then format('Olá %s, aqui é a equipa do %s. Acabámos de lhe ligar sobre o seu pedido e voltamos a ligar assim que possível. Se preferir, escolha a melhor altura:', p ->> 'nome', p ->> 'consultor')
    when 'M3' then format('Olá %s, tentámos ligar agora e voltamos a ligar assim que possível. Se preferir, escolha a melhor altura:', p ->> 'nome')
    when 'R1' then format('Obrigado, %s! Vamos entrar em contacto consigo assim que possível.', p ->> 'nome')
    when 'R2' then format('Obrigado pela resposta, %s, e parabéns! Se precisar de alguma coisa no futuro, estamos por aqui.', p ->> 'nome')
    when 'R4' then format('Obrigado pela resposta, %s. Combinado, falamos mais à frente. Se precisar de alguma coisa antes, estamos por aqui.', p ->> 'nome')
    when 'R3' then format('Obrigado, %s. Não voltaremos a contactá-la.', p ->> 'nome')
  end;
$$;

create or replace function private.wa_resposta(p_lead uuid, p_tipo text, p_texto text, p_modelo text) returns jsonb
language plpgsql security definer set search_path = public as $$
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
end $$;
