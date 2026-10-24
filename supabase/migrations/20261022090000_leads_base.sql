-- OPERA Leads, Fase 1: tabelas, permissões (RLS), etapas base, etiquetas iniciais,
-- desativação de clientes com apagamento aos 6 meses e registo de atividade.
--
-- Convivência com o OPERA OS (CRM):
-- * Reutiliza public.clients e public.profiles, acrescentando só colunas novas.
-- * O papel no Leads fica em profiles.leads_role e não mexe em profiles.role, que o CRM usa.
-- * As tabelas novas têm o prefixo lead_ para não se confundirem com as do CRM.

create extension if not exists pg_trgm with schema extensions;

-- Funções auxiliares das regras de acesso: num esquema que a API não expõe, para não poderem ser
-- chamadas diretamente. As políticas usam-nas com as permissões de quem faz o pedido.
create schema if not exists private;
grant usage on schema private to anon, authenticated;

-- ============================================================ COLUNAS NOVAS EM TABELAS EXISTENTES
alter table public.profiles
  add column leads_role text check (leads_role in ('admin', 'gestor', 'cliente_admin', 'cliente')),
  add column leads_status text not null default 'ativo' check (leads_status in ('convidado', 'ativo', 'desativado')),
  add column leads_invited_at timestamptz,
  add column leads_invited_by uuid references public.profiles (id) on delete set null;

alter table public.clients
  add column color text not null default '#3B6FE0',
  add column inbox_alias text unique check (inbox_alias ~ '^[a-z0-9][a-z0-9.-]{0,40}$'),
  add column manager_id uuid references public.profiles (id) on delete set null,
  add column leads_status text not null default 'ativo' check (leads_status in ('ativo', 'inativo')),
  add column leads_deactivated_at timestamptz,
  add column leads_purge_at timestamptz;

-- ============================================================ FUNÇÕES DE ACESSO
-- Todas leem o perfil de quem chama. A equipa OPERA só tem acesso com verificação em dois passos (aal2).
create function private.leads_role() returns text
language sql stable security definer set search_path = public as $$
  select leads_role from public.profiles where id = auth.uid() and leads_status = 'ativo';
$$;

create function private.leads_is_opera() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(private.leads_role() in ('admin', 'gestor'), false)
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

create function private.leads_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(private.leads_role() = 'admin', false)
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- Cliente de quem chama, só se for utilizador de cliente ativo e o cliente estiver ativo no Leads.
create function private.leads_my_client_id() returns uuid
language sql stable security definer set search_path = public as $$
  select p.client_id
    from public.profiles p join public.clients c on c.id = p.client_id
   where p.id = auth.uid()
     and p.leads_status = 'ativo'
     and p.leads_role in ('cliente_admin', 'cliente')
     and c.leads_status = 'ativo';
$$;

create function private.leads_is_cliente_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select private.leads_my_client_id() is not null and private.leads_role() = 'cliente_admin';
$$;

create function private.leads_client_active(p_client_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select leads_status = 'ativo' from public.clients where id = p_client_id), false);
$$;

-- ============================================================ ETAPAS
create table public.lead_stages (
  id uuid primary key default gen_random_uuid(),
  key text unique,
  name text not null check (char_length(name) between 1 and 60),
  color text not null default '#64748B',
  position numeric not null,
  client_id uuid references public.clients (id) on delete cascade,
  owner text not null default 'ambos' check (owner in ('opera', 'cliente', 'ambos')),
  is_base boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Etapas extra só entre Lead Qualificada (50) e Lead desqualificada (999).
  constraint lead_stages_extra_depois_de_qualificada check (is_base or (position > 50 and position < 999))
);

create index lead_stages_client_idx on public.lead_stages (client_id, position);

create function private.lead_stage_position(p_stage_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select position from public.lead_stages where id = p_stage_id;
$$;

-- A etapa tem de ser comum a todos ou do próprio cliente da lead.
create function private.lead_stage_fits(p_stage_id uuid, p_client_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lead_stages
                  where id = p_stage_id and (client_id is null or client_id = p_client_id));
$$;

-- ============================================================ ETIQUETAS
create table public.lead_labels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 40),
  color text not null default 'cinzento'
    check (color in ('vermelho', 'laranja', 'amarelo', 'verde', 'azul', 'roxo', 'rosa', 'cinzento')),
  created_at timestamptz not null default now()
);

-- ============================================================ LEADS
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  name text not null default '',
  phone text,
  phone_norm text,
  email text,
  source text,
  interest text,
  stage_id uuid not null references public.lead_stages (id),
  qualification jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  source_created_at timestamptz,
  first_call_at timestamptz,
  last_contact_at timestamptz,
  external_id text,
  owner_user_id uuid references public.profiles (id) on delete set null,
  anonymized boolean not null default false,
  entry_stage text not null check (entry_stage in ('meta', 'imoveis', 'bd')),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint leads_external_id_unico unique (client_id, external_id)
);

create index leads_client_stage_idx on public.leads (client_id, stage_id);
create index leads_client_phone_idx on public.leads (client_id, phone_norm);
create index leads_client_email_idx on public.leads (client_id, lower(email));
create index leads_stage_idx on public.leads (stage_id);
create index leads_owner_idx on public.leads (owner_user_id);
create index leads_name_trgm on public.leads using gin (name extensions.gin_trgm_ops);
create index leads_phone_trgm on public.leads using gin (phone_norm extensions.gin_trgm_ops);
create index leads_email_trgm on public.leads using gin (email extensions.gin_trgm_ops);
create index leads_interest_trgm on public.leads using gin (interest extensions.gin_trgm_ops);

-- Telefone normalizado: só dígitos, sem o indicativo 351.
create function private.leads_normalize_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '^(00)?351(?=\d{9}$)', ''), '');
$$;

create function public.leads_before_write() returns trigger
language plpgsql set search_path = public as $$
begin
  new.phone_norm := private.leads_normalize_phone(new.phone);
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if new.entry_stage is distinct from old.entry_stage then
      raise exception 'A etapa de entrada de uma lead não pode mudar.';
    end if;
    if new.created_at is distinct from old.created_at then
      raise exception 'A hora de chegada de uma lead não pode mudar.';
    end if;
  end if;
  return new;
end;
$$;

create trigger leads_before_write before insert or update on public.leads
  for each row execute function public.leads_before_write();

create table public.lead_label_links (
  lead_id uuid not null references public.leads (id) on delete cascade,
  label_id uuid not null references public.lead_labels (id) on delete cascade,
  primary key (lead_id, label_id)
);
create index lead_label_links_label_idx on public.lead_label_links (label_id);

-- ============================================================ HISTÓRICO E TAREFAS
create table public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  type text not null check (type in ('call', 'note', 'auto', 'stage')),
  title text,
  body text,
  author_id uuid references public.profiles (id) on delete set null default auth.uid(),
  pinned boolean not null default false,
  edited_at timestamptz,
  from_stage_id uuid references public.lead_stages (id) on delete set null,
  to_stage_id uuid references public.lead_stages (id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index lead_events_lead_idx on public.lead_events (lead_id, created_at desc);
create index lead_events_type_idx on public.lead_events (type, created_at);
create index lead_events_body_trgm on public.lead_events using gin (body extensions.gin_trgm_ops) where type = 'note';

create table public.lead_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  type text not null check (type in ('call', 'meeting', 'followup')),
  due_at timestamptz not null,
  note text,
  done_at timestamptz,
  done_by uuid references public.profiles (id) on delete set null,
  canceled_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index lead_tasks_open_idx on public.lead_tasks (due_at) where done_at is null and canceled_at is null;
create index lead_tasks_lead_idx on public.lead_tasks (lead_id);

-- Cada mudança de etapa fica no histórico, com origem, destino, autor e hora.
create function public.leads_log_stage_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_events (lead_id, type, from_stage_id, to_stage_id, author_id)
    values (new.id, 'stage', old.stage_id, new.stage_id, auth.uid());
  end if;
  return new;
end;
$$;

create trigger leads_log_stage_change after update of stage_id on public.leads
  for each row execute function public.leads_log_stage_change();

-- ============================================================ REGISTOS DE SISTEMA
create table public.audit_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);
create index audit_log_created_idx on public.audit_log (created_at desc);

create table public.inbound_log (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  channel text not null check (channel in ('meta', 'email', 'outro')),
  client_id uuid references public.clients (id) on delete set null,
  raw jsonb,
  status text not null default 'recebido' check (status in ('recebido', 'processado', 'revisao', 'duplicado', 'erro')),
  lead_id uuid references public.leads (id) on delete set null,
  error text
);
create index inbound_log_received_idx on public.inbound_log (received_at desc);

create function public.leads_audit(p_action text, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log (actor_id, action, detail) values (auth.uid(), p_action, coalesce(p_detail, '{}'::jsonb));
$$;

-- ============================================================ PROTEÇÃO DAS COLUNAS DO LEADS
-- O CRM deixa a equipa editar perfis e clientes. As colunas do Leads só mudam pelas funções abaixo
-- (que ligam opera.leads_rpc) ou por um admin do Leads.
create function public.leads_protect_columns() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('opera.leads_rpc', true), '') = 'on' or private.leads_is_admin()
     or auth.uid() is null then
    return new;
  end if;
  -- Um IF por tabela: o PL/pgSQL avalia a condição toda, e new.leads_role não existe em clients
  -- (nem new.manager_id em profiles).
  if tg_table_name = 'profiles' then
    if new.leads_role is distinct from old.leads_role or new.leads_status is distinct from old.leads_status then
      raise exception 'Só um admin do OPERA Leads pode mudar papéis e estados de utilizadores.';
    end if;
  elsif tg_table_name = 'clients' then
    if new.manager_id is distinct from old.manager_id or new.leads_status is distinct from old.leads_status
       or new.leads_purge_at is distinct from old.leads_purge_at then
      raise exception 'Só um admin do OPERA Leads pode mudar o gestor ou o estado de um cliente.';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_leads_protect before update on public.profiles
  for each row execute function public.leads_protect_columns();
create trigger clients_leads_protect before update on public.clients
  for each row execute function public.leads_protect_columns();

-- Máximo de 8 clientes ativos por gestor.
create function public.leads_check_manager_capacity() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.manager_id is not null and new.leads_status = 'ativo'
     and (tg_op = 'INSERT' or new.manager_id is distinct from old.manager_id or new.leads_status is distinct from old.leads_status)
     and (select count(*) from public.clients
           where manager_id = new.manager_id and leads_status = 'ativo' and id <> new.id) >= 8 then
    raise exception 'Este gestor já tem 8 clientes, que é o máximo.';
  end if;
  return new;
end;
$$;

create trigger clients_manager_capacity before insert or update on public.clients
  for each row execute function public.leads_check_manager_capacity();

-- ============================================================ RLS
alter table public.lead_stages enable row level security;
alter table public.lead_labels enable row level security;
alter table public.leads enable row level security;
alter table public.lead_label_links enable row level security;
alter table public.lead_events enable row level security;
alter table public.lead_tasks enable row level security;
alter table public.audit_log enable row level security;
alter table public.inbound_log enable row level security;

-- Pode ler a lead: equipa OPERA (clientes ativos; o admin vê também os inativos) ou utilizador do próprio cliente.
create function private.leads_can_read(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.leads l
     where l.id = p_lead_id
       and (private.leads_is_admin()
            or (private.leads_is_opera() and private.leads_client_active(l.client_id))
            or l.client_id = private.leads_my_client_id()));
$$;

-- Pode mexer na lead: equipa OPERA, ou o cliente a partir de Lead Qualificada.
create function private.leads_can_write(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.leads l
     where l.id = p_lead_id
       and ((private.leads_is_opera() and private.leads_client_active(l.client_id))
            or (l.client_id = private.leads_my_client_id() and private.lead_stage_position(l.stage_id) >= 50)));
$$;

-- lead_stages
create policy "ver etapas" on public.lead_stages for select
  using (private.leads_is_opera() or (private.leads_my_client_id() is not null
         and (client_id is null or client_id = private.leads_my_client_id())));
create policy "opera cria etapas" on public.lead_stages for insert
  with check (private.leads_is_opera() and not is_base);
create policy "cliente cria etapas suas" on public.lead_stages for insert
  with check (not is_base and owner = 'cliente' and client_id = private.leads_my_client_id());
create policy "opera edita etapas" on public.lead_stages for update
  using (private.leads_is_opera() and not is_base) with check (private.leads_is_opera() and not is_base);
create policy "cliente edita etapas suas" on public.lead_stages for update
  using (not is_base and client_id = private.leads_my_client_id())
  with check (not is_base and owner = 'cliente' and client_id = private.leads_my_client_id());
create policy "opera apaga etapas" on public.lead_stages for delete
  using (private.leads_is_opera() and not is_base);
create policy "cliente apaga etapas suas" on public.lead_stages for delete
  using (not is_base and client_id = private.leads_my_client_id());

-- lead_labels: todos os utilizadores do Leads veem; só a equipa OPERA gere.
create policy "ver etiquetas" on public.lead_labels for select
  using (private.leads_is_opera() or private.leads_my_client_id() is not null);
create policy "opera gere etiquetas" on public.lead_labels for all
  using (private.leads_is_opera()) with check (private.leads_is_opera());

-- leads
create policy "ver leads" on public.leads for select
  using (private.leads_is_admin()
         or (private.leads_is_opera() and private.leads_client_active(client_id))
         or client_id = private.leads_my_client_id());
create policy "opera cria leads" on public.leads for insert
  with check (private.leads_is_opera() and private.leads_client_active(client_id)
              and private.lead_stage_fits(stage_id, client_id));
create policy "cliente cria leads suas" on public.leads for insert
  with check (client_id = private.leads_my_client_id() and private.lead_stage_fits(stage_id, client_id));
create policy "opera edita leads" on public.leads for update
  using (private.leads_is_opera() and private.leads_client_active(client_id))
  with check (private.leads_is_opera() and private.leads_client_active(client_id)
              and private.lead_stage_fits(stage_id, client_id));
create policy "cliente edita leads qualificadas" on public.leads for update
  using (client_id = private.leads_my_client_id() and private.lead_stage_position(stage_id) >= 50)
  with check (client_id = private.leads_my_client_id() and private.lead_stage_position(stage_id) >= 50
              and private.lead_stage_fits(stage_id, client_id));
create policy "admin apaga leads" on public.leads for delete
  using (private.leads_is_admin());

-- lead_label_links
create policy "ver etiquetas da lead" on public.lead_label_links for select
  using (private.leads_can_read(lead_id));
create policy "pôr etiqueta" on public.lead_label_links for insert
  with check (private.leads_can_write(lead_id));
create policy "tirar etiqueta" on public.lead_label_links for delete
  using (private.leads_can_write(lead_id));

-- lead_events
create policy "ver histórico" on public.lead_events for select
  using (private.leads_can_read(lead_id));
create policy "opera regista eventos" on public.lead_events for insert
  with check (private.leads_is_opera() and private.leads_can_write(lead_id) and author_id = auth.uid());
create policy "cliente escreve notas" on public.lead_events for insert
  with check (type = 'note' and author_id = auth.uid() and private.leads_my_client_id() is not null
              and private.leads_can_write(lead_id));
create policy "opera edita notas" on public.lead_events for update
  using (private.leads_is_opera() and private.leads_can_write(lead_id))
  with check (private.leads_is_opera() and private.leads_can_write(lead_id));
create policy "cliente edita as suas notas" on public.lead_events for update
  using (type = 'note' and author_id = auth.uid() and private.leads_my_client_id() is not null
         and private.leads_can_write(lead_id))
  with check (type = 'note' and author_id = auth.uid() and private.leads_can_write(lead_id));
create policy "opera apaga notas" on public.lead_events for delete
  using (type = 'note' and private.leads_is_opera() and private.leads_can_write(lead_id));

-- lead_tasks
create policy "ver tarefas" on public.lead_tasks for select
  using (private.leads_can_read(lead_id));
create policy "criar tarefas" on public.lead_tasks for insert
  with check (private.leads_can_write(lead_id));
create policy "editar tarefas" on public.lead_tasks for update
  using (private.leads_can_write(lead_id)) with check (private.leads_can_write(lead_id));
create policy "opera apaga tarefas" on public.lead_tasks for delete
  using (private.leads_is_opera() and private.leads_can_write(lead_id));

-- Registos: só leitura, e só para quem deve.
create policy "admin lê registo de atividade" on public.audit_log for select using (private.leads_is_admin());
create policy "opera lê entradas" on public.inbound_log for select using (private.leads_is_opera());

-- Perfis e clientes (acrescenta às políticas do CRM, não as substitui).
create policy "leads: opera vê perfis" on public.profiles for select using (private.leads_is_opera());
create policy "leads: cliente vê a sua equipa" on public.profiles for select
  using (client_id is not null and client_id = private.leads_my_client_id());
create policy "leads: opera vê clientes" on public.clients for select using (private.leads_is_opera());
create policy "leads: admin cria clientes" on public.clients for insert with check (private.leads_is_admin());

-- ============================================================ AÇÕES DE ADMINISTRAÇÃO
create function public.leads_assign_manager(p_client_id uuid, p_manager_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_admin() then raise exception 'Só o admin atribui gestores.'; end if;
  if p_manager_id is not null and not exists (
       select 1 from public.profiles where id = p_manager_id and leads_role in ('admin', 'gestor') and leads_status = 'ativo') then
    raise exception 'Esse utilizador não é um gestor ativo.';
  end if;
  perform set_config('opera.leads_rpc', 'on', true);
  update public.clients set manager_id = p_manager_id where id = p_client_id;
  perform public.leads_audit('atribuir_gestor', jsonb_build_object('client_id', p_client_id, 'manager_id', p_manager_id));
end;
$$;

create function public.leads_deactivate_client(p_client_id uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_purge timestamptz := now() + interval '6 months';
begin
  if not private.leads_is_admin() then raise exception 'Só o admin desativa clientes.'; end if;
  perform set_config('opera.leads_rpc', 'on', true);
  update public.clients
     set leads_status = 'inativo', leads_deactivated_at = now(), leads_purge_at = v_purge
   where id = p_client_id and leads_status = 'ativo';
  if not found then raise exception 'Cliente não encontrado ou já inativo.'; end if;
  perform public.leads_audit('desativar_cliente', jsonb_build_object('client_id', p_client_id, 'apagar_em', v_purge));
  return v_purge;
end;
$$;

create function public.leads_reactivate_client(p_client_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_admin() then raise exception 'Só o admin reativa clientes.'; end if;
  perform set_config('opera.leads_rpc', 'on', true);
  update public.clients
     set leads_status = 'ativo', leads_deactivated_at = null, leads_purge_at = null
   where id = p_client_id and leads_status = 'inativo';
  if not found then raise exception 'Cliente não encontrado ou já ativo.'; end if;
  perform public.leads_audit('reativar_cliente', jsonb_build_object('client_id', p_client_id));
end;
$$;

-- Apaga já as leads de um cliente inativo. Exige escrever o nome do cliente.
create function public.leads_purge_client_now(p_client_id uuid, p_confirm_name text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_name text; v_count integer;
begin
  if not private.leads_is_admin() then raise exception 'Só o admin apaga dados de clientes.'; end if;
  select name into v_name from public.clients where id = p_client_id and leads_status = 'inativo';
  if v_name is null then raise exception 'Só se apagam dados de clientes inativos.'; end if;
  if p_confirm_name is distinct from v_name then raise exception 'O nome escrito não corresponde ao cliente.'; end if;
  delete from public.leads where client_id = p_client_id;
  get diagnostics v_count = row_count;
  delete from public.lead_stages where client_id = p_client_id;
  perform public.leads_audit('apagar_dados_cliente', jsonb_build_object('client_id', p_client_id, 'leads', v_count));
  return v_count;
end;
$$;

-- Ativar ou desativar um utilizador. Admin e gestores: qualquer utilizador de cliente (e gestores, só o admin).
-- Admin do cliente: só utilizadores do seu cliente, e nunca a si próprio.
create function public.leads_set_user_status(p_user_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_target public.profiles;
begin
  if p_status not in ('ativo', 'desativado') then raise exception 'Estado inválido.'; end if;
  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then raise exception 'Utilizador não encontrado.'; end if;
  if not (
       private.leads_is_admin()
       or (private.leads_is_opera() and v_target.leads_role in ('cliente_admin', 'cliente'))
       or (private.leads_is_cliente_admin() and v_target.client_id = private.leads_my_client_id()
           and v_target.leads_role in ('cliente_admin', 'cliente') and v_target.id <> auth.uid())) then
    raise exception 'Sem permissão para mudar este utilizador.';
  end if;
  perform set_config('opera.leads_rpc', 'on', true);
  update public.profiles set leads_status = p_status where id = p_user_id;
  if p_status = 'desativado' then
    update public.leads set owner_user_id = null where owner_user_id = p_user_id;
  end if;
  perform public.leads_audit(case when p_status = 'ativo' then 'ativar_utilizador' else 'desativar_utilizador' end,
                             jsonb_build_object('user_id', p_user_id));
end;
$$;

-- ============================================================ TAREFAS AGENDADAS (servidor)
create function public.leads_daily_maintenance() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_client record; v_count integer;
begin
  -- Clientes inativos há 6 meses: apagar as leads.
  for v_client in select id from public.clients where leads_status = 'inativo' and leads_purge_at <= now() loop
    delete from public.leads where client_id = v_client.id;
    get diagnostics v_count = row_count;
    delete from public.lead_stages where client_id = v_client.id;
    insert into public.audit_log (action, detail)
    values ('apagamento_automatico', jsonb_build_object('client_id', v_client.id, 'leads', v_count));
  end loop;
  -- RGPD: conteúdo bruto das entradas só fica 30 dias; registo de atividade só 12 meses.
  update public.inbound_log set raw = null where raw is not null and received_at < now() - interval '30 days';
  delete from public.audit_log where created_at < now() - interval '12 months';
end;
$$;

select cron.schedule('leads-manutencao-diaria', '15 3 * * *', 'select public.leads_daily_maintenance();');

-- ============================================================ PERMISSÕES DE EXECUÇÃO
revoke execute on function public.leads_audit(text, jsonb) from public, anon, authenticated;
revoke execute on function public.leads_daily_maintenance() from public, anon, authenticated;
revoke execute on function public.leads_before_write() from public, anon, authenticated;
revoke execute on function public.leads_log_stage_change() from public, anon, authenticated;
revoke execute on function public.leads_protect_columns() from public, anon, authenticated;
revoke execute on function public.leads_check_manager_capacity() from public, anon, authenticated;
revoke execute on function public.leads_assign_manager(uuid, uuid) from public, anon;
revoke execute on function public.leads_deactivate_client(uuid) from public, anon;
revoke execute on function public.leads_reactivate_client(uuid) from public, anon;
revoke execute on function public.leads_purge_client_now(uuid, text) from public, anon;
revoke execute on function public.leads_set_user_status(uuid, text) from public, anon;

-- ============================================================ DADOS BASE
insert into public.lead_stages (key, name, color, position, owner, is_base) values
  ('meta',        'Nova Lead Meta',      '#3B6FE0', 10,  'opera', true),
  ('imoveis',     'Nova lead imóveis',   '#0EA5E9', 20,  'opera', true),
  ('bd',          'Nova Lead BD',        '#64748B', 30,  'opera', true),
  ('followup',    'Follow Up OPERA',     '#F59E0B', 40,  'opera', true),
  ('qualificada', 'Lead Qualificada',    '#10B981', 50,  'ambos', true),
  ('desq',        'Lead desqualificada', '#94A3B8', 999, 'ambos', true);

insert into public.lead_labels (name, color) values
  ('Quente', 'vermelho'), ('Morno', 'amarelo'), ('Frio', 'azul'),
  ('Comprador', 'verde'), ('Proprietário', 'laranja'), ('Investidor', 'roxo');

-- ============================================================ REALTIME
alter publication supabase_realtime add table public.leads, public.lead_events, public.lead_tasks;
