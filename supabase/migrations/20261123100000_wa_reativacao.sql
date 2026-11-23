-- OPERA Leads, reativação por WhatsApp (especificação REATIVACAO_WHATSAPP de 23 nov 2026, Fase 1).
-- Só acrescenta: colunas novas com valores neutros, tabelas novas e funções novas. Tudo desligado por defeito:
-- leads_settings.wa_live = false e clients.wa_enabled = false em todos os clientes. Sem um cliente ligado
-- (wa_enabled, wa_consent_ok e ativo) não sai nenhuma mensagem.
-- Diferenças em relação à especificação, combinadas com o Fábio:
--   * lead_events aceita o tipo 'whatsapp' (a regra de tipos foi alargada, nada deixa de funcionar).
--   * A etapa de entrada (entry_stage) de uma lead não pode mudar (regra existente). A lead reativada fica
--     identificada por reactivated_at e pela etapa "Nova Lead Reativada" (criada só no arranque, com wa_live).
--   * phone_norm guarda o número nacional (9 dígitos); o envio usa 351 + phone_norm.
--   * As regras novas da Fila (cadência e ordem da secção 9.3) só valem para clientes com WhatsApp ligado e
--     com wa_live = true. Os outros clientes ficam exatamente como estavam.
--   * O M1 sai quando a CloudTalk regista a 1.ª chamada a uma lead nova como não atendida.
--   * Colunas extra: leads.wa_next_template (modelo do regresso: N ou B2/C2/D2) e leads.wa_asap_at
--     (pediu "Assim que possível": vai para o topo da fila).

-- ============================================================ COLUNAS NOVAS
alter table public.clients
  add column if not exists wa_enabled boolean not null default false,
  add column if not exists wa_consent_ok boolean not null default false,
  add column if not exists wa_consultant_name text,
  add column if not exists weekend_enabled boolean not null default false;

alter table public.leads
  add column if not exists wa_status text not null default 'nao_enviada'
    check (wa_status in ('nao_enviada', 'enviada', 'entregue', 'lida', 'respondeu_sim', 'respondeu_mais_tarde',
                         'respondeu_ja_nao', 'nao_contactar', 'respondeu_texto', 'falhou', 'sem_resposta',
                         'reativada_sem_contacto', 'so_fim_de_semana')),
  add column if not exists wa_template text check (wa_template in ('D', 'B', 'C', 'M1', 'N', 'B2', 'C2', 'D2')),
  add column if not exists wa_sent_at timestamptz,
  add column if not exists wa_replied_at timestamptz,
  add column if not exists wa_reply text,
  add column if not exists do_not_contact boolean not null default false,
  add column if not exists reactivated_at timestamptz,
  add column if not exists wa_next_send_at timestamptz,
  add column if not exists wa_next_template text check (wa_next_template in ('D', 'B', 'C', 'N', 'B2', 'C2', 'D2')),
  add column if not exists wa_no_reply_count integer not null default 0,
  add column if not exists wa_cycle integer not null default 0,
  add column if not exists weekend_only boolean not null default false,
  add column if not exists buy_and_sell boolean not null default false,
  add column if not exists wa_asap_at timestamptz;
create index if not exists leads_wa_next_send_idx on public.leads (wa_next_send_at) where wa_next_send_at is not null;
create index if not exists leads_wa_status_idx on public.leads (client_id, wa_status) where wa_status <> 'nao_enviada';

alter table public.lead_events drop constraint if exists lead_events_type_check;
alter table public.lead_events add constraint lead_events_type_check
  check (type = any (array['call', 'note', 'auto', 'stage', 'whatsapp']));

alter table public.leads_settings
  add column if not exists wa_live boolean not null default false,
  add column if not exists wa_per_client_daily integer not null default 20 check (wa_per_client_daily between 0 and 250),
  add column if not exists wa_daily_limit integer not null default 250 check (wa_daily_limit between 0 and 100000),
  add column if not exists wa_window_start time not null default '10:00',
  add column if not exists wa_window_end time not null default '13:00',
  add column if not exists wa_timezone text not null default 'Europe/Lisbon',
  add column if not exists wa_no_reply_days integer not null default 7 check (wa_no_reply_days between 1 and 60),
  add column if not exists wa_phone_number_id text,
  add column if not exists wa_waba_id text,
  add column if not exists wa_app_id text;

-- ============================================================ TABELAS NOVAS
create table if not exists public.wa_messages (
  id bigint generated always as identity primary key,
  lead_id uuid references public.leads (id) on delete cascade,
  client_id uuid references public.clients (id) on delete cascade,
  direction text not null check (direction in ('out', 'in')),
  kind text not null check (kind in ('template', 'session', 'button_reply', 'text', 'other')),
  template_name text,
  template text,
  body text,
  wa_message_id text unique,
  context_id text,
  queue_id bigint,
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  error text,
  phone text,
  created_at timestamptz not null default now(),
  status_at timestamptz
);
create index if not exists wa_messages_lead_idx on public.wa_messages (lead_id, created_at desc);
create index if not exists wa_messages_created_idx on public.wa_messages (created_at desc);
alter table public.wa_messages enable row level security;
-- Quem vê a lead vê as mensagens dela (a OPERA vê tudo; o cliente só as das suas leads).
create policy wa_messages_ler on public.wa_messages for select to authenticated
  using (exists (select 1 from public.leads l where l.id = wa_messages.lead_id));

create table if not exists public.wa_queue (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  template text not null check (template in ('D', 'B', 'C', 'N', 'M1', 'M3', 'B2', 'C2', 'D2')),
  variables jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null default now(),
  dia date not null default (now() at time zone 'Europe/Lisbon')::date,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  reason text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists wa_queue_due_idx on public.wa_queue (status, scheduled_for);
create index if not exists wa_queue_dia_idx on public.wa_queue (dia, client_id);
-- O M1 sai uma só vez por lead.
create unique index if not exists wa_queue_m1_unico on public.wa_queue (lead_id) where template = 'M1';
alter table public.wa_queue enable row level security;
create policy wa_queue_ler on public.wa_queue for select to authenticated using ((select private.leads_is_opera()));

create table if not exists public.wa_templates (
  code text primary key,
  name text not null unique,
  language text not null default 'pt_PT',
  status text,
  checked_at timestamptz
);
insert into public.wa_templates (code, name) values
  ('D', 'reativacao_comprador_venda'), ('B', 'reativacao_vendedor'), ('C', 'reativacao_geral'),
  ('N', 'reativacao_lead_recente'), ('M1', 'lead_nova_sem_resposta')
on conflict (code) do nothing;
alter table public.wa_templates enable row level security;
create policy wa_templates_ler on public.wa_templates for select to authenticated using ((select private.leads_is_opera()));

-- Feriados nacionais (sem envios de reativação). Acrescentar os anos seguintes quando chegarem.
create table if not exists private.wa_feriados (dia date primary key, nome text not null);
insert into private.wa_feriados (dia, nome) values
  ('2026-01-01', 'Ano Novo'), ('2026-04-03', 'Sexta-feira Santa'), ('2026-04-05', 'Páscoa'), ('2026-04-25', 'Dia da Liberdade'),
  ('2026-05-01', 'Dia do Trabalhador'), ('2026-06-04', 'Corpo de Deus'), ('2026-06-10', 'Dia de Portugal'),
  ('2026-08-15', 'Assunção de Nossa Senhora'), ('2026-10-05', 'Implantação da República'), ('2026-11-01', 'Todos os Santos'),
  ('2026-12-01', 'Restauração da Independência'), ('2026-12-08', 'Imaculada Conceição'), ('2026-12-25', 'Natal'),
  ('2027-01-01', 'Ano Novo'), ('2027-03-26', 'Sexta-feira Santa'), ('2027-03-28', 'Páscoa'), ('2027-04-25', 'Dia da Liberdade'),
  ('2027-05-01', 'Dia do Trabalhador'), ('2027-05-27', 'Corpo de Deus'), ('2027-06-10', 'Dia de Portugal'),
  ('2027-08-15', 'Assunção de Nossa Senhora'), ('2027-10-05', 'Implantação da República'), ('2027-11-01', 'Todos os Santos'),
  ('2027-12-01', 'Restauração da Independência'), ('2027-12-08', 'Imaculada Conceição'), ('2027-12-25', 'Natal')
on conflict (dia) do nothing;

-- Token de verificação do webhook da Meta, gerado aqui e guardado no cofre (nunca no código).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'wa_verify_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'wa_verify_token',
                                'Token de verificação do webhook do WhatsApp (Meta)');
  end if;
end $$;

-- ============================================================ FUNÇÕES DE APOIO
create or replace function private.wa_cliente_ativo(p_client uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select c.wa_enabled and c.wa_consent_ok and c.leads_status = 'ativo' and not c.leads_internal
                     from public.clients c where c.id = p_client), false);
$$;

-- Dia útil: não é sábado, domingo nem feriado nacional.
create or replace function private.wa_dia_util(p_dia date) returns boolean
language sql stable set search_path = public as $$
  select extract(isodow from p_dia) < 6 and not exists (select 1 from private.wa_feriados f where f.dia = p_dia);
$$;

-- "Amanhã" é o próximo dia em que alguém trabalha para o cliente: o dia seguinte para clientes com fim de semana,
-- o próximo dia útil para os outros.
create or replace function private.wa_amanha(p_client uuid) returns date
language plpgsql stable security definer set search_path = public as $$
declare v_dia date := (now() at time zone 'Europe/Lisbon')::date + 1; v_fds boolean;
begin
  select weekend_enabled into v_fds from public.clients where id = p_client;
  if coalesce(v_fds, false) then return v_dia; end if;
  while not private.wa_dia_util(v_dia) loop v_dia := v_dia + 1; end loop;
  return v_dia;
end $$;

create or replace function private.wa_primeiro_nome(p text) returns text
language sql immutable set search_path = '' as $$
  select case when w ~ '^[[:alpha:]][[:alpha:]''-]+$' and char_length(w) between 2 and 20 then initcap(lower(w)) end
    from (select split_part(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'), ' ', 1) as w) x;
$$;

-- Modelo da reativação pelo interesse: D (comprador), B (proprietário) ou C (geral).
create or replace function private.wa_modelo(p_interest text) returns text
language sql immutable set search_path = '' as $$
  select case when coalesce(p_interest, '') ~* '^\s*compra\s*:' or coalesce(p_interest, '') ~* 'comprador' then 'D'
              when coalesce(p_interest, '') ~* '^\s*venda\s*:' or coalesce(p_interest, '') ~* 'propriet' then 'B'
              else 'C' end;
$$;

-- Texto legível do interesse ("Compra: Apartamento T2 · Amadora" passa a "um apartamento T2 na zona de Amadora").
-- No B (proprietário) não se usa a zona (muitas vezes é a morada). Devolve null quando não dá um texto limpo.
create or replace function private.wa_interesse(p text, p_modelo text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text; v_tipos text; v_zona text; tipos text[]; tips text[]; obj text;
  re_tipo constant text := '(apartamento|apt|moradia|vivenda|terreno|loja|quinta|armaz[eé]m|escrit[oó]rio|casa)';
begin
  if p is null or trim(p) = '' then return null; end if;
  v := regexp_replace(trim(p), '^\s*(compra|venda)\s*:\s*', '', 'i');
  v := regexp_replace(v, '(compradores?|propriet[aá]rios?)', ' ', 'gi');
  v := trim(both ' -' from regexp_replace(v, '\s+', ' ', 'g'));
  if position('·' in v) > 0 then
    v_tipos := trim(split_part(v, '·', 1)); v_zona := nullif(trim(split_part(v, '·', 2)), '');
  else
    v_tipos := v; v_zona := null;
  end if;
  select array_agg(distinct case when t in ('apt') then 'apartamento' when t = 'vivenda' then 'moradia'
                                  when t like 'armaz%' then 'armazém' when t like 'escrit%' then 'escritório' else t end)
    into tipos from (select lower(m[1]) t from regexp_matches(v_tipos, re_tipo, 'gi') m) x;
  select array_agg(distinct upper(m[1])) into tips from regexp_matches(v_tipos, '(?:^|[^[:alnum:]])(t\d+\+?)', 'gi') m;
  if coalesce(array_length(tipos, 1), 0) = 1 then
    obj := case tipos[1] when 'apartamento' then 'um apartamento' when 'moradia' then 'uma moradia'
                         when 'terreno' then 'um terreno' when 'loja' then 'uma loja' when 'quinta' then 'uma quinta'
                         when 'armazém' then 'um armazém' when 'escritório' then 'um escritório' else 'uma casa' end;
  elsif coalesce(array_length(tipos, 1), 0) > 1 or coalesce(array_length(tips, 1), 0) > 0 then
    obj := 'uma casa';
  else
    return null;
  end if;
  if coalesce(array_length(tips, 1), 0) = 1 then obj := obj || ' ' || tips[1]; end if;
  if p_modelo = 'B' then return obj; end if;
  if v_zona is null then
    v_zona := regexp_replace(v_tipos, re_tipo, ' ', 'gi');
    v_zona := regexp_replace(v_zona, '(^|[^[:alnum:]])t\d+\+?', ' ', 'gi');
    v_zona := trim(both ' ,-' from regexp_replace(v_zona, '\s+', ' ', 'g'));
  end if;
  if coalesce(v_zona, '') = '' or v_zona ~ ',' or v_zona ~ '\d' or char_length(v_zona) > 30
     or v_zona !~ '^[[:alpha:] ''-]+$' then
    return obj;
  end if;
  v_zona := initcap(lower(v_zona));
  v_zona := replace(replace(replace(replace(replace(replace(v_zona, ' De ', ' de '), ' Da ', ' da '), ' Do ', ' do '),
                    ' Dos ', ' dos '), ' Das ', ' das '), ' E ', ' e ');
  return obj || ' na zona de ' || v_zona;
end $$;

-- Texto final de cada mensagem (pré visualização e histórico da lead). Igual aos modelos aprovados na Meta.
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
    when 'R3' then format('Obrigado, %s. Não voltaremos a contactá-la.', p ->> 'nome')
  end;
$$;

-- Modelo e variáveis de uma lead. Devolve {modelo, variaveis, texto} ou {motivo} quando não dá para enviar.
-- p_modelo: null (reativação: D, B ou C pelo interesse), 'N', 'M1', 'M3', 'B2', 'C2' ou 'D2'.
create or replace function private.wa_preparar(p_lead uuid, p_modelo text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l public.leads; c public.clients; v_nome text; v_mod text := p_modelo; v_int text; v jsonb;
begin
  select * into l from public.leads where id = p_lead;
  select * into c from public.clients where id = l.client_id;
  v_nome := private.wa_primeiro_nome(l.name);
  if v_nome is null then return jsonb_build_object('motivo', 'Nome em falta ou inválido'); end if;
  if coalesce(trim(c.wa_consultant_name), '') = '' and coalesce(v_mod, '') <> 'M3' then
    return jsonb_build_object('motivo', 'Falta o nome do consultor no cliente');
  end if;
  if v_mod is null then v_mod := private.wa_modelo(l.interest); end if;
  if v_mod in ('D', 'B', 'D2', 'B2') then
    v_int := private.wa_interesse(l.interest, left(v_mod, 1));
    if v_int is null then v_mod := case when v_mod like '%2' then 'C2' else 'C' end; end if;
  elsif v_mod = 'N' then
    v_int := coalesce(private.wa_interesse(l.interest, 'D'), 'um imóvel');
  end if;
  v := jsonb_strip_nulls(jsonb_build_object('nome', v_nome, 'consultor', trim(c.wa_consultant_name), 'interesse', v_int));
  return jsonb_build_object('modelo', v_mod, 'variaveis', v, 'texto', private.wa_texto(v_mod, v));
end $$;

-- Pode enviar este modelo a esta lead? Devolve null (sim) ou o motivo (não). Secção 7.6 da especificação.
create or replace function private.wa_motivo_bloqueio(p_lead uuid, p_modelo text) returns text
language plpgsql stable security definer set search_path = public as $$
declare l public.leads; v_pos numeric; v_key text;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then return 'Lead apagada'; end if;
  if l.anonymized then return 'Lead anonimizada'; end if;
  if not private.wa_cliente_ativo(l.client_id) then return 'WhatsApp desligado neste cliente'; end if;
  if l.do_not_contact then return 'Pediu para não ser contactado'; end if;
  if coalesce(l.phone_norm, '') !~ '^9[1236]\d{7}$' then return 'Sem telemóvel português'; end if;
  select s.position, s.key into v_pos, v_key from public.lead_stages s where s.id = l.stage_id;
  if v_pos >= 50 then return 'Lead já qualificada ou desqualificada'; end if;
  if p_modelo = 'M1' then
    if l.reactivated_at is not null or l.entry_stage not in ('meta', 'imoveis') then return 'Não é uma lead nova'; end if;
    if exists (select 1 from public.wa_messages m where m.lead_id = l.id and m.template = 'M1' and m.direction = 'out' and m.status <> 'failed') then
      return 'Já recebeu o M1';
    end if;
    if exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'call' and (e.meta ->> 'answered') = 'true') then
      return 'Já atendeu uma chamada';
    end if;
    return null;
  end if;
  if p_modelo = 'M3' then
    if not exists (select 1 from public.wa_messages m where m.lead_id = l.id and m.direction = 'in' and m.created_at > now() - interval '23 hours 50 minutes') then
      return 'Fora das 24 horas da última resposta';
    end if;
    return null;
  end if;
  -- Reativação (D, B, C, N e reenvios).
  if l.weekend_only then return 'Só para as chamadas do fim de semana'; end if;
  if l.wa_no_reply_count >= 3 then return '3 modelos sem resposta'; end if;
  if l.wa_cycle >= 2 then return '2 ciclos sem conseguir falar'; end if;
  if l.wa_next_send_at is not null and l.wa_next_send_at > now() then return 'Ainda não chegou a data do próximo envio'; end if;
  if l.wa_sent_at is not null and l.wa_next_send_at is null then return 'Já recebeu um modelo neste ciclo'; end if;
  if l.new_at is not null then return 'Lead nova por pegar'; end if;
  if l.next_task_at is not null then return 'Tem uma tarefa marcada'; end if;
  if exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'call' and (e.meta ->> 'answered') = 'true'
              and e.created_at > now() - interval '30 days') then
    return 'Atendeu uma chamada nos últimos 30 dias';
  end if;
  return null;
end $$;

-- Lead em condições de entrar na reativação (antes das regras da 7.6): importada numa etapa de BD,
-- ou com regresso marcado (14 ou 60 dias) já vencido.
create or replace function private.wa_candidata(p_lead uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (l.wa_next_send_at is not null and l.wa_next_send_at <= now() and s.position < 50)
        or (l.imported and l.wa_next_send_at is null and (s.key in ('meta', 'imoveis', 'bd') or (s.client_id is not null and s.position < 40)))
      from public.leads l join public.lead_stages s on s.id = l.stage_id where l.id = p_lead), false);
$$;

-- Notificação igual à de lead nova (telemóvel), para a equipa OPERA do cliente.
create or replace function private.wa_avisar(p_titulo text, p_lead uuid, p_corpo text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.leads;
begin
  select * into l from public.leads where id = p_lead;
  perform private.leads_push(
    array(select r.id from private.leads_message_readers(l.client_id, 'opera') r),
    p_titulo || ' · ' || coalesce(nullif(l.name, ''), 'Sem nome'), p_corpo,
    private.leads_app_link('lead=' || l.id), l.id::text);
exception when others then null; -- o aviso no telemóvel nunca impede o resto
end $$;

-- ============================================================ PLANO DO DIA (reativação)
-- Uma vez por dia útil, dentro da janela (10h às 13h): escolhe as leads de cada cliente com WhatsApp ligado
-- (20 por cliente, teto global 250 menos os M1 do dia, cortado por igual entre clientes) e espalha os envios
-- pela janela em lotes de 10 minutos. Fica tudo em wa_queue, para ver e controlar os envios do dia.
create or replace function public.wa_planear() returns integer
language plpgsql security definer set search_path = public as $$
declare
  s public.leads_settings; v_hoje date := (now() at time zone 'Europe/Lisbon')::date; v_agora time := (now() at time zone 'Europe/Lisbon')::time;
  v_inicio timestamptz; v_fim timestamptz; v_slots integer; v_global integer; v_total integer; v_n integer;
begin
  if not (auth.role() = 'service_role' or private.leads_role() = 'admin') then raise exception 'Sem acesso.'; end if;
  select * into s from public.leads_settings limit 1;
  if not private.wa_dia_util(v_hoje) or v_agora < s.wa_window_start or v_agora >= s.wa_window_end then return 0; end if;
  if exists (select 1 from public.wa_queue q where q.dia = v_hoje and q.template not in ('M1', 'M3')) then return 0; end if;
  v_global := s.wa_daily_limit - (select count(*) from public.wa_messages m where m.direction = 'out' and m.template = 'M1'
                                    and m.created_at >= (v_hoje::timestamp at time zone 'Europe/Lisbon'));
  if v_global <= 0 then return 0; end if;

  drop table if exists wa_plano;
  create temporary table wa_plano on commit drop as
  with cands as (
    select l.id, l.client_id, private.wa_preparar(l.id, l.wa_next_template) as prep,
           row_number() over (partition by l.client_id
                              order by (l.wa_next_send_at is null), l.wa_next_send_at, (l.attempts > 0),
                                       coalesce(l.source_created_at, l.created_at) desc) as rn
      from public.leads l
      join public.clients c on c.id = l.client_id
     where c.wa_enabled and c.wa_consent_ok and c.leads_status = 'ativo' and not c.leads_internal
       and private.wa_candidata(l.id)
       and private.wa_motivo_bloqueio(l.id, coalesce(l.wa_next_template, 'C')) is null
  ),
  ok as (
    select c.*, row_number() over (partition by c.client_id order by c.rn) as k
      from cands c
     where c.prep ->> 'motivo' is null
       and exists (select 1 from public.wa_templates t where t.code = c.prep ->> 'modelo' and t.status = 'APPROVED')
  )
  select o.id, o.client_id, o.prep, row_number() over (order by o.k, o.client_id) - 1 as ordem
    from ok o where o.k <= s.wa_per_client_daily
   order by o.k, o.client_id
   limit v_global;

  select count(*) into v_total from wa_plano;
  if v_total = 0 then return 0; end if;
  v_inicio := greatest(now(), (v_hoje + s.wa_window_start) at time zone 'Europe/Lisbon');
  v_fim := ((v_hoje + s.wa_window_end) at time zone 'Europe/Lisbon') - interval '10 minutes';
  v_slots := greatest(1, floor(extract(epoch from (v_fim - v_inicio)) / 600)::integer + 1);
  insert into public.wa_queue (lead_id, client_id, template, variables, scheduled_for, dia)
  select p.id, p.client_id, p.prep ->> 'modelo', p.prep -> 'variaveis',
         v_inicio + (floor(p.ordem * v_slots / v_total) * interval '10 minutes'), v_hoje
    from wa_plano p;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.wa_planear() from public, anon;
grant execute on function public.wa_planear() to authenticated, service_role;

-- ============================================================ ENVIO
-- Reserva os envios vencidos (no máximo p_limite), volta a confirmar cada um (regras da 7.6 e janela) e devolve
-- o que a função wa_send_batch tem de enviar. Os que já não podem sair ficam "skipped" com o motivo.
create or replace function public.wa_reservar(p_limite integer default 20) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.leads_settings; q public.wa_queue; v_motivo text; v_prep jsonb; v_out jsonb := '[]'::jsonb; v_tpl public.wa_templates;
  v_hoje date := (now() at time zone 'Europe/Lisbon')::date; v_agora time := (now() at time zone 'Europe/Lisbon')::time; v_phone text;
begin
  if auth.role() <> 'service_role' then raise exception 'Só o envio automático.'; end if;
  select * into s from public.leads_settings limit 1;
  for q in
    update public.wa_queue w set status = 'sending'
     where w.id in (select x.id from public.wa_queue x where x.status = 'pending' and x.scheduled_for <= now()
                     order by x.scheduled_for, x.id limit p_limite for update skip locked)
    returning w.*
  loop
    v_motivo := null;
    if q.template not in ('M1', 'M3') and (not private.wa_dia_util(v_hoje) or v_agora >= s.wa_window_end or q.dia <> v_hoje) then
      v_motivo := 'Fora da janela de envio';
    end if;
    v_motivo := coalesce(v_motivo, private.wa_motivo_bloqueio(q.lead_id, q.template));
    if v_motivo is null then
      v_prep := private.wa_preparar(q.lead_id, q.template);
      v_motivo := v_prep ->> 'motivo';
    end if;
    if v_motivo is null and q.template <> 'M3' then
      select * into v_tpl from public.wa_templates t where t.code = v_prep ->> 'modelo';
      if coalesce(v_tpl.status, '') <> 'APPROVED' then v_motivo := 'Modelo ' || (v_prep ->> 'modelo') || ' ainda não aprovado na Meta'; end if;
    end if;
    if v_motivo is not null then
      update public.wa_queue set status = 'skipped', reason = v_motivo where id = q.id;
      continue;
    end if;
    update public.wa_queue set template = v_prep ->> 'modelo', variables = v_prep -> 'variaveis' where id = q.id;
    select '351' || phone_norm into v_phone from public.leads where id = q.lead_id;
    v_out := v_out || jsonb_build_object('queue_id', q.id, 'lead_id', q.lead_id, 'to', v_phone, 'modelo', v_prep ->> 'modelo',
               'template_name', v_tpl.name, 'language', coalesce(v_tpl.language, 'pt_PT'),
               'variaveis', v_prep -> 'variaveis', 'texto', v_prep ->> 'texto');
  end loop;
  return v_out;
end $$;
revoke execute on function public.wa_reservar(integer) from public, anon, authenticated;
grant execute on function public.wa_reservar(integer) to service_role;

-- Resultado de um envio da fila (modelo ou M3).
create or replace function public.wa_registar_envio(p_queue bigint, p_wa_id text, p_erro text default null) returns void
language plpgsql security definer set search_path = public as $$
declare q public.wa_queue; v_texto text; v_kind text; v_tpl text; v_falhas integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Só o envio automático.'; end if;
  select * into q from public.wa_queue where id = p_queue;
  if q.id is null then return; end if;
  v_texto := private.wa_texto(q.template, q.variables);
  v_kind := case when q.template = 'M3' then 'session' else 'template' end;
  select name into v_tpl from public.wa_templates where code = q.template;
  insert into public.wa_messages (lead_id, client_id, direction, kind, template_name, template, body, wa_message_id, queue_id,
                                  status, error, status_at, phone)
  values (q.lead_id, q.client_id, 'out', v_kind, v_tpl, q.template, v_texto, p_wa_id, q.id,
          case when p_erro is null then 'sent' else 'failed' end, p_erro, now(),
          (select '351' || phone_norm from public.leads where id = q.lead_id));
  if p_erro is null then
    update public.wa_queue set status = 'sent', sent_at = now(), reason = null where id = q.id;
    if q.template <> 'M3' then
      update public.leads set wa_status = 'enviada', wa_template = q.template, wa_sent_at = now(),
                              wa_next_send_at = null, wa_next_template = null
       where id = q.lead_id;
    end if;
    insert into public.lead_events (lead_id, type, title, body, meta, author_id)
    values (q.lead_id, 'whatsapp', 'WhatsApp enviado · ' || case q.template when 'M3' then 'mensagem M3' else 'modelo ' || q.template end,
            v_texto, jsonb_build_object('direcao', 'out', 'modelo', q.template, 'wa_message_id', p_wa_id, 'estado', 'sent'), null);
  else
    update public.wa_queue set status = 'failed', reason = left(p_erro, 300) where id = q.id;
    select count(*) into v_falhas from (select status from public.wa_messages
                                          where lead_id = q.lead_id and direction = 'out' order by created_at desc limit 3) x
     where x.status = 'failed';
    if v_falhas >= 3 then
      update public.leads set wa_status = 'falhou' where id = q.lead_id and wa_status not in ('nao_contactar');
    end if;
  end if;
end $$;
revoke execute on function public.wa_registar_envio(bigint, text, text) from public, anon, authenticated;
grant execute on function public.wa_registar_envio(bigint, text, text) to service_role;

-- Resposta automática (R1, R2 ou R3) enviada pela função depois de uma resposta da lead.
create or replace function public.wa_registar_sessao(p_lead uuid, p_codigo text, p_texto text, p_wa_id text, p_erro text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Só o envio automático.'; end if;
  insert into public.wa_messages (lead_id, client_id, direction, kind, template, body, wa_message_id, status, error, status_at, phone)
  select p_lead, l.client_id, 'out', 'session', p_codigo, p_texto, p_wa_id, case when p_erro is null then 'sent' else 'failed' end,
         p_erro, now(), '351' || l.phone_norm
    from public.leads l where l.id = p_lead;
  if p_erro is null then
    insert into public.lead_events (lead_id, type, title, body, meta, author_id)
    values (p_lead, 'whatsapp', 'WhatsApp enviado · resposta automática ' || p_codigo, p_texto,
            jsonb_build_object('direcao', 'out', 'modelo', p_codigo, 'wa_message_id', p_wa_id, 'estado', 'sent'), null);
  end if;
end $$;
revoke execute on function public.wa_registar_sessao(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.wa_registar_sessao(uuid, text, text, text, text) to service_role;

-- ============================================================ RESPOSTAS DA LEAD (secção 7)
create or replace function private.wa_desqualificar(p_lead uuid, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.leads set stage_id = (select id from public.lead_stages where key = 'desq' and client_id is null), new_at = null, wa_asap_at = null
   where id = p_lead;
  insert into public.lead_events (lead_id, type, title, body, author_id)
  values (p_lead, 'auto', 'Desqualificada pelo WhatsApp', p_motivo, null);
end $$;

create or replace function private.wa_reativar(p_lead uuid, p_estado text, p_resposta text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.leads
     set wa_status = p_estado, reactivated_at = now(), new_at = now(), wa_asap_at = null,
         stage_id = coalesce((select id from public.lead_stages where key = 'reativada' and client_id is null), stage_id)
   where id = p_lead;
  update public.lead_fila set aguarda_whatsapp_at = null, sem_resposta = 0, updated_at = now() where lead_id = p_lead;
  insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
  values (p_lead, 'call', now(), 'Reativada pelo WhatsApp: "' || p_resposta || '". Ligar já.', null);
  perform private.wa_avisar(case when p_estado = 'respondeu_sim' then 'Lead reativada' else 'Lead reativada (mais tarde)' end,
                            p_lead, 'Respondeu no WhatsApp: ' || p_resposta);
end $$;

-- Trata uma resposta (botão ou texto). Devolve {sessao: 'R1' | 'R2' | 'R3' | null, texto}.
-- p_modelo: o modelo a que a lead respondeu (D, B, C, N, M1 ou M3).
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
    perform private.wa_reativar(p_lead, 'respondeu_mais_tarde', p_texto);
    v_sessao := 'R1';
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

-- Evento do webhook da Meta (o "value" de uma alteração do campo messages). Atualiza estados de entrega,
-- regista as respostas (uma só vez por wa_message_id) e devolve as respostas automáticas a enviar.
create or replace function public.wa_receber(p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  st jsonb; msg jsonb; m public.wa_messages; v_novo text; v_lead uuid; v_mod text; v_tipo text; v_texto text; v_kind text;
  v_ctx text; v_id bigint; v_r jsonb; v_out jsonb := '[]'::jsonb;
  ordem constant jsonb := '{"queued":0,"sent":1,"delivered":2,"read":3,"failed":4,"received":0}'::jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'Só o webhook.'; end if;
  for st in select * from jsonb_array_elements(coalesce(p_value -> 'statuses', '[]'::jsonb)) loop
    v_novo := st ->> 'status';
    if v_novo not in ('sent', 'delivered', 'read', 'failed') then continue; end if;
    update public.wa_messages w
       set status = v_novo, status_at = coalesce(to_timestamp((st ->> 'timestamp')::bigint), now()),
           error = coalesce(nullif(concat_ws(' · ', st -> 'errors' -> 0 ->> 'code', st -> 'errors' -> 0 ->> 'title',
                                             st -> 'errors' -> 0 -> 'error_data' ->> 'details'), ''), w.error)
     where w.wa_message_id = st ->> 'id' and w.direction = 'out'
       and ((ordem ->> v_novo)::int > (ordem ->> w.status)::int)
    returning * into m;
    if m.id is null then continue; end if;
    update public.lead_events set meta = meta || jsonb_build_object('estado', v_novo)
     where lead_id = m.lead_id and type = 'whatsapp' and meta ->> 'wa_message_id' = m.wa_message_id;
    if m.kind = 'template' and m.lead_id is not null then
      update public.leads
         set wa_status = case v_novo when 'delivered' then 'entregue' when 'read' then 'lida' when 'failed' then 'falhou' else wa_status end
       where id = m.lead_id and wa_template = m.template
         and ((v_novo in ('delivered', 'read') and wa_status in ('enviada', 'entregue'))
              or (v_novo = 'failed' and wa_status in ('enviada', 'entregue', 'lida')));
    end if;
    m := null;
  end loop;

  for msg in select * from jsonb_array_elements(coalesce(p_value -> 'messages', '[]'::jsonb)) loop
    v_tipo := msg ->> 'type';
    v_texto := case v_tipo when 'text' then msg -> 'text' ->> 'body'
                           when 'button' then msg -> 'button' ->> 'text'
                           when 'interactive' then coalesce(msg -> 'interactive' -> 'button_reply' ->> 'title',
                                                            msg -> 'interactive' -> 'list_reply' ->> 'title') end;
    v_kind := case when v_tipo in ('button', 'interactive') then 'button_reply' when v_tipo = 'text' then 'text' else 'other' end;
    v_ctx := msg -> 'context' ->> 'id';
    v_lead := null; v_mod := null;
    select w.lead_id, w.template into v_lead, v_mod from public.wa_messages w where w.wa_message_id = v_ctx and w.direction = 'out';
    if v_lead is null then
      select l.id, l.wa_template into v_lead, v_mod from public.leads l
       where l.phone_norm = private.leads_normalize_phone(msg ->> 'from') and not l.anonymized and private.wa_cliente_ativo(l.client_id)
       order by l.wa_sent_at desc nulls last, l.updated_at desc limit 1;
    end if;
    v_id := null;
    insert into public.wa_messages (lead_id, client_id, direction, kind, body, wa_message_id, context_id, status, phone, created_at)
    values (v_lead, (select client_id from public.leads where id = v_lead), 'in', v_kind, coalesce(v_texto, '[' || coalesce(v_tipo, '?') || ']'),
            msg ->> 'id', v_ctx, 'received', msg ->> 'from', coalesce(to_timestamp((msg ->> 'timestamp')::bigint), now()))
    on conflict (wa_message_id) do nothing
    returning id into v_id;
    -- Repetido (a Meta reenvia eventos), sem lead ou sem texto: não faz mais nada.
    if v_id is null or v_lead is null or v_texto is null then continue; end if;
    v_r := private.wa_resposta(v_lead, case when v_kind = 'button_reply' then 'botao' else 'texto' end, v_texto, v_mod);
    if v_r ->> 'sessao' is not null then
      v_out := v_out || jsonb_build_object('lead_id', v_lead, 'to', msg ->> 'from', 'codigo', v_r ->> 'sessao', 'texto', v_r ->> 'texto');
    end if;
  end loop;
  return jsonb_build_object('respostas', v_out);
end $$;
revoke execute on function public.wa_receber(jsonb) from public, anon, authenticated;
grant execute on function public.wa_receber(jsonb) to service_role;

-- ============================================================ CHAMADA NÃO ATENDIDA: M1 e M3
-- M1: 1.ª chamada a uma lead nova não atendida (CloudTalk), 2 a 3 minutos depois, uma só vez por lead.
-- M3: chamada não atendida a uma lead reativada no próprio dia (mensagem de sessão, grátis).
create or replace function private.wa_apos_chamada() returns trigger
language plpgsql security definer set search_path = public as $$
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
     and (now() at time zone 'Europe/Lisbon')::date = (l.reactivated_at at time zone 'Europe/Lisbon')::date
     and not exists (select 1 from public.wa_queue q where q.lead_id = l.id and q.template = 'M3' and q.created_at >= l.reactivated_at)
     and private.wa_motivo_bloqueio(l.id, 'M3') is null then
    insert into public.wa_queue (lead_id, client_id, template, scheduled_for) values (l.id, l.client_id, 'M3', now());
  end if;
  return null;
end $$;
drop trigger if exists lead_events_wa_chamada on public.lead_events;
create trigger lead_events_wa_chamada after insert or update of meta on public.lead_events
  for each row execute function private.wa_apos_chamada();

-- ============================================================ SEM RESPOSTA EM 7 DIAS (todos os dias às 20h UTC)
create or replace function private.wa_sem_resposta() returns integer
language plpgsql security definer set search_path = public as $$
declare s public.leads_settings; r record; v_n integer := 0;
begin
  select * into s from public.leads_settings limit 1;
  for r in
    update public.leads l
       set wa_no_reply_count = l.wa_no_reply_count + 1,
           wa_status = case when l.wa_no_reply_count + 1 >= 3 then 'so_fim_de_semana' else 'sem_resposta' end,
           weekend_only = l.weekend_only or l.wa_no_reply_count + 1 >= 3,
           wa_next_send_at = case when l.wa_no_reply_count + 1 >= 3 then null else now() + interval '60 days' end,
           wa_next_template = case when l.wa_no_reply_count + 1 >= 3 then null
                                   when l.wa_template in ('D', 'D2') then 'D2' when l.wa_template in ('B', 'B2') then 'B2' else 'C2' end
     where l.wa_status in ('entregue', 'lida') and l.wa_template in ('D', 'B', 'C', 'N', 'B2', 'C2', 'D2')
       and l.wa_sent_at < now() - make_interval(days => s.wa_no_reply_days)
    returning l.id, l.wa_status
  loop
    update public.lead_fila set aguarda_whatsapp_at = null, updated_at = now() where lead_id = r.id;
    insert into public.lead_events (lead_id, type, title, body, author_id)
    values (r.id, 'auto', 'WhatsApp sem resposta',
            case when r.wa_status = 'so_fim_de_semana' then '3 mensagens sem resposta: deixa de receber WhatsApp e fica para as chamadas do fim de semana.'
                 else 'Sem resposta em ' || s.wa_no_reply_days || ' dias. Fica disponível para chamadas; nova mensagem daqui a 60 dias, quando houver modelo de reenvio.' end,
            null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ============================================================ AGENDAMENTO (pg_cron + pg_net)
-- A cada minuto chama a função wa_send_batch, mas só quando há pelo menos um cliente com WhatsApp ligado.
create or replace function private.wa_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text;
begin
  select value into v_url from private.leads_config where key = 'functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'leads_inbound_secret';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(url := v_url || '/wa_send_batch',
                        headers := jsonb_build_object('Content-Type', 'application/json', 'x-opera-secret', v_key),
                        body := '{"action": "process"}'::jsonb, timeout_milliseconds := 55000);
end $$;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('wa_envios', 'wa_sem_resposta');
  perform cron.schedule('wa_envios', '* * * * *',
    $c$ select private.wa_kick() where exists (select 1 from public.clients where wa_enabled and wa_consent_ok and leads_status = 'ativo') $c$);
  perform cron.schedule('wa_sem_resposta', '0 20 * * *', $c$ select private.wa_sem_resposta() $c$);
end $$;

-- Configuração para as funções do WhatsApp (só o servidor): ids da Meta e token de verificação do webhook.
create or replace function public.wa_config() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('phone_number_id', s.wa_phone_number_id, 'waba_id', s.wa_waba_id, 'app_id', s.wa_app_id,
                            'verify_token', (select decrypted_secret from vault.decrypted_secrets where name = 'wa_verify_token'),
                            'functions_url', (select value from private.leads_config where key = 'functions_url'))
    from public.leads_settings s limit 1;
$$;
revoke execute on function public.wa_config() from public, anon, authenticated;
grant execute on function public.wa_config() to service_role;

create or replace function public.wa_templates_atualizar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Só o servidor.'; end if;
  update public.wa_templates t set status = x.status, language = coalesce(x.language, t.language), checked_at = now()
    from jsonb_to_recordset(p) as x(name text, status text, language text)
   where x.name = t.name;
  update public.wa_templates set checked_at = now() where checked_at is null or checked_at < now() - interval '1 minute';
end $$;
revoke execute on function public.wa_templates_atualizar(jsonb) from public, anon, authenticated;
grant execute on function public.wa_templates_atualizar(jsonb) to service_role;

-- ============================================================ ECRÃ "WHATSAPP" (só admin)
create or replace function private.wa_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not (private.leads_is_opera() and private.leads_role() = 'admin') then raise exception 'Só o administrador.'; end if;
end $$;

create or replace function public.wa_painel() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_hoje date := (now() at time zone 'Europe/Lisbon')::date; v_ini timestamptz := (v_hoje::timestamp at time zone 'Europe/Lisbon');
begin
  perform private.wa_admin();
  return jsonb_build_object(
    'definicoes', (select jsonb_build_object('wa_live', s.wa_live, 'wa_per_client_daily', s.wa_per_client_daily,
                     'wa_daily_limit', s.wa_daily_limit, 'wa_window_start', to_char(s.wa_window_start, 'HH24:MI'),
                     'wa_window_end', to_char(s.wa_window_end, 'HH24:MI'), 'wa_no_reply_days', s.wa_no_reply_days,
                     'ligada_meta', s.wa_phone_number_id is not null and s.wa_waba_id is not null)
                     from public.leads_settings s limit 1),
    'modelos', (select jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'status', t.status, 'checked_at', t.checked_at) order by t.code)
                  from public.wa_templates t),
    'etapa_reativada', exists (select 1 from public.lead_stages where key = 'reativada' and client_id is null),
    'dia_util', private.wa_dia_util(v_hoje),
    'clientes', (select jsonb_agg(jsonb_build_object(
                   'id', c.id, 'name', c.name, 'color', c.color, 'wa_enabled', c.wa_enabled, 'wa_consent_ok', c.wa_consent_ok,
                   'wa_consultant_name', c.wa_consultant_name, 'weekend_enabled', c.weekend_enabled,
                   'enviadas_hoje', (select count(*) from public.wa_messages m where m.client_id = c.id and m.direction = 'out'
                                       and m.kind = 'template' and m.status <> 'failed' and m.created_at >= v_ini),
                   'na_fila_hoje', (select count(*) from public.wa_queue q where q.client_id = c.id and q.dia = v_hoje and q.status = 'pending'))
                   order by c.name)
                   from public.clients c where c.id in (select private.leads_active_client_ids()) and not c.leads_internal),
    'hoje', (select jsonb_build_object('pendentes', count(*) filter (where status = 'pending'), 'enviadas', count(*) filter (where status = 'sent'),
                                       'ignoradas', count(*) filter (where status = 'skipped'), 'falhadas', count(*) filter (where status = 'failed'))
               from public.wa_queue where dia = v_hoje));
end $$;
revoke execute on function public.wa_painel() from public, anon;
grant execute on function public.wa_painel() to authenticated;

-- Pré visualização de um cliente: leads elegíveis por modelo, motivos de bloqueio e 10 mensagens de exemplo.
create or replace function public.wa_previsao(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.wa_admin();
  with c as (
    select l.id, l.name, l.wa_next_template, private.wa_motivo_bloqueio(l.id, coalesce(l.wa_next_template, 'C')) as motivo
      from public.leads l where l.client_id = p_client and private.wa_candidata(l.id)
  ), p as (
    select c.*, case when c.motivo is null then private.wa_preparar(c.id, c.wa_next_template) end as prep from c
  ), ok as (select * from p where motivo is null and prep ->> 'motivo' is null)
  select jsonb_build_object(
    'candidatas', (select count(*) from p),
    'elegiveis', (select count(*) from ok),
    'por_modelo', coalesce((select jsonb_object_agg(k, n) from (select prep ->> 'modelo' k, count(*) n from ok group by 1) x), '{}'::jsonb),
    'bloqueadas', coalesce((select jsonb_object_agg(k, n) from (select coalesce(motivo, prep ->> 'motivo') k, count(*) n from p
                                                                 where motivo is not null or prep ->> 'motivo' is not null group by 1) y), '{}'::jsonb),
    'exemplos', coalesce((select jsonb_agg(jsonb_build_object('lead', z.name, 'modelo', z.prep ->> 'modelo', 'texto', z.prep ->> 'texto'))
                            from (select * from ok order by random() limit 10) z), '[]'::jsonb))
    into v;
  return v;
end $$;
revoke execute on function public.wa_previsao(uuid) from public, anon;
grant execute on function public.wa_previsao(uuid) to authenticated;

create or replace function public.wa_cliente_definir(p_client uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c public.clients;
begin
  perform private.wa_admin();
  update public.clients
     set wa_enabled = coalesce((p ->> 'wa_enabled')::boolean, wa_enabled),
         wa_consent_ok = coalesce((p ->> 'wa_consent_ok')::boolean, wa_consent_ok),
         wa_consultant_name = case when p ? 'wa_consultant_name' then nullif(trim(p ->> 'wa_consultant_name'), '') else wa_consultant_name end,
         weekend_enabled = coalesce((p ->> 'weekend_enabled')::boolean, weekend_enabled)
   where id = p_client
  returning * into c;
  if c.wa_enabled and not c.wa_consent_ok then raise exception 'Marca primeiro o consentimento verificado.'; end if;
  if c.wa_enabled and coalesce(c.wa_consultant_name, '') = '' then raise exception 'Escreve primeiro o nome do consultor.'; end if;
end $$;
revoke execute on function public.wa_cliente_definir(uuid, jsonb) from public, anon;
grant execute on function public.wa_cliente_definir(uuid, jsonb) to authenticated;

create or replace function public.wa_definicoes_guardar(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.wa_admin();
  update public.leads_settings
     set wa_per_client_daily = coalesce((p ->> 'wa_per_client_daily')::integer, wa_per_client_daily),
         wa_daily_limit = coalesce((p ->> 'wa_daily_limit')::integer, wa_daily_limit),
         wa_window_start = coalesce((p ->> 'wa_window_start')::time, wa_window_start),
         wa_window_end = coalesce((p ->> 'wa_window_end')::time, wa_window_end),
         wa_no_reply_days = coalesce((p ->> 'wa_no_reply_days')::integer, wa_no_reply_days),
         updated_at = now(), updated_by = auth.uid();
end $$;
revoke execute on function public.wa_definicoes_guardar(jsonb) from public, anon;
grant execute on function public.wa_definicoes_guardar(jsonb) to authenticated;

-- Dia de arranque: liga wa_live e cria a etapa "Nova Lead Reativada" (se ainda não existir).
create or replace function public.wa_ligar(p_live boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.wa_admin();
  update public.leads_settings set wa_live = p_live, updated_at = now(), updated_by = auth.uid();
  if p_live and not exists (select 1 from public.lead_stages where key = 'reativada') then
    insert into public.lead_stages (key, name, position, owner, is_base, color)
    values ('reativada', 'Nova Lead Reativada', 25, 'opera', true, '#16A34A');
  end if;
end $$;
revoke execute on function public.wa_ligar(boolean) from public, anon;
grant execute on function public.wa_ligar(boolean) to authenticated;

create or replace function public.wa_fila_hoje() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform private.wa_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'lead_id', q.lead_id, 'lead', l.name, 'cliente', c.name, 'cor', c.color,
                     'modelo', q.template, 'estado', q.status, 'motivo', q.reason, 'quando', q.scheduled_for, 'enviada', q.sent_at,
                     'texto', private.wa_texto(q.template, q.variables)) order by q.scheduled_for, q.id)
                     from public.wa_queue q join public.leads l on l.id = q.lead_id join public.clients c on c.id = q.client_id
                    where q.dia >= (now() at time zone 'Europe/Lisbon')::date - 1), '[]'::jsonb);
end $$;
revoke execute on function public.wa_fila_hoje() from public, anon;
grant execute on function public.wa_fila_hoje() to authenticated;

-- Bloqueio manual de contacto na ficha da lead (a resposta "Não quero contactos" faz o mesmo sozinha).
create or replace function public.wa_bloquear(p_lead uuid, p_bloquear boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (private.leads_is_opera() and private.leads_can_write(p_lead)) then raise exception 'Sem acesso a esta lead.'; end if;
  update public.leads set do_not_contact = p_bloquear,
         wa_status = case when p_bloquear then 'nao_contactar' when wa_status = 'nao_contactar' then 'nao_enviada' else wa_status end
   where id = p_lead;
  if p_bloquear then
    update public.lead_tasks set canceled_at = now() where lead_id = p_lead and done_at is null and canceled_at is null;
    delete from public.wa_queue where lead_id = p_lead and status = 'pending';
  end if;
  insert into public.lead_events (lead_id, type, title, author_id)
  values (p_lead, 'auto', case when p_bloquear then 'Bloqueada: não contactar' else 'Desbloqueada: pode voltar a ser contactada' end, auth.uid());
end $$;
revoke execute on function public.wa_bloquear(uuid, boolean) from public, anon;
grant execute on function public.wa_bloquear(uuid, boolean) to authenticated;

-- ============================================================ MÉTRICAS
-- Vista do cliente (10.1): mensagens de WhatsApp entregues no período, para somar às chamadas em
-- "Contactos realizados". Só com wa_live = true; antes disso devolve null e nada muda no dashboard.
create or replace function public.wa_contactos(p_client uuid default null, p_period text default '7', p_from date default null, p_to date default null)
returns integer language plpgsql stable security definer set search_path = public as $$
declare v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon'; v_from timestamptz; v_to timestamptz;
begin
  if not coalesce((select wa_live from public.leads_settings limit 1), false) then return null; end if;
  if not private.leads_is_opera() then p_client := private.leads_my_client_id(); end if;
  if p_period = 'custom' then
    v_from := p_from::timestamp at time zone 'Europe/Lisbon'; v_to := (p_to + 1)::timestamp at time zone 'Europe/Lisbon';
  else
    v_from := case p_period when '1' then v_today when '7' then now() - interval '7 days' when '30' then now() - interval '30 days' else '-infinity'::timestamptz end;
    v_to := 'infinity'::timestamptz;
  end if;
  return (select count(*) from public.wa_messages m
           where m.direction = 'out' and m.status in ('delivered', 'read') and m.created_at >= v_from and m.created_at < v_to
             and (p_client is null or m.client_id = p_client)
             and m.client_id in (select private.leads_active_client_ids()));
end $$;
revoke execute on function public.wa_contactos(uuid, text, date, date) from public, anon;
grant execute on function public.wa_contactos(uuid, text, date, date) to authenticated;

-- Métricas internas (10.2), para o ecrã WhatsApp.
create or replace function public.wa_metricas(p_de date, p_ate date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_de timestamptz := p_de::timestamp at time zone 'Europe/Lisbon'; v_ate timestamptz := (p_ate + 1)::timestamp at time zone 'Europe/Lisbon';
begin
  perform private.wa_admin();
  return jsonb_build_object(
    'por_cliente', coalesce((select jsonb_agg(x order by x ->> 'cliente') from (
       select jsonb_build_object('cliente', c.name, 'cor', c.color,
         'enviadas', count(*) filter (where m.status <> 'failed'),
         'entregues', count(*) filter (where m.status in ('delivered', 'read')),
         'lidas', count(*) filter (where m.status = 'read'),
         'falhadas', count(*) filter (where m.status = 'failed'),
         'bloqueios', count(*) filter (where m.status = 'failed' and m.error ~ '131049|131026|131047|130472')) x
         from public.wa_messages m join public.clients c on c.id = m.client_id
        where m.direction = 'out' and m.kind = 'template' and m.created_at >= v_de and m.created_at < v_ate
        group by c.name, c.color) s), '[]'::jsonb),
    'respostas', coalesce((select jsonb_agg(jsonb_build_object('modelo', z.modelo, 'tipo', z.tipo, 'n', z.n) order by z.modelo, z.tipo) from (
       select coalesce(o.template, '?') as modelo, t.tipo, count(*) as n
         from public.wa_messages i
         left join public.wa_messages o on o.wa_message_id = i.context_id
         cross join lateral (select case
             when i.kind = 'text' then 'texto'
             when lower(i.body) in ('procuro e tenho para vender', 'só procuro comprar', 'sim, quero vender', 'quero comprar', 'quero vender', 'sim, tenho interesse') then 'sim'
             when lower(i.body) in ('talvez mais tarde', 'agora não', 'mais tarde') then 'mais_tarde'
             when lower(i.body) in ('já comprei', 'já vendi', 'já não procuro', 'já não tenho interesse') then 'ja_nao'
             when lower(i.body) = 'não quero contactos' then 'nao_contactar'
             when lower(i.body) in ('assim que possível', 'amanhã de manhã', 'amanhã à tarde') then 'marcar_chamada'
             else 'outro' end as tipo) t
        where i.direction = 'in' and i.created_at >= v_de and i.created_at < v_ate
        group by 1, 2) z), '[]'::jsonb),
    'leads_com_modelo', (select count(distinct lead_id) from public.wa_messages where direction = 'out' and kind = 'template'
                           and status in ('delivered', 'read') and created_at >= v_de and created_at < v_ate),
    'leads_que_responderam', (select count(distinct i.lead_id) from public.wa_messages i join public.wa_messages o on o.wa_message_id = i.context_id
                                where i.direction = 'in' and o.kind = 'template' and i.created_at >= v_de and i.created_at < v_ate),
    'reativadas', (select count(*) from public.leads where reactivated_at >= v_de and reactivated_at < v_ate),
    'reativadas_qualificadas', (select count(*) from public.leads l join public.lead_stages s on s.id = l.stage_id
                                  where l.reactivated_at >= v_de and l.reactivated_at < v_ate and s.key = 'qualificada'),
    'ttl_reativacao_min', (select round(percentile_cont(0.5) within group (order by extract(epoch from (f.primeira - l.reactivated_at)) / 60)::numeric, 1)
                             from public.leads l
                             cross join lateral (select min(e.created_at) primeira from public.lead_events e
                                                  where e.lead_id = l.id and e.type = 'call' and e.created_at >= l.reactivated_at) f
                            where l.reactivated_at >= v_de and l.reactivated_at < v_ate and f.primeira is not null),
    'reativadas_por_ligar_hoje', (select count(*) from public.leads l
                                    where l.reactivated_at >= date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon'
                                      and not exists (select 1 from public.lead_events e where e.lead_id = l.id and e.type = 'call' and e.created_at >= l.reactivated_at)),
    'tentativas_por_dia', coalesce((select jsonb_agg(d order by d ->> 'dia') from (
       select jsonb_build_object('dia', (e.created_at at time zone 'Europe/Lisbon')::date, 'gestor', coalesce(p.full_name, p.email), 'chamadas', count(*)) d
         from public.lead_events e join public.profiles p on p.id = e.author_id
        where e.type = 'call' and e.created_at >= v_de and e.created_at < v_ate and coalesce(e.meta ->> 'direction', '') <> 'incoming'
        group by 1, p.full_name, p.email) w), '[]'::jsonb));
end $$;
revoke execute on function public.wa_metricas(date, date) from public, anon;
grant execute on function public.wa_metricas(date, date) to authenticated;

-- ============================================================ FILA (leads_fila e leads_fila_resultado)
-- Iguais às versões em produção para todos os clientes sem WhatsApp ligado (ou com wa_live = false).
-- Exceção para todos: leads com do_not_contact = true (por defeito false) nunca entram na fila.
create or replace function public.leads_fila(p_client uuid default null)
returns table (lead_id uuid, grupo text, grupo_ordem integer, ordem bigint, name text, phone text, interest text, source text,
               client_id uuid, client_name text, client_color text, stage_name text, attempts integer, sem_resposta integer,
               new_at timestamptz, next_task_at timestamptz, next_task_type text, motivo text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_end timestamptz := (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '1 day') at time zone 'Europe/Lisbon';
  v_week timestamptz := date_trunc('week', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon';
  v_days numeric := least(5, extract(isodow from now() at time zone 'Europe/Lisbon'));
  -- WhatsApp: as regras da especificação (secção 9.3) só valem com wa_live e para clientes com WhatsApp ligado.
  v_live boolean := coalesce((select s.wa_live from public.leads_settings s limit 1), false);
  v_dow integer := extract(isodow from now() at time zone 'Europe/Lisbon');
begin
  if not private.leads_is_opera() then raise exception 'A fila é só para a equipa OPERA.'; end if;
  return query
  with clientes as (
    select c.id, c.name, c.color, coalesce(fc.leads_dia, 25) as leads_dia,
           (p_client is not null or coalesce(fc.ativa, true)) as auto,
           (v_live and c.wa_enabled and c.wa_consent_ok) as wa, c.weekend_enabled as fds
      from public.clients c
      left join public.lead_fila_clientes fc on fc.client_id = c.id
     where c.id in (select private.leads_active_client_ids())
       and not coalesce(c.leads_internal, false)
       and (case when p_client is not null then c.id = p_client
            else not exists (select 1 from public.lead_fila_exclusoes x where x.user_id = v_me and x.client_id = c.id)
             and (c.id in (select m.client_id from public.client_managers m where m.user_id = v_me)
                  or not exists (select 1 from public.client_managers m where m.user_id = v_me)) end)
  ),
  trab as (
    select l.client_id,
           count(distinct e.lead_id) filter (where e.created_at >= v_today) as hoje,
           count(distinct (e.lead_id, (e.created_at at time zone 'Europe/Lisbon')::date)) as semana
      from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.type = 'call' and e.created_at >= v_week and l.client_id in (select id from clientes)
     group by l.client_id
  ),
  -- Clientes que ainda têm BD para trabalhar (as mesmas condições da BD mais abaixo).
  disp as (
    select distinct l.client_id
      from public.leads l
      join public.lead_stages s on s.id = l.stage_id
      left join public.lead_fila f on f.lead_id = l.id
      join clientes c2 on c2.id = l.client_id
     where not l.anonymized and l.new_at is null and l.next_task_at is null and not l.do_not_contact
       and f.aguarda_whatsapp_at is null
       and (f.escolhida_at is not null
            or (not c2.wa and (s.key in ('meta', 'imoveis', 'bd') or (s.client_id is not null and s.position < 40))
                and l.attempts < 2 and coalesce(f.sem_resposta, 0) < 2)
            or (c2.wa and s.position < 50 and coalesce(f.sem_resposta, 0) < 2
                and ((v_dow < 6 and l.wa_status in ('sem_resposta', 'falhou') and not l.weekend_only)
                     or (v_dow = 6 and c2.fds and (l.weekend_only or l.wa_status in ('sem_resposta', 'reativada_sem_contacto'))))))
  ),
  -- Rondas de leads do dia: ninguém passa das 25 (as leads do dia) enquanto houver um cliente da fila automática abaixo
  -- (que ainda tenha BD para trabalhar); quando todos lá chegam, abre a ronda seguinte (até 50), e assim por diante.
  ronda as (
    select coalesce(floor(min(coalesce(t.hoje, 0)::numeric / greatest(1, c.leads_dia))), 0) + 1 as r
      from clientes c left join trab t on t.client_id = c.id
     where c.auto and c.id in (select d.client_id from disp d)
  ),
  -- Blocos de 5: as chamadas do gestor hoje, da mais recente para trás. O cliente da última chamada e quantas leads
  -- seguidas já leva nele.
  seq as (
    select l.client_id, e.lead_id, row_number() over (order by e.created_at desc) as rn
      from public.lead_events e join public.leads l on l.id = e.lead_id
     where e.author_id = v_me and e.type = 'call' and e.created_at >= v_today and l.client_id in (select id from clientes)
  ),
  atual as (
    select s.client_id,
           (select count(distinct s2.lead_id) from seq s2
             where s2.rn < coalesce((select min(s3.rn) from seq s3 where s3.client_id <> s.client_id), 2147483647)) as seguidas
      from seq s where s.rn = 1
  ),
  rk as (
    -- Primeiro o cliente em que se está a meio de um bloco de 5 (se ainda tiver lugar na ronda); depois o cliente com
    -- menos contactos hoje; no empate, o com menos contactos na semana.
    select c.id,
           row_number() over (order by case when c.id = (select a.client_id from atual a)
                                             and (select a.seguidas from atual a) % 5 <> 0
                                             and (select r from ronda) * c.leads_dia > coalesce(t.hoje, 0) then 0 else 1 end,
                                       coalesce(t.hoje, 0)::numeric / greatest(1, c.leads_dia),
                                       coalesce(t.semana, 0)::numeric / greatest(1, c.leads_dia * v_days), c.name) as rk,
           greatest(0, (select r from ronda) * c.leads_dia - coalesce(t.hoje, 0)) as resta
      from clientes c left join trab t on t.client_id = c.id
  ),
  base as (
    select l.id, l.name, l.phone, l.interest, l.source, l.client_id, l.attempts, l.new_at, l.next_task_at, l.next_task_type,
           l.created_at, l.source_created_at, s.name as sname, s.key as skey,
           (s.key in ('meta', 'imoveis', 'bd') or (s.client_id is not null and s.position < 40)) as sbd,
           coalesce(f.sem_resposta, 0) as sr, f.escolhida_at, c.name as cname, c.color as ccolor, c.auto, r.rk, r.resta,
           c.wa, c.fds, l.wa_status, l.wa_reply, l.wa_replied_at, l.wa_asap_at, l.reactivated_at, l.weekend_only,
           (l.next_task_at at time zone 'Europe/Lisbon')::time = time '23:59:59' as dia_todo
      from public.leads l
      join clientes c on c.id = l.client_id
      join rk r on r.id = l.client_id
      join public.lead_stages s on s.id = l.stage_id
      left join public.lead_fila f on f.lead_id = l.id
     where not l.anonymized and s.position < 50 and f.aguarda_whatsapp_at is null and not l.do_not_contact
       and not (c.wa and l.weekend_only and v_dow < 6)
  ),
  nova as (
    select b.*, 1 as g,
           row_number() over (order by b.new_at asc) as o,
           'Entrou ' || to_char(b.new_at at time zone 'Europe/Lisbon', 'DD/MM "às" HH24:MI') as m
      from base b where b.new_at is not null
       and not (b.wa and b.reactivated_at is not null and b.wa_asap_at is null
                and b.wa_status in ('respondeu_sim', 'respondeu_mais_tarde', 'respondeu_texto'))
  ),
  -- Reativadas pelo WhatsApp (só clientes com WhatsApp ligado): primeiro as que disseram sim, depois as respostas
  -- escritas, depois "mais tarde", pela ordem de resposta. Ao fim de semana não entram (secção 9.3).
  reativ as (
    select b.*, 3 as g,
           row_number() over (order by case b.wa_status when 'respondeu_sim' then 0 when 'respondeu_texto' then 1 else 2 end,
                                       b.wa_replied_at) as o,
           case when b.wa_status = 'respondeu_texto' then 'Escreveu no WhatsApp: "' || left(coalesce(b.wa_reply, ''), 90) || '"'
                else 'Respondeu "' || coalesce(b.wa_reply, '') || '" no WhatsApp às ' || to_char(b.wa_replied_at at time zone 'Europe/Lisbon', 'HH24:MI') end as m
      from base b
     where b.new_at is not null and b.wa and b.reactivated_at is not null and b.wa_asap_at is null
       and b.wa_status in ('respondeu_sim', 'respondeu_mais_tarde', 'respondeu_texto') and v_dow < 6
  ),
  marcada as (
    select b.*, 2 as g, row_number() over (order by b.next_task_at) as o,
           case b.next_task_type when 'call' then 'Chamada marcada' else 'Follow up marcado' end || ' para as '
             || to_char(b.next_task_at at time zone 'Europe/Lisbon', 'HH24:MI') as m
      from base b
     where b.new_at is null and b.next_task_type in ('call', 'followup') and not b.dia_todo
       and b.next_task_at <= now() and b.next_task_at > now() - interval '3 hours'
       and not (b.wa and v_dow >= 6)
  ),
  fu as (
    select b.*, 4 as g,
           b.rk * 100000 + row_number() over (partition by b.client_id order by b.next_task_at nulls last, b.created_at) as o,
           case when b.next_task_at is null then 'Em Follow Up sem tarefa marcada'
                else (case b.next_task_type when 'call' then 'Chamada' else 'Follow up' end) || ' para '
                     || to_char(b.next_task_at at time zone 'Europe/Lisbon', case when b.dia_todo then 'DD/MM' else 'DD/MM HH24:MI' end) end as m
      from base b
     where b.auto and b.new_at is null and not (b.wa and v_dow >= 6)
       and ((b.next_task_type in ('call', 'followup')
             and (b.next_task_at <= now() - interval '3 hours'
                  or (b.next_task_at <= now() and b.dia_todo)
                  or (b.dia_todo and b.next_task_at < v_end)))
            or (b.skey = 'followup' and b.next_task_at is null))
  ),
  bd as (
    select x.* from (
      select b.*, 5 as g,
             row_number() over (partition by b.client_id order by b.escolhida_at is null, b.escolhida_at, b.attempts,
                                coalesce(b.source_created_at, b.created_at) desc) as rn,
             case when b.escolhida_at is not null then 'Escolhida para a fila · ' else 'Recuperação · ' end
               || b.attempts || case when b.attempts = 1 then ' tentativa' else ' tentativas' end as m
        from base b
       where b.new_at is null and b.next_task_at is null
         and (b.escolhida_at is not null
              or (b.auto and not b.wa and b.sbd and b.attempts < 2 and b.sr < 2)
              -- Clientes com WhatsApp: só as que não responderam ao WhatsApp ou em que a entrega falhou; ao sábado,
              -- nos clientes com fim de semana, as do fim de semana; ao domingo, nenhuma.
              or (b.auto and b.wa and b.sr < 2
                  and ((v_dow < 6 and b.wa_status in ('sem_resposta', 'falhou'))
                       or (v_dow = 6 and b.fds and (b.weekend_only or b.wa_status in ('sem_resposta', 'reativada_sem_contacto'))))))
    ) x where x.rn <= x.resta
  ),
  tudo as (
    select n.id, n.g, n.o, n.m, n.name, n.phone, n.interest, n.source, n.client_id, n.cname, n.ccolor, n.sname, n.attempts, n.sr, n.new_at, n.next_task_at, n.next_task_type from nova n
    union all
    select z.id, z.g, z.o, z.m, z.name, z.phone, z.interest, z.source, z.client_id, z.cname, z.ccolor, z.sname, z.attempts, z.sr, z.new_at, z.next_task_at, z.next_task_type from reativ z
    union all
    select k.id, k.g, k.o, k.m, k.name, k.phone, k.interest, k.source, k.client_id, k.cname, k.ccolor, k.sname, k.attempts, k.sr, k.new_at, k.next_task_at, k.next_task_type from marcada k
    union all
    select f.id, f.g, f.o, f.m, f.name, f.phone, f.interest, f.source, f.client_id, f.cname, f.ccolor, f.sname, f.attempts, f.sr, f.new_at, f.next_task_at, f.next_task_type from fu f
     where f.id not in (select k2.id from marcada k2)
    union all
    select d.id, d.g, d.rk * 100000 + d.rn, d.m, d.name, d.phone, d.interest, d.source, d.client_id, d.cname, d.ccolor, d.sname, d.attempts, d.sr, d.new_at, d.next_task_at, d.next_task_type from bd d
     where d.id not in (select f2.id from fu f2)
  )
  select t.id, case t.g when 1 then 'Lead nova' when 2 then 'Hora marcada' when 3 then 'Reativada por WhatsApp' when 4 then 'Follow up' else 'BD' end,
         t.g, t.o, t.name, t.phone, t.interest, t.source, t.client_id, t.cname, t.ccolor, t.sname, t.attempts, t.sr,
         t.new_at, t.next_task_at, t.next_task_type, t.m
    from tudo t
   order by case t.g when 2 then 0 else t.g end, t.o
   limit 2000;
end;
$$;
revoke execute on function public.leads_fila(uuid) from public, anon;
grant execute on function public.leads_fila(uuid) to authenticated;

create or replace function public.leads_fila_resultado(p_lead uuid, p_resultado text, p_quando timestamptz default null,
                                                     p_nota text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pos numeric;
  v_fu uuid; v_q uuid; v_dq uuid;
  v_sr integer;
  v_msg text;
  v_when timestamptz;
  v_wa boolean; v_l public.leads; v_nova boolean; v_reat boolean; v_max integer; v_dia date;
begin
  if not (private.leads_is_opera() and private.leads_can_write(p_lead)) then
    raise exception 'Sem acesso a esta lead.';
  end if;
  if p_resultado not in ('nao_atendeu', 'mais_tarde', 'follow_up', 'qualificada', 'desqualificada') then
    raise exception 'Resultado desconhecido.';
  end if;
  select s.position into v_pos from public.leads l join public.lead_stages s on s.id = l.stage_id where l.id = p_lead for update of l;
  select id into v_fu from public.lead_stages where key = 'followup' and client_id is null;
  select id into v_q from public.lead_stages where key = 'qualificada' and client_id is null;
  select id into v_dq from public.lead_stages where key = 'desq' and client_id is null;
  insert into public.lead_fila (lead_id) values (p_lead) on conflict (lead_id) do nothing;

  if coalesce(trim(p_nota), '') <> '' then
    insert into public.lead_events (lead_id, type, title, body, author_id) values (p_lead, 'note', 'Nota', trim(p_nota), auth.uid());
  end if;

  if p_resultado in ('nao_atendeu', 'mais_tarde', 'follow_up') then
    -- A tarefa que trouxe a lead à fila fica feita.
    update public.lead_tasks set done_at = now()
     where lead_id = p_lead and done_at is null and canceled_at is null and type in ('call', 'followup') and due_at <= now();
  end if;

  select * into v_l from public.leads where id = p_lead;
  v_wa := coalesce((select s.wa_live from public.leads_settings s limit 1), false) and private.wa_cliente_ativo(v_l.client_id);

  if p_resultado = 'nao_atendeu' and v_wa then
    -- Cadência com WhatsApp (secções 7.1, 7.3 e 7.5). Lead nova: 3 chamadas (a 2.ª no mesmo dia ou no seguinte,
    -- a 3.ª 2 dias depois) e depois o modelo N daqui a 14 dias. Lead reativada: 2 chamadas e depois volta à
    -- reativação daqui a 14 dias (ou só fim de semana ao 2.º ciclo). Follow up e outras: 2 chamadas e 14 dias.
    v_reat := v_l.reactivated_at is not null and v_l.wa_status in ('respondeu_sim', 'respondeu_mais_tarde', 'respondeu_texto');
    v_nova := not v_reat and v_l.reactivated_at is null and v_l.entry_stage in ('meta', 'imoveis')
              and not exists (select 1 from public.lead_events e where e.lead_id = p_lead and e.type = 'call' and (e.meta ->> 'answered') = 'true');
    v_max := case when v_nova then 3 else 2 end;
    update public.lead_fila set sem_resposta = sem_resposta + 1, updated_at = now() where lead_id = p_lead returning sem_resposta into v_sr;
    if v_sr >= v_max then
      update public.lead_fila set aguarda_whatsapp_at = now() where lead_id = p_lead;
      update public.lead_tasks set canceled_at = now()
       where lead_id = p_lead and done_at is null and canceled_at is null and type in ('call', 'followup');
      if v_reat then
        update public.leads
           set wa_cycle = wa_cycle + 1,
               wa_status = case when wa_cycle + 1 >= 2 then 'so_fim_de_semana' else 'reativada_sem_contacto' end,
               weekend_only = weekend_only or wa_cycle + 1 >= 2,
               wa_next_send_at = case when wa_cycle + 1 >= 2 then null else now() + interval '14 days' end,
               wa_next_template = null
         where id = p_lead;
        v_msg := case when v_l.wa_cycle + 1 >= 2 then 'Sem resposta outra vez: fica só para as chamadas do fim de semana.'
                      else 'Sem resposta: sai da fila e volta à reativação por WhatsApp daqui a 14 dias.' end;
      else
        update public.leads set wa_next_send_at = now() + interval '14 days', wa_next_template = case when v_nova then 'N' end
         where id = p_lead;
        v_msg := 'Sem resposta ' || v_max || ' vezes: sai da fila e recebe uma mensagem de WhatsApp daqui a 14 dias.';
      end if;
      insert into public.lead_events (lead_id, type, title, body, author_id)
      values (p_lead, 'auto', 'Fila: sem resposta ' || v_max || ' vezes', v_msg, auth.uid());
    else
      if v_nova and v_sr = 2 then
        -- 3.ª chamada 2 dias depois, à mesma hora (dia útil seguinte nos clientes sem fim de semana).
        v_dia := (now() at time zone 'Europe/Lisbon')::date + 2;
        if not coalesce((select weekend_enabled from public.clients where id = v_l.client_id), false) then
          while not private.wa_dia_util(v_dia) loop v_dia := v_dia + 1; end loop;
        end if;
        v_when := coalesce(p_quando, (v_dia + greatest(least((now() at time zone 'Europe/Lisbon')::time, time '18:30'), time '10:00'))
                                     at time zone 'Europe/Lisbon');
      else
        v_when := coalesce(p_quando, now() + interval '3 hours');
        if p_quando is null and ((v_when at time zone 'Europe/Lisbon')::time > time '19:00'
                                 or (v_when at time zone 'Europe/Lisbon')::time < time '09:30') then
          v_dia := private.wa_amanha(v_l.client_id);
          v_when := (v_dia + time '10:00') at time zone 'Europe/Lisbon';
        end if;
      end if;
      insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
      values (p_lead, 'call', v_when, (v_sr + 1) || '.ª tentativa', auth.uid());
      v_msg := (v_sr + 1) || '.ª tentativa marcada para ' || to_char(v_when at time zone 'Europe/Lisbon', 'DD/MM "às" HH24:MI') || '.';
    end if;
    if v_pos < 40 then update public.leads set stage_id = v_fu where id = p_lead; end if;

  elsif p_resultado = 'nao_atendeu' then
    update public.lead_fila set sem_resposta = sem_resposta + 1, updated_at = now() where lead_id = p_lead returning sem_resposta into v_sr;
    if v_sr >= 2 then
      update public.lead_fila set aguarda_whatsapp_at = now() where lead_id = p_lead;
      update public.lead_tasks set canceled_at = now()
       where lead_id = p_lead and done_at is null and canceled_at is null and type in ('call', 'followup');
      insert into public.lead_events (lead_id, type, title, body, author_id)
      values (p_lead, 'auto', 'Fila: sem resposta 2 vezes',
              'Não atendeu 2 vezes seguidas. Saiu da fila e fica à espera da mensagem de reativação por WhatsApp.', auth.uid());
      v_msg := 'Sem resposta 2 vezes: saiu da fila e fica à espera da mensagem de WhatsApp.';
    else
      v_when := coalesce(p_quando, now() + interval '3 hours');
      -- Fora do horário (depois das 19:00 ou antes das 9:30): passa para o dia útil seguinte às 10:00.
      if p_quando is null and ((v_when at time zone 'Europe/Lisbon')::time > time '19:00'
                               or (v_when at time zone 'Europe/Lisbon')::time < time '09:30') then
        v_when := (date_trunc('day', now() at time zone 'Europe/Lisbon') + interval '1 day 10 hours') at time zone 'Europe/Lisbon';
        if extract(isodow from v_when at time zone 'Europe/Lisbon') = 6 then v_when := v_when + interval '2 days';
        elsif extract(isodow from v_when at time zone 'Europe/Lisbon') = 7 then v_when := v_when + interval '1 day'; end if;
      end if;
      insert into public.lead_tasks (lead_id, type, due_at, note, created_by) values (p_lead, 'call', v_when, '2.ª tentativa', auth.uid());
      v_msg := '2.ª tentativa marcada para ' || to_char(v_when at time zone 'Europe/Lisbon', 'DD/MM "às" HH24:MI') || '.';
    end if;
    if v_pos < 40 then update public.leads set stage_id = v_fu where id = p_lead; end if;

  elsif p_resultado in ('mais_tarde', 'follow_up') then
    if p_quando is null then raise exception 'Escolhe quando voltar a contactar.'; end if;
    update public.lead_fila set sem_resposta = 0, updated_at = now() where lead_id = p_lead;
    insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
    values (p_lead, case when p_resultado = 'mais_tarde' then 'call' else 'followup' end, p_quando,
            case when p_resultado = 'mais_tarde' then 'Pediu para ligar mais tarde' else 'Follow up' end, auth.uid());
    if v_pos < 40 then update public.leads set stage_id = v_fu where id = p_lead; end if;
    v_msg := case when p_resultado = 'mais_tarde' then 'Chamada marcada' else 'Follow up marcado' end || ' para '
             || to_char(p_quando at time zone 'Europe/Lisbon', case when p_resultado = 'follow_up' then 'DD/MM' else 'DD/MM "às" HH24:MI' end) || '.';

  elsif p_resultado = 'qualificada' then
    update public.lead_fila set sem_resposta = 0, updated_at = now() where lead_id = p_lead;
    update public.leads set stage_id = v_q where id = p_lead;
    v_msg := 'Lead qualificada. O cliente vai ser avisado.';

  else
    update public.lead_fila set sem_resposta = 0, updated_at = now() where lead_id = p_lead;
    update public.leads set stage_id = v_dq where id = p_lead;
    v_msg := 'Lead desqualificada.';
  end if;

  -- Já foi trabalhada: deixa de contar como lead nova por pegar e sai das escolhidas para a fila.
  update public.leads set new_at = null where id = p_lead and new_at is not null;
  update public.lead_fila set escolhida_at = null, escolhida_por = null where lead_id = p_lead and escolhida_at is not null;
  return jsonb_build_object('mensagem', v_msg);
end;
$$;
revoke execute on function public.leads_fila_resultado(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.leads_fila_resultado(uuid, text, timestamptz, text) to authenticated;
