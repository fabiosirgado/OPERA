-- OPERA Leads, WhatsApp: a resposta R3 ("Não quero contactos") deixa de ter género ("contactá-la" saiu a um homem
-- no primeiro dia do Alberto Liberal, 2026-11-24). Só muda o texto do R3; o resto da função fica igual.
create or replace function private.wa_texto(p_modelo text, p jsonb)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
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
    when 'R3' then format('Obrigado, %s. Não voltaremos a entrar em contacto.', p ->> 'nome')
  end;
$function$;
