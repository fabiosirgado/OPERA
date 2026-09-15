-- ============================================================
-- OPERA CRM / Portal do Cliente — Esquema Supabase
-- ============================================================
-- Como usar:
-- 1. Cria um novo projeto em https://supabase.com
-- 2. Vai a "SQL Editor" no painel do Supabase
-- 3. Cola este ficheiro inteiro e corre ("Run")
-- 4. Ativa "Email" em Authentication > Providers (magic link)
--
-- Isto cria: perfis com role (cliente/equipa), clientes, negócios (CRM),
-- pedidos operacionais + tarefas/notas/mensagens/anexos, o lado
-- interno (notas e atividades por cliente), e o bucket de Storage +
-- políticas para os anexos dos pedidos. RLS já vem configurado para
-- que um cliente só veja os seus próprios dados.
--
-- NOTA: este ficheiro é o schema original do handoff técnico com duas
-- adições necessárias para a app funcionar: (a) profiles.email (para a
-- equipa poder associar uma conta registada a uma ficha de cliente sem
-- precisar de aceder a auth.users), e (b) o bucket de Storage
-- "attachments" com as respetivas políticas.
-- ============================================================


-- ------------------------------------------------------------
-- EXTENSÕES
-- ------------------------------------------------------------
create extension if not exists "pgcrypto";


-- ------------------------------------------------------------
-- CLIENTES
-- ------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- PERFIS (ligados ao login do Supabase Auth)
-- ------------------------------------------------------------
-- role: 'cliente' ou 'equipa'
-- client_id: preenchido apenas quando role = 'cliente'
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'cliente' check (role in ('cliente', 'equipa')),
  client_id uuid references public.clients (id) on delete set null,
  full_name text,
  email text,
  created_at timestamptz not null default now()
);

-- Cria automaticamente um perfil (role='cliente' por defeito) sempre que
-- alguém se regista. Para dar acesso de equipa a alguém, muda o role
-- manualmente na tabela profiles depois do primeiro login.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Função auxiliar usada pelas políticas abaixo
create function public.current_role()
returns text
language sql stable
security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create function public.current_client_id()
returns uuid
language sql stable
security definer set search_path = public
as $$
  select client_id from public.profiles where id = auth.uid();
$$;


-- ------------------------------------------------------------
-- NEGÓCIOS (CRM Comercial — funil de vendas)
-- Só a equipa OPERA tem acesso; não é exposto ao cliente.
-- ------------------------------------------------------------
create table public.deals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete set null,
  name text not null,
  contact text,
  value numeric not null default 0,
  stage text not null default 'Lead',
  owner text,
  stage_entered_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- PEDIDOS (Operacional — pedidos dos clientes)
-- ------------------------------------------------------------
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
  completed_at timestamptz
);

-- Tarefas internas de cada pedido (não visíveis ao cliente)
create table public.pedido_tasks (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

-- Notas internas de cada pedido (não visíveis ao cliente)
create table public.pedido_notes (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- Anexos (fotos/documentos) — visíveis a ambos os lados
create table public.pedido_attachments (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  name text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

-- Conversa entre cliente e equipa dentro de cada pedido
create table public.pedido_mensagens (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  sender text not null check (sender in ('cliente', 'equipa')),
  text text not null,
  created_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- FICHA DE CLIENTE (uso interno da equipa — notas e atividades)
-- ------------------------------------------------------------
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


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.deals enable row level security;
alter table public.pedidos enable row level security;
alter table public.pedido_tasks enable row level security;
alter table public.pedido_notes enable row level security;
alter table public.pedido_attachments enable row level security;
alter table public.pedido_mensagens enable row level security;
alter table public.client_notes enable row level security;
alter table public.client_activities enable row level security;

-- ---------------- profiles ----------------
create policy "ver o próprio perfil"
  on public.profiles for select
  using (id = auth.uid() or public.current_role() = 'equipa');

create policy "equipa gere perfis"
  on public.profiles for update
  using (public.current_role() = 'equipa');

-- ---------------- clients ----------------
create policy "equipa vê todos os clientes"
  on public.clients for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

create policy "cliente vê a própria ficha"
  on public.clients for select
  using (id = public.current_client_id());

-- ---------------- deals (só equipa) ----------------
create policy "equipa gere negócios"
  on public.deals for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

-- ---------------- pedidos ----------------
create policy "equipa gere todos os pedidos"
  on public.pedidos for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

create policy "cliente vê os próprios pedidos"
  on public.pedidos for select
  using (client_id = public.current_client_id());

create policy "cliente cria os próprios pedidos"
  on public.pedidos for insert
  with check (client_id = public.current_client_id());

create policy "cliente edita os próprios pedidos"
  on public.pedidos for update
  using (client_id = public.current_client_id())
  with check (client_id = public.current_client_id());

-- ---------------- pedido_tasks / pedido_notes (só equipa) ----------------
create policy "equipa gere tarefas dos pedidos"
  on public.pedido_tasks for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

create policy "equipa gere notas internas dos pedidos"
  on public.pedido_notes for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

-- ---------------- pedido_attachments ----------------
create policy "equipa vê todos os anexos"
  on public.pedido_attachments for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

create policy "cliente vê e envia anexos dos próprios pedidos"
  on public.pedido_attachments for select
  using (
    exists (
      select 1 from public.pedidos
      where pedidos.id = pedido_attachments.pedido_id
      and pedidos.client_id = public.current_client_id()
    )
  );

create policy "cliente insere anexos nos próprios pedidos"
  on public.pedido_attachments for insert
  with check (
    exists (
      select 1 from public.pedidos
      where pedidos.id = pedido_attachments.pedido_id
      and pedidos.client_id = public.current_client_id()
    )
  );

-- ---------------- pedido_mensagens ----------------
create policy "equipa vê e envia todas as mensagens"
  on public.pedido_mensagens for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

create policy "cliente vê mensagens dos próprios pedidos"
  on public.pedido_mensagens for select
  using (
    exists (
      select 1 from public.pedidos
      where pedidos.id = pedido_mensagens.pedido_id
      and pedidos.client_id = public.current_client_id()
    )
  );

create policy "cliente envia mensagens nos próprios pedidos"
  on public.pedido_mensagens for insert
  with check (
    sender = 'cliente'
    and exists (
      select 1 from public.pedidos
      where pedidos.id = pedido_mensagens.pedido_id
      and pedidos.client_id = public.current_client_id()
    )
  );

-- ---------------- client_notes / client_activities (só equipa) ----------------
create policy "equipa gere notas de cliente"
  on public.client_notes for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');

create policy "equipa gere atividades de cliente"
  on public.client_activities for all
  using (public.current_role() = 'equipa')
  with check (public.current_role() = 'equipa');


-- ============================================================
-- STORAGE (anexos dos pedidos)
-- ============================================================
-- Caminho dos ficheiros: "<pedido_id>/<timestamp>_<nome-original>"
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy "equipa gere todos os anexos (storage)"
  on storage.objects for all
  using (bucket_id = 'attachments' and public.current_role() = 'equipa')
  with check (bucket_id = 'attachments' and public.current_role() = 'equipa');

create policy "cliente vê anexos dos próprios pedidos (storage)"
  on storage.objects for select
  using (
    bucket_id = 'attachments'
    and exists (
      select 1 from public.pedidos
      where pedidos.id::text = (storage.foldername(name))[1]
      and pedidos.client_id = public.current_client_id()
    )
  );

create policy "cliente envia anexos nos próprios pedidos (storage)"
  on storage.objects for insert
  with check (
    bucket_id = 'attachments'
    and exists (
      select 1 from public.pedidos
      where pedidos.id::text = (storage.foldername(name))[1]
      and pedidos.client_id = public.current_client_id()
    )
  );


-- ============================================================
-- ÍNDICES (para as consultas mais comuns)
-- ============================================================
create index idx_pedidos_client_id on public.pedidos (client_id);
create index idx_pedidos_stage on public.pedidos (stage);
create index idx_deals_client_id on public.deals (client_id);
create index idx_deals_stage on public.deals (stage);
create index idx_pedido_tasks_pedido_id on public.pedido_tasks (pedido_id);
create index idx_pedido_notes_pedido_id on public.pedido_notes (pedido_id);
create index idx_pedido_attachments_pedido_id on public.pedido_attachments (pedido_id);
create index idx_pedido_mensagens_pedido_id on public.pedido_mensagens (pedido_id);
create index idx_client_notes_client_id on public.client_notes (client_id);
create index idx_client_activities_client_id on public.client_activities (client_id);


-- ============================================================
-- PRIMEIRO UTILIZADOR DA EQUIPA (fazer manualmente depois do 1º login)
-- ============================================================
-- Depois de te registares com o teu email pela primeira vez, corre:
--
--   update public.profiles
--   set role = 'equipa', full_name = 'Fábio Sirgado'
--   where id = (select id from auth.users where email = 'fabio.sirgado@opera-os.com');
--
-- Repete para a Nicole e para qualquer outro membro da equipa.
-- Todos os outros registos (via Portal do Cliente) ficam automaticamente
-- como role='cliente'.
--
-- ============================================================
-- ACESSO DOS CLIENTES AO PORTAL
-- ============================================================
-- Quando um contacto de um cliente se regista no Portal do Cliente (com
-- o mesmo ecrã de login, via magic link), fica automaticamente com
-- role='cliente' mas SEM client_id (a app não sabe a que cliente
-- corresponde o email). Um membro da equipa tem de associar essa conta
-- a uma ficha de cliente uma única vez: dentro da app, abrir
-- Clientes > [cliente] > "Acesso ao portal" e escolher a conta na lista
-- de "Associar conta registada…". A partir daí o utilizador já vê os
-- pedidos desse cliente sempre que entra.
