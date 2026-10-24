-- Esquema da produção (OPERA OS) tal como estava em 2026-10-21, antes do OPERA Leads.
-- Lido diretamente da base de dados, porque o antigo schema.sql (supabase/legacy) estava desatualizado.
-- As chaves da Anthropic e do Resend que estavam escritas nas funções foram REMOVIDAS deste ficheiro
-- e substituídas por marcadores; em produção vão passar para o Supabase Vault (correção 2).
-- Os emails da equipa também foram substituídos por marcadores, porque este repositório é público.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ============================================================ TABELAS
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'cliente' constraint profiles_role_check check (role = any (array['cliente', 'equipa'])),
  client_id uuid references public.clients (id) on delete set null,
  full_name text,
  email text,
  created_at timestamptz not null default now(),
  is_admin boolean not null default false,
  permissions jsonb not null default '{}'::jsonb,
  is_responsavel boolean not null default false
);

create table public.client_invites (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now(),
  full_name text
);

create table public.client_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  text text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.client_activities (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  type text not null,
  text text not null,
  due date,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete set null,
  name text not null,
  contact text,
  value numeric not null default 0,
  stage text not null default 'Lead',
  owner text,
  stage_entered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  service_start_date date
);

create table public.pedidos (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  type text not null,
  custom_title text,
  description text,
  property_id text,
  stage text not null default 'Recebido',
  owner text,
  due timestamptz,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  client_seen boolean not null default true,
  last_equipa_view_at timestamptz,
  archived_at timestamptz,
  last_client_view_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text
);

create table public.pedido_tasks (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.pedido_notes (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create table public.pedido_attachments (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  name text not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  uploaded_by text not null default 'equipa' check (uploaded_by = any (array['cliente', 'equipa']))
);

create table public.pedido_mensagens (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  sender text not null check (sender = any (array['cliente', 'equipa'])),
  text text not null,
  created_at timestamptz not null default now()
);

create table public.feedback_respostas (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ciclo text not null check (ciclo ~ '^\d{4}-\d{2}$'),
  cliente text,
  satisfacao_geral smallint not null check (satisfacao_geral between 1 and 10),
  legal smallint check (legal between 1 and 10),
  financeiro smallint check (financeiro between 1 and 10),
  processual smallint check (processual between 1 and 10),
  usa_sa boolean not null,
  sa smallint check (sa between 1 and 10),
  opera_os smallint check (opera_os between 1 and 10),
  eficiencia smallint not null check (eficiencia between 1 and 10),
  nps smallint not null check (nps between 0 and 10),
  sugestoes text check (char_length(sugestoes) <= 3000),
  melhoria text check (char_length(melhoria) <= 3000),
  constraint sa_coerente check (usa_sa or sa is null)
);

create table public.financeiro_despesas (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  date date not null,
  vendor text not null,
  rubrica text not null check (rubrica = any (array['Manutenção', 'Condomínio', 'Seguros', 'Limpeza', 'Marketing', 'Impostos', 'Utilities', 'Tecnologia', 'Equipamentos', 'Material de Escritório', 'Outros'])),
  amount numeric(12,2) not null check (amount >= 0),
  source text not null default 'manual' check (source = any (array['manual', 'drive', 'upload'])),
  created_at timestamptz not null default now(),
  storage_path text,
  status text not null default 'processado' check (status = any (array['processando', 'processado', 'erro'])),
  ai_request_id bigint,
  ai_error text,
  iva numeric not null default 0
);

create table public.financeiro_receitas (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  date date not null,
  description text not null,
  amount numeric(12,2) not null check (amount >= 0),
  source text not null default 'manual' check (source = any (array['manual', 'drive', 'upload'])),
  created_at timestamptz not null default now(),
  storage_path text,
  status text not null default 'processado' check (status = any (array['processando', 'processado', 'erro'])),
  ai_request_id bigint,
  ai_error text,
  iva numeric not null default 0
);

create table public.financeiro_extrato (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  date date not null,
  description text not null,
  amount numeric(12,2) not null,
  status text not null default 'pendente' check (status = any (array['reconciliado', 'pendente', 'sem_correspondencia'])),
  created_at timestamptz not null default now()
);

create table public.financeiro_relatorios (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  ano integer not null,
  mes integer not null,
  status text not null default 'processando' check (status = any (array['processando', 'processado', 'erro'])),
  texto text,
  ai_error text,
  ai_request_id bigint,
  created_at timestamptz not null default now()
);

-- ============================================================ ÍNDICES
create index idx_client_activities_client_id on public.client_activities (client_id);
create index idx_client_invites_client_id on public.client_invites (client_id);
create index idx_client_notes_client_id on public.client_notes (client_id);
create index idx_deals_client_id on public.deals (client_id);
create index idx_deals_stage on public.deals (stage);
create index feedback_respostas_ciclo_idx on public.feedback_respostas (ciclo);
create index idx_financeiro_despesas_client_id on public.financeiro_despesas (client_id);
create index idx_financeiro_extrato_client_id on public.financeiro_extrato (client_id);
create index idx_financeiro_receitas_client_id on public.financeiro_receitas (client_id);
create index idx_pedido_attachments_pedido_id on public.pedido_attachments (pedido_id);
create index idx_pedido_mensagens_pedido_id on public.pedido_mensagens (pedido_id);
create index idx_pedido_notes_pedido_id on public.pedido_notes (pedido_id);
create index idx_pedido_tasks_pedido_id on public.pedido_tasks (pedido_id);
create index idx_pedidos_client_id on public.pedidos (client_id);
create index idx_pedidos_stage on public.pedidos (stage);

-- ============================================================ FUNÇÕES AUXILIARES (RLS)
create function public.current_client_id() returns uuid
language sql stable security definer set search_path = public as $$
  select client_id from public.profiles where id = auth.uid();
$$;

create function public.current_is_responsavel() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_responsavel from public.profiles where id = auth.uid()), false);
$$;

create function public."current_role"() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create function public.equipa_notify_emails() returns jsonb
language sql immutable as $$
  select jsonb_build_array('<email da equipa 1>', '<email da equipa 2>', '<email externo da equipa>');
$$;

create function public.pedido_client_recipients(p_pedido_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(distinct e), '[]'::jsonb)
  from (
    select lower(btrim(c.email)) as e
      from public.pedidos p join public.clients c on c.id = p.client_id
     where p.id = p_pedido_id
    union
    select lower(btrim(pr.email))
      from public.pedidos p join public.profiles pr on pr.id = p.created_by
     where p.id = p_pedido_id
  ) t
  where e is not null and e <> '' and e <> '—';
$$;

-- ============================================================ NOVOS UTILIZADORES
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client_id uuid;
  v_invite_name text;
  v_is_equipa boolean;
  v_first boolean;
begin
  select client_id, full_name into v_client_id, v_invite_name
  from public.client_invites
  where lower(email) = lower(new.email)
  limit 1;

  v_is_equipa := new.email ilike '%@opera-os.com'
                 or lower(new.email) in ('<email externo da equipa>');

  v_first := v_client_id is not null
             and not exists (select 1 from public.profiles where client_id = v_client_id and role = 'cliente');

  insert into public.profiles (id, full_name, email, role, client_id, is_responsavel)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(v_invite_name, ''),
      case when lower(new.email) = '<email externo da equipa>' then '<nome do email externo>' end
    ),
    new.email,
    case when v_is_equipa then 'equipa' else 'cliente' end,
    case when v_is_equipa then null else v_client_id end,
    case when v_is_equipa then false else v_first end
  );

  if v_client_id is not null then
    delete from public.client_invites where lower(email) = lower(new.email);
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================ NOTIFICAÇÕES POR EMAIL (Resend)
create function public.notify_new_pedido() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client_name text;
begin
  select name into v_client_name from public.clients where id = new.client_id;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer <RESEND_API_KEY removida>', 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'from', 'OPERA CRM <crm@opera-os.com>',
      'to', public.equipa_notify_emails(),
      'subject', 'Novo pedido - ' || coalesce(v_client_name, 'Cliente') || ': ' || coalesce(new.custom_title, new.type),
      'html', '<p>Novo pedido recebido de <strong>' || coalesce(v_client_name, '') || '</strong>.</p>' ||
              '<p><strong>Tipo:</strong> ' || new.type || '</p>' ||
              '<p><strong>Descrição:</strong> ' || coalesce(new.description, '(sem descrição)') || '</p>' ||
              '<p><a href="https://opera-os.com/crm/">Abrir OPERA CRM</a></p>'
    )
  );

  return new;
end;
$$;

create function public.notify_pedido_stage_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pedido_title text;
  v_to jsonb;
begin
  if new.stage is distinct from old.stage then
    update public.pedidos set client_seen = false where id = new.id;
    v_pedido_title := coalesce(new.custom_title, new.type);
    v_to := public.pedido_client_recipients(new.id);
    if jsonb_array_length(v_to) > 0 then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer <RESEND_API_KEY removida>', 'Content-Type', 'application/json'),
        body := jsonb_build_object(
          'from', 'OPERA CRM <crm@opera-os.com>',
          'to', v_to,
          'subject', 'Atualização no seu pedido - ' || v_pedido_title,
          'html', '<p>O seu pedido "' || v_pedido_title || '" passou para o estado: <strong>' || new.stage || '</strong>.</p>' ||
                  '<p><a href="https://opera-os.com/crm/">Ver no Portal do Cliente</a></p>'
        )
      );
    end if;
  end if;

  return new;
end;
$$;

create function public.notify_new_mensagem() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client_name text;
  v_pedido_title text;
  v_to jsonb;
begin
  select c.name, coalesce(p.custom_title, p.type)
    into v_client_name, v_pedido_title
  from public.pedidos p
  join public.clients c on c.id = p.client_id
  where p.id = new.pedido_id;

  if new.sender = 'cliente' then
    update public.pedidos set seen = false where id = new.pedido_id;
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer <RESEND_API_KEY removida>', 'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'from', 'OPERA CRM <crm@opera-os.com>',
        'to', public.equipa_notify_emails(),
        'subject', 'Nova mensagem de ' || coalesce(v_client_name,'cliente') || ' - ' || v_pedido_title,
        'html', '<p><strong>' || coalesce(v_client_name,'') || '</strong> escreveu no pedido "' || v_pedido_title || '":</p>' ||
                '<p>' || new.text || '</p>' ||
                '<p><a href="https://opera-os.com/crm/">Abrir OPERA CRM</a></p>'
      )
    );
  else
    update public.pedidos set client_seen = false where id = new.pedido_id;
    v_to := public.pedido_client_recipients(new.pedido_id);
    if jsonb_array_length(v_to) > 0 then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer <RESEND_API_KEY removida>', 'Content-Type', 'application/json'),
        body := jsonb_build_object(
          'from', 'OPERA CRM <crm@opera-os.com>',
          'to', v_to,
          'subject', 'Nova mensagem da equipa OPERA - ' || v_pedido_title,
          'html', '<p>A equipa OPERA respondeu no seu pedido "' || v_pedido_title || '":</p>' ||
                  '<p>' || new.text || '</p>' ||
                  '<p><a href="https://opera-os.com/crm/">Abrir Portal do Cliente</a></p>'
        )
      );
    end if;
  end if;

  return new;
end;
$$;

create function public.notify_new_attachment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client_name text;
  v_pedido_title text;
  v_to jsonb;
begin
  select c.name, coalesce(p.custom_title, p.type)
    into v_client_name, v_pedido_title
  from public.pedidos p
  join public.clients c on c.id = p.client_id
  where p.id = new.pedido_id;

  if new.uploaded_by = 'cliente' then
    update public.pedidos set seen = false where id = new.pedido_id;
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer <RESEND_API_KEY removida>', 'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'from', 'OPERA CRM <crm@opera-os.com>',
        'to', public.equipa_notify_emails(),
        'subject', 'Novo ficheiro de ' || coalesce(v_client_name, 'cliente') || ' - ' || v_pedido_title,
        'html', '<p><strong>' || coalesce(v_client_name, '') || '</strong> enviou um novo ficheiro no pedido "' || v_pedido_title || '": ' || new.name || '</p><p><a href="https://opera-os.com/crm/">Abrir OPERA CRM</a></p>'
      )
    );
  else
    update public.pedidos set client_seen = false where id = new.pedido_id;
    v_to := public.pedido_client_recipients(new.pedido_id);
    if jsonb_array_length(v_to) > 0 then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer <RESEND_API_KEY removida>', 'Content-Type', 'application/json'),
        body := jsonb_build_object(
          'from', 'OPERA CRM <crm@opera-os.com>',
          'to', v_to,
          'subject', 'Novo ficheiro no seu pedido - ' || v_pedido_title,
          'html', '<p>A equipa OPERA adicionou um novo ficheiro no seu pedido "' || v_pedido_title || '": ' || new.name || '</p><p><a href="https://opera-os.com/crm/">Abrir Portal do Cliente</a></p>'
        )
      );
    end if;
  end if;

  return new;
end;
$$;

create trigger on_pedido_created after insert on public.pedidos
  for each row execute function public.notify_new_pedido();
create trigger on_pedido_stage_changed after update on public.pedidos
  for each row execute function public.notify_pedido_stage_change();
create trigger on_mensagem_created after insert on public.pedido_mensagens
  for each row execute function public.notify_new_mensagem();
create trigger on_attachment_created after insert on public.pedido_attachments
  for each row execute function public.notify_new_attachment();

-- ============================================================ FINANCEIRO COM IA (Anthropic)
create function public.iniciar_leitura_documento(p_row_id uuid, p_tipo text, p_mime_type text, p_file_url text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prompt text;
  v_request_id bigint;
begin
  v_prompt := case when p_tipo = 'custo' then
    'Analisa este documento (fatura de despesa). Responde APENAS com um objeto JSON válido (sem markdown, sem texto à volta), com exatamente estes campos: {"fornecedor": string, "data": "YYYY-MM-DD", "valor": number, "iva": number, "rubrica": uma destas opções exatas ["Manutenção","Condomínio","Seguros","Limpeza","Marketing","Impostos","Utilities","Tecnologia","Equipamentos","Material de Escritório","Outros"]}. "valor" é o valor SEM IVA (base, antes de imposto) e "iva" é o valor do IVA (0 se não houver IVA identificável ou isento). Nunca somes o IVA ao valor. Usa a tua melhor estimativa se algum campo não estiver totalmente claro.'
  else
    'Analisa este documento (fatura emitida / comprovativo de receita). Responde APENAS com um objeto JSON válido (sem markdown, sem texto à volta), com exatamente estes campos: {"descricao": string, "data": "YYYY-MM-DD", "valor": number, "iva": number}. "valor" é o valor SEM IVA (base, antes de imposto) e "iva" é o valor do IVA (0 se não houver IVA identificável ou isento). Nunca somes o IVA ao valor.'
  end;

  select net.http_post(
    url := 'https://api.anthropic.com/v1/messages',
    headers := jsonb_build_object('x-api-key', '<ANTHROPIC_API_KEY removida>', 'anthropic-version', '2023-06-01', 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'model', 'claude-sonnet-5',
      'max_tokens', 500,
      'messages', jsonb_build_array(jsonb_build_object(
        'role', 'user',
        'content', jsonb_build_array(
          jsonb_build_object(
            'type', case when p_mime_type = 'application/pdf' then 'document' else 'image' end,
            'source', jsonb_build_object('type', 'url', 'url', p_file_url)
          ),
          jsonb_build_object('type', 'text', 'text', v_prompt)
        )
      ))
    ),
    timeout_milliseconds := 30000
  ) into v_request_id;

  if p_tipo = 'custo' then
    update public.financeiro_despesas set ai_request_id = v_request_id where id = p_row_id;
  else
    update public.financeiro_receitas set ai_request_id = v_request_id where id = p_row_id;
  end if;
end;
$$;

create function public.iniciar_relatorio_financeiro(p_client_id uuid, p_ano integer, p_mes integer) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_client_name text;
  v_despesas jsonb;
  v_receitas jsonb;
  v_total_despesa numeric;
  v_total_receita numeric;
  v_prompt text;
  v_request_id bigint;
  v_row_id uuid;
begin
  if public.current_role() <> 'equipa' then
    raise exception 'Apenas a equipa pode gerar relatórios.';
  end if;

  select name into v_client_name from public.clients where id = p_client_id;

  select coalesce(jsonb_agg(jsonb_build_object('data', date, 'fornecedor', vendor, 'rubrica', rubrica, 'valor', amount)), '[]'::jsonb),
         coalesce(sum(amount), 0)
    into v_despesas, v_total_despesa
  from public.financeiro_despesas
  where client_id = p_client_id and extract(year from date) = p_ano and extract(month from date) = p_mes;

  select coalesce(jsonb_agg(jsonb_build_object('data', date, 'descricao', description, 'valor', amount)), '[]'::jsonb),
         coalesce(sum(amount), 0)
    into v_receitas, v_total_receita
  from public.financeiro_receitas
  where client_id = p_client_id and extract(year from date) = p_ano and extract(month from date) = p_mes;

  v_prompt := 'Escreve um relatório financeiro mensal CURTO (máximo 200 palavras) em português de Portugal para o cliente "' || coalesce(v_client_name, 'Cliente') ||
    '", referente ao mês ' || p_mes || '/' || p_ano || '.' || chr(10) ||
    'Receita total: ' || v_total_receita || ' EUR. Despesa total: ' || v_total_despesa || ' EUR. Margem: ' || (v_total_receita - v_total_despesa) || ' EUR.' || chr(10) ||
    'Despesas detalhadas (JSON): ' || v_despesas::text || chr(10) ||
    'Receitas detalhadas (JSON): ' || v_receitas::text || chr(10) ||
    'Estrutura em Markdown, de forma muito concisa: um resumo executivo de 1-2 frases, principais insights sobre as despesas (rubricas que mais pesam), o estado da margem, e no máximo 2 recomendações práticas. Tom profissional, direto, sem rodeios. Não uses tabelas em markdown.';

  insert into public.financeiro_relatorios (client_id, ano, mes, status)
  values (p_client_id, p_ano, p_mes, 'processando')
  returning id into v_row_id;

  select net.http_post(
    url := 'https://api.anthropic.com/v1/messages',
    headers := jsonb_build_object('x-api-key', '<ANTHROPIC_API_KEY removida>', 'anthropic-version', '2023-06-01', 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'model', 'claude-sonnet-5',
      'max_tokens', 700,
      'messages', jsonb_build_array(jsonb_build_object('role', 'user', 'content', v_prompt))
    ),
    timeout_milliseconds := 30000
  ) into v_request_id;

  update public.financeiro_relatorios set ai_request_id = v_request_id where id = v_row_id;

  return v_row_id;
end;
$$;

create function public.gerar_relatorio_financeiro(p_client_id uuid, p_ano integer, p_mes integer) returns text
language plpgsql security definer set search_path = public set statement_timeout = '35s' as $$
declare
  v_client_name text;
  v_despesas jsonb;
  v_receitas jsonb;
  v_total_despesa numeric;
  v_total_receita numeric;
  v_request_id bigint;
  v_status int;
  v_content text;
  v_tries int := 0;
  v_prompt text;
begin
  if public.current_role() <> 'equipa' then
    raise exception 'Apenas a equipa pode gerar relatórios.';
  end if;

  select name into v_client_name from public.clients where id = p_client_id;

  select coalesce(jsonb_agg(jsonb_build_object('data', date, 'fornecedor', vendor, 'rubrica', rubrica, 'valor', amount)), '[]'::jsonb),
         coalesce(sum(amount), 0)
    into v_despesas, v_total_despesa
  from public.financeiro_despesas
  where client_id = p_client_id and extract(year from date) = p_ano and extract(month from date) = p_mes;

  select coalesce(jsonb_agg(jsonb_build_object('data', date, 'descricao', description, 'valor', amount)), '[]'::jsonb),
         coalesce(sum(amount), 0)
    into v_receitas, v_total_receita
  from public.financeiro_receitas
  where client_id = p_client_id and extract(year from date) = p_ano and extract(month from date) = p_mes;

  v_prompt := 'Escreve um relatório financeiro mensal em português de Portugal para o cliente "' || coalesce(v_client_name, 'Cliente') ||
    '", referente ao mês ' || p_mes || '/' || p_ano || '.' || chr(10) ||
    'Receita total: ' || v_total_receita || ' EUR. Despesa total: ' || v_total_despesa || ' EUR. Margem: ' || (v_total_receita - v_total_despesa) || ' EUR.' || chr(10) ||
    'Despesas detalhadas (JSON): ' || v_despesas::text || chr(10) ||
    'Receitas detalhadas (JSON): ' || v_receitas::text || chr(10) ||
    'Estrutura o relatório em Markdown com: um resumo executivo curto, principais insights sobre as despesas (rubricas que mais pesam, fornecedores relevantes, qualquer anomalia ou aumento notável), o estado da margem face à receita, e 2-3 recomendações práticas e específicas. Tom profissional mas simples e direto, pronto a mostrar ao cliente. Não uses tabelas em markdown.';

  select net.http_post(
    url := 'https://api.anthropic.com/v1/messages',
    headers := jsonb_build_object('x-api-key', '<ANTHROPIC_API_KEY removida>', 'anthropic-version', '2023-06-01', 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'model', 'claude-sonnet-5',
      'max_tokens', 1800,
      'messages', jsonb_build_array(jsonb_build_object('role', 'user', 'content', v_prompt))
    ),
    timeout_milliseconds := 30000
  ) into v_request_id;

  loop
    perform pg_sleep(1);
    select status_code, content into v_status, v_content from net._http_response where id = v_request_id;
    v_tries := v_tries + 1;
    exit when v_content is not null or v_tries > 32;
  end loop;

  if v_content is null then
    return 'Não foi possível gerar o relatório a tempo. Tenta novamente.';
  end if;

  if v_status is distinct from 200 then
    return 'Erro ao gerar relatório (' || coalesce(v_status::text, '—') || '): ' || left(v_content, 300);
  end if;

  return (v_content::jsonb -> 'content' -> 0 ->> 'text');
end;
$$;

create function public.processar_documento_financeiro(p_client_id uuid, p_tipo text, p_storage_path text, p_mime_type text, p_file_base64 text) returns jsonb
language plpgsql security definer set search_path = public set statement_timeout = '35s' as $$
declare
  v_request_id bigint;
  v_status int;
  v_content text;
  v_tries int := 0;
  v_prompt text;
  v_result jsonb;
  v_rubrica text;
  v_row jsonb;
begin
  if p_client_id <> public.current_client_id() and public.current_role() <> 'equipa' then
    raise exception 'Sem permissão para este cliente.';
  end if;

  v_prompt := case when p_tipo = 'custo' then
    'Analisa este documento (fatura de despesa). Responde APENAS com um objeto JSON válido (sem markdown, sem texto à volta), com exatamente estes campos: {"fornecedor": string, "data": "YYYY-MM-DD", "valor": number, "rubrica": uma destas opções exatas ["Comissões OPERA","Manutenção","Condomínio","Seguros","Limpeza","Marketing","Impostos","Utilities","Outros"]}. Usa a tua melhor estimativa se algum campo não estiver totalmente claro.'
  else
    'Analisa este documento (fatura emitida / comprovativo de receita). Responde APENAS com um objeto JSON válido (sem markdown, sem texto à volta), com exatamente estes campos: {"descricao": string, "data": "YYYY-MM-DD", "valor": number}.'
  end;

  select net.http_post(
    url := 'https://api.anthropic.com/v1/messages',
    headers := jsonb_build_object('x-api-key', '<ANTHROPIC_API_KEY removida>', 'anthropic-version', '2023-06-01', 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'model', 'claude-sonnet-5',
      'max_tokens', 500,
      'messages', jsonb_build_array(jsonb_build_object(
        'role', 'user',
        'content', jsonb_build_array(
          jsonb_build_object(
            'type', case when p_mime_type = 'application/pdf' then 'document' else 'image' end,
            'source', jsonb_build_object('type', 'base64', 'media_type', p_mime_type, 'data', p_file_base64)
          ),
          jsonb_build_object('type', 'text', 'text', v_prompt)
        )
      ))
    ),
    timeout_milliseconds := 30000
  ) into v_request_id;

  loop
    perform pg_sleep(1);
    select status_code, content into v_status, v_content from net._http_response where id = v_request_id;
    v_tries := v_tries + 1;
    exit when v_content is not null or v_tries > 32;
  end loop;

  if v_content is null then
    raise exception 'Tempo esgotado a ler o documento. Tenta novamente.';
  end if;
  if v_status is distinct from 200 then
    raise exception 'Erro ao ler documento (%): %', coalesce(v_status::text, '—'), left(v_content, 300);
  end if;

  begin
    v_result := ((v_content::jsonb -> 'content' -> 0 ->> 'text'))::jsonb;
  exception when others then
    raise exception 'Não consegui interpretar a resposta da IA para este documento.';
  end;

  if p_tipo = 'custo' then
    v_rubrica := coalesce(v_result->>'rubrica', 'Outros');
    if v_rubrica not in ('Comissões OPERA','Manutenção','Condomínio','Seguros','Limpeza','Marketing','Impostos','Utilities','Outros') then
      v_rubrica := 'Outros';
    end if;
    insert into public.financeiro_despesas (client_id, date, vendor, rubrica, amount, source, storage_path)
    values (p_client_id, (v_result->>'data')::date, coalesce(v_result->>'fornecedor', 'Desconhecido'), v_rubrica, (v_result->>'valor')::numeric, 'upload', p_storage_path)
    returning to_jsonb(financeiro_despesas.*) into v_row;
  else
    insert into public.financeiro_receitas (client_id, date, description, amount, source, storage_path)
    values (p_client_id, (v_result->>'data')::date, coalesce(v_result->>'descricao', 'Receita'), (v_result->>'valor')::numeric, 'upload', p_storage_path)
    returning to_jsonb(financeiro_receitas.*) into v_row;
  end if;

  return v_row;
end;
$$;

create function public.processar_respostas_ia() returns void
language plpgsql security definer set search_path = public as $$
declare
  rec record;
begin
  for rec in
    select id, ai_request_id, 'despesa' as tipo from public.financeiro_despesas where status = 'processando' and ai_request_id is not null
    union all
    select id, ai_request_id, 'receita' as tipo from public.financeiro_receitas where status = 'processando' and ai_request_id is not null
  loop
    declare
      v_status int;
      v_content text;
      v_text text;
      v_start int;
      v_end int;
      v_result jsonb;
      v_rubrica text;
    begin
      select status_code, content into v_status, v_content from net._http_response where id = rec.ai_request_id;
      if v_content is null then
        continue;
      end if;

      if v_status is distinct from 200 then
        if rec.tipo = 'despesa' then
          update public.financeiro_despesas set status = 'erro', ai_error = left(v_content, 300) where id = rec.id;
        else
          update public.financeiro_receitas set status = 'erro', ai_error = left(v_content, 300) where id = rec.id;
        end if;
        continue;
      end if;

      begin
        select elem->>'text' into v_text
        from jsonb_array_elements(v_content::jsonb -> 'content') as elem
        where elem->>'type' = 'text'
        limit 1;
        v_text := trim(v_text);
        v_start := position('{' in v_text);
        v_end := length(v_text) - position('}' in reverse(v_text)) + 1;
        if v_start > 0 and v_end >= v_start then
          v_text := substring(v_text from v_start for (v_end - v_start + 1));
        end if;
        v_result := v_text::jsonb;
      exception when others then
        if rec.tipo = 'despesa' then
          update public.financeiro_despesas set status = 'erro', ai_error = 'Resposta inválida da IA: ' || left(coalesce(v_text, v_content), 200) where id = rec.id;
        else
          update public.financeiro_receitas set status = 'erro', ai_error = 'Resposta inválida da IA: ' || left(coalesce(v_text, v_content), 200) where id = rec.id;
        end if;
        continue;
      end;

      if rec.tipo = 'despesa' then
        v_rubrica := coalesce(v_result->>'rubrica', 'Outros');
        if v_rubrica not in ('Manutenção','Condomínio','Seguros','Limpeza','Marketing','Impostos','Utilities','Tecnologia','Equipamentos','Material de Escritório','Outros') then
          v_rubrica := 'Outros';
        end if;
        update public.financeiro_despesas
        set vendor = coalesce(v_result->>'fornecedor', 'Desconhecido'),
            date = (v_result->>'data')::date,
            amount = (v_result->>'valor')::numeric,
            rubrica = v_rubrica,
            iva = coalesce((v_result->>'iva')::numeric, 0),
            status = 'processado'
        where id = rec.id;
      else
        update public.financeiro_receitas
        set description = coalesce(v_result->>'descricao', 'Receita'),
            iva = coalesce((v_result->>'iva')::numeric, 0),
            date = (v_result->>'data')::date,
            amount = (v_result->>'valor')::numeric,
            status = 'processado'
        where id = rec.id;
      end if;
    end;
  end loop;

  for rec in
    select id, ai_request_id from public.financeiro_relatorios where status = 'processando' and ai_request_id is not null
  loop
    declare
      v_status int;
      v_content text;
      v_text text;
    begin
      select status_code, content into v_status, v_content from net._http_response where id = rec.ai_request_id;
      if v_content is null then
        continue;
      end if;
      if v_status is distinct from 200 then
        update public.financeiro_relatorios set status = 'erro', ai_error = left(v_content, 300) where id = rec.id;
        continue;
      end if;
      begin
        select elem->>'text' into v_text
        from jsonb_array_elements(v_content::jsonb -> 'content') as elem
        where elem->>'type' = 'text'
        limit 1;
      exception when others then
        v_text := null;
      end;
      if v_text is null then
        update public.financeiro_relatorios set status = 'erro',
          ai_error = 'Resposta inválida (' || length(v_content) || ' chars): ' || right(v_content, 150)
        where id = rec.id;
      else
        update public.financeiro_relatorios set status = 'processado', texto = v_text where id = rec.id;
      end if;
    end;
  end loop;
end;
$$;

select cron.schedule('processar-ia-financeiro', '10 seconds', 'select public.processar_respostas_ia();');

-- ============================================================ ROW LEVEL SECURITY
alter table public.clients enable row level security;
alter table public.profiles enable row level security;
alter table public.client_invites enable row level security;
alter table public.client_notes enable row level security;
alter table public.client_activities enable row level security;
alter table public.deals enable row level security;
alter table public.pedidos enable row level security;
alter table public.pedido_tasks enable row level security;
alter table public.pedido_notes enable row level security;
alter table public.pedido_attachments enable row level security;
alter table public.pedido_mensagens enable row level security;
alter table public.feedback_respostas enable row level security;
alter table public.financeiro_despesas enable row level security;
alter table public.financeiro_receitas enable row level security;
alter table public.financeiro_extrato enable row level security;
alter table public.financeiro_relatorios enable row level security;

create policy "ver o próprio perfil" on public.profiles for select
  using (id = auth.uid() or public."current_role"() = 'equipa');
create policy "equipa gere perfis" on public.profiles for update
  using (public."current_role"() = 'equipa');

create policy "equipa vê todos os clientes" on public.clients for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "cliente vê a própria ficha" on public.clients for select
  using (id = public.current_client_id());

create policy "equipa gere convites" on public.client_invites for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "equipa gere notas de cliente" on public.client_notes for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "equipa gere atividades de cliente" on public.client_activities for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "equipa gere negócios" on public.deals for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');

create policy "equipa gere todos os pedidos" on public.pedidos for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "cliente vê os próprios pedidos" on public.pedidos for select
  using (client_id = public.current_client_id());
create policy "cliente cria os próprios pedidos" on public.pedidos for insert
  with check (client_id = public.current_client_id());
create policy "cliente edita os próprios pedidos" on public.pedidos for update
  using (client_id = public.current_client_id()) with check (client_id = public.current_client_id());

create policy "equipa gere tarefas dos pedidos" on public.pedido_tasks for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "equipa gere notas internas dos pedidos" on public.pedido_notes for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');

create policy "equipa vê todos os anexos" on public.pedido_attachments for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "cliente vê e envia anexos dos próprios pedidos" on public.pedido_attachments for select
  using (exists (select 1 from public.pedidos where pedidos.id = pedido_attachments.pedido_id and pedidos.client_id = public.current_client_id()));
create policy "cliente insere anexos nos próprios pedidos" on public.pedido_attachments for insert
  with check (uploaded_by = 'cliente' and exists (select 1 from public.pedidos where pedidos.id = pedido_attachments.pedido_id and pedidos.client_id = public.current_client_id()));

create policy "equipa vê e envia todas as mensagens" on public.pedido_mensagens for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "cliente vê mensagens dos próprios pedidos" on public.pedido_mensagens for select
  using (exists (select 1 from public.pedidos where pedidos.id = pedido_mensagens.pedido_id and pedidos.client_id = public.current_client_id()));
create policy "cliente envia mensagens nos próprios pedidos" on public.pedido_mensagens for insert
  with check (sender = 'cliente' and exists (select 1 from public.pedidos where pedidos.id = pedido_mensagens.pedido_id and pedidos.client_id = public.current_client_id()));

create policy "feedback: inserir publico" on public.feedback_respostas for insert
  to anon, authenticated with check (true);
create policy "feedback: leitura equipa" on public.feedback_respostas for select
  to authenticated using (lower(auth.jwt() ->> 'email') like '%@opera-os.com');

create policy "equipa gere despesas" on public.financeiro_despesas for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "cliente vê as próprias despesas" on public.financeiro_despesas for select
  using (client_id = public.current_client_id() and public.current_is_responsavel());
create policy "cliente insere despesas próprias" on public.financeiro_despesas for insert
  with check (client_id = public.current_client_id() and public.current_is_responsavel());
create policy "cliente apaga despesas próprias" on public.financeiro_despesas for delete
  using (client_id = public.current_client_id() and public.current_is_responsavel());

create policy "equipa gere receitas" on public.financeiro_receitas for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "cliente vê as próprias receitas" on public.financeiro_receitas for select
  using (client_id = public.current_client_id() and public.current_is_responsavel());
create policy "cliente insere receitas próprias" on public.financeiro_receitas for insert
  with check (client_id = public.current_client_id() and public.current_is_responsavel());
create policy "cliente apaga receitas próprias" on public.financeiro_receitas for delete
  using (client_id = public.current_client_id() and public.current_is_responsavel());

create policy "equipa gere extrato" on public.financeiro_extrato for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');
create policy "cliente vê o próprio extrato" on public.financeiro_extrato for select
  using (client_id = public.current_client_id() and public.current_is_responsavel());
create policy "cliente insere extrato próprio" on public.financeiro_extrato for insert
  with check (client_id = public.current_client_id() and public.current_is_responsavel());
create policy "cliente apaga extrato próprio" on public.financeiro_extrato for delete
  using (client_id = public.current_client_id() and public.current_is_responsavel());

create policy "equipa gere relatorios" on public.financeiro_relatorios for all
  using (public."current_role"() = 'equipa') with check (public."current_role"() = 'equipa');

-- ============================================================ STORAGE
insert into storage.buckets (id, name, public) values ('attachments', 'attachments', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('financeiro-docs', 'financeiro-docs', false) on conflict (id) do nothing;

create policy "equipa gere todos os anexos (storage)" on storage.objects for all
  using (bucket_id = 'attachments' and public."current_role"() = 'equipa')
  with check (bucket_id = 'attachments' and public."current_role"() = 'equipa');
create policy "cliente vê anexos dos próprios pedidos (storage)" on storage.objects for select
  using (bucket_id = 'attachments' and exists (select 1 from public.pedidos where pedidos.id::text = (storage.foldername(objects.name))[1] and pedidos.client_id = public.current_client_id()));
create policy "cliente envia anexos nos próprios pedidos (storage)" on storage.objects for insert
  with check (bucket_id = 'attachments' and exists (select 1 from public.pedidos where pedidos.id::text = (storage.foldername(objects.name))[1] and pedidos.client_id = public.current_client_id()));

create policy "equipa gere documentos financeiros (storage)" on storage.objects for all
  using (bucket_id = 'financeiro-docs' and public."current_role"() = 'equipa')
  with check (bucket_id = 'financeiro-docs' and public."current_role"() = 'equipa');
create policy "cliente vê os próprios documentos financeiros (storage)" on storage.objects for select
  using (bucket_id = 'financeiro-docs' and (storage.foldername(name))[1] = public.current_client_id()::text and public.current_is_responsavel());
create policy "cliente envia documentos financeiros próprios (storage)" on storage.objects for insert
  with check (bucket_id = 'financeiro-docs' and (storage.foldername(name))[1] = public.current_client_id()::text and public.current_is_responsavel());

-- ============================================================ REALTIME
alter publication supabase_realtime add table
  public.client_activities, public.client_invites, public.client_notes, public.clients,
  public.financeiro_despesas, public.financeiro_extrato, public.financeiro_receitas,
  public.pedido_attachments, public.pedido_notes, public.pedido_tasks, public.profiles;
