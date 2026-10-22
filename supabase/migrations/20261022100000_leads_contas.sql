-- OPERA Leads, Fase 1: contas e privacidade.
-- Aceitar convites, registar inícios de sessão, resumo para o ecrã Clientes e acessos,
-- anonimização de leads (pedido do titular e regra automática opcional).

-- As Edge Functions (service_role) também passam pelos triggers que usam estas funções.
grant usage on schema private to service_role;

-- ============================================================ CLIENTES ATIVADOS NO LEADS
-- Nem todos os clientes do CRM usam o OPERA Leads. Só os ativados aparecem à equipa do Leads,
-- e só esses contam como clientes ativos. Assim um gestor não vê as fichas do CRM dos outros clientes.
alter table public.clients add column leads_enabled boolean not null default false;

create or replace function private.leads_client_active(p_client_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select leads_enabled and leads_status = 'ativo' from public.clients where id = p_client_id), false);
$$;

create or replace function private.leads_my_client_id() returns uuid
language sql stable security definer set search_path = public as $$
  select p.client_id
    from public.profiles p join public.clients c on c.id = p.client_id
   where p.id = auth.uid()
     and p.leads_status = 'ativo'
     and p.leads_role in ('cliente_admin', 'cliente')
     and c.leads_enabled
     and c.leads_status = 'ativo';
$$;

drop policy "leads: opera vê clientes" on public.clients;
create policy "leads: opera vê clientes" on public.clients for select
  using (private.leads_is_opera() and (leads_enabled or private.leads_is_admin()));
drop policy "leads: admin cria clientes" on public.clients;
create policy "leads: admin cria clientes" on public.clients for insert
  with check (private.leads_is_admin() and leads_enabled);

-- O limite de 8 clientes por gestor conta só clientes ativados e ativos.
create or replace function public.leads_check_manager_capacity() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.manager_id is not null and new.leads_enabled and new.leads_status = 'ativo'
     and (tg_op = 'INSERT' or new.manager_id is distinct from old.manager_id
          or new.leads_status is distinct from old.leads_status or new.leads_enabled is distinct from old.leads_enabled)
     and (select count(*) from public.clients
           where manager_id = new.manager_id and leads_enabled and leads_status = 'ativo' and id <> new.id) >= 8 then
    raise exception 'Este gestor já tem 8 clientes, que é o máximo.';
  end if;
  return new;
end;
$$;

-- A coluna nova também só muda pelas funções do Leads ou por um admin.
create or replace function public.leads_protect_columns() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or coalesce(current_setting('opera.leads_rpc', true), '') = 'on'
     or private.leads_is_admin() then
    return new;
  end if;
  if tg_table_name = 'profiles' and (
       new.leads_role is distinct from old.leads_role or new.leads_status is distinct from old.leads_status) then
    raise exception 'Só um admin do OPERA Leads pode mudar papéis e estados de utilizadores.';
  end if;
  if tg_table_name = 'clients' and (
       new.manager_id is distinct from old.manager_id or new.leads_status is distinct from old.leads_status
       or new.leads_purge_at is distinct from old.leads_purge_at or new.leads_enabled is distinct from old.leads_enabled) then
    raise exception 'Só um admin do OPERA Leads pode mudar o gestor ou o estado de um cliente.';
  end if;
  return new;
end;
$$;

-- ============================================================ CONTAS
-- Chamada pela app quando um utilizador convidado entra pela primeira vez (depois de definir a palavra passe).
create function public.leads_accept_invite() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('opera.leads_rpc', 'on', true);
  update public.profiles set leads_status = 'ativo'
   where id = auth.uid() and leads_status = 'convidado' and leads_role is not null;
  if found then
    perform public.leads_audit('convite_aceite', jsonb_build_object('user_id', auth.uid()));
  end if;
end;
$$;

-- Chamada pela app depois de um início de sessão completo (com dois passos, para a equipa OPERA).
create function public.leads_log_login() returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.leads_role() is null then return; end if;
  perform public.leads_audit('inicio_sessao', jsonb_build_object('aal', auth.jwt() ->> 'aal'));
end;
$$;

-- Resumo para o ecrã Clientes e acessos. Corre com as permissões de quem chama (RLS).
create function public.leads_clients_overview()
returns table (id uuid, name text, color text, inbox_alias text, manager_id uuid, manager_name text,
               leads_status text, leads_deactivated_at timestamptz, leads_purge_at timestamptz,
               users_active bigint, users_invited bigint, leads_count bigint)
language sql stable security invoker set search_path = public as $$
  select c.id, c.name, c.color, c.inbox_alias, c.manager_id, m.full_name,
         c.leads_status, c.leads_deactivated_at, c.leads_purge_at,
         (select count(*) from public.profiles p where p.client_id = c.id and p.leads_role is not null and p.leads_status = 'ativo'),
         (select count(*) from public.profiles p where p.client_id = c.id and p.leads_role is not null and p.leads_status = 'convidado'),
         (select count(*) from public.leads l where l.client_id = c.id)
    from public.clients c
    left join public.profiles m on m.id = c.manager_id
   where c.leads_enabled
   order by c.leads_status, c.name;
$$;

-- Clientes do CRM que ainda não foram ativados no OPERA Leads (só o admin os vê, para os poder ativar).
create function public.leads_enable_client(p_client_id uuid, p_color text, p_inbox_alias text, p_manager_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_admin() then raise exception 'Só o admin ativa clientes no OPERA Leads.'; end if;
  perform set_config('opera.leads_rpc', 'on', true);
  update public.clients set color = coalesce(p_color, color), inbox_alias = p_inbox_alias, manager_id = p_manager_id,
                            leads_enabled = true, leads_status = 'ativo'
   where id = p_client_id and not leads_enabled;
  if not found then raise exception 'Cliente não encontrado ou já ativado.'; end if;
  perform public.leads_audit('ativar_cliente_leads', jsonb_build_object('client_id', p_client_id));
end;
$$;

-- ============================================================ DEFINIÇÕES (só o admin)
create table public.leads_settings (
  id boolean primary key default true check (id),
  anonymize_after_months integer not null default 0 check (anonymize_after_months in (0, 12, 24)),
  ttl_target_minutes integer not null default 15 check (ttl_target_minutes between 1 and 240),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);
insert into public.leads_settings default values;
alter table public.leads_settings enable row level security;
create policy "opera lê definições" on public.leads_settings for select using (private.leads_is_opera());
create policy "admin muda definições" on public.leads_settings for update
  using (private.leads_is_admin()) with check (private.leads_is_admin());

create function public.leads_settings_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.anonymize_after_months is distinct from old.anonymize_after_months then
    perform public.leads_audit('regra_anonimizacao', jsonb_build_object('meses', new.anonymize_after_months));
  end if;
  return new;
end;
$$;
create trigger leads_settings_audit before update on public.leads_settings
  for each row execute function public.leads_settings_audit();

-- ============================================================ ANONIMIZAÇÃO
-- Apaga os dados pessoais e mantém só chamadas e mudanças de etapa, sem texto, para as estatísticas.
create function private.leads_anonymize(p_lead_id uuid, p_reason text) returns void
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
         meta = meta - 'recording_url' - 'notes'
   where lead_id = p_lead_id;
  delete from public.lead_tasks where lead_id = p_lead_id and done_at is null;
  update public.lead_tasks set note = null where lead_id = p_lead_id;
  insert into public.lead_events (lead_id, type, title, body, author_id)
  values (p_lead_id, 'auto', 'Dados pessoais apagados', 'Motivo: ' || p_reason, auth.uid());
end;
$$;
revoke execute on function private.leads_anonymize(uuid, text) from public, anon, authenticated;

-- Pedido do titular: só a equipa OPERA, com confirmação escrita ("APAGAR").
create function public.leads_erase_subject(p_lead_id uuid, p_confirm text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_opera() or not private.leads_can_write(p_lead_id) then
    raise exception 'Sem permissão para apagar esta lead.';
  end if;
  if p_confirm is distinct from 'APAGAR' then raise exception 'Escreve APAGAR para confirmar.'; end if;
  perform private.leads_anonymize(p_lead_id, 'pedido do titular');
  perform public.leads_audit('pedido_titular_apagar', jsonb_build_object('lead_id', p_lead_id));
end;
$$;
revoke execute on function public.leads_erase_subject(uuid, text) from public, anon;

-- A manutenção diária passa a aplicar também a regra opcional de anonimização.
create or replace function public.leads_daily_maintenance() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_client record; v_lead record; v_count integer; v_months integer;
begin
  for v_client in select id from public.clients where leads_status = 'inativo' and leads_purge_at <= now() loop
    delete from public.leads where client_id = v_client.id;
    get diagnostics v_count = row_count;
    delete from public.lead_stages where client_id = v_client.id;
    insert into public.audit_log (action, detail)
    values ('apagamento_automatico', jsonb_build_object('client_id', v_client.id, 'leads', v_count));
  end loop;

  select anonymize_after_months into v_months from public.leads_settings;
  if coalesce(v_months, 0) > 0 then
    v_count := 0;
    for v_lead in
      select l.id from public.leads l
        join public.lead_stages s on s.id = l.stage_id and s.key = 'desq'
       where not l.anonymized
         and greatest(l.updated_at, coalesce((select max(e.created_at) from public.lead_events e where e.lead_id = l.id), l.created_at))
             < now() - make_interval(months => v_months)
    loop
      perform private.leads_anonymize(v_lead.id, 'regra automática de ' || v_months || ' meses');
      v_count := v_count + 1;
    end loop;
    if v_count > 0 then
      insert into public.audit_log (action, detail) values ('anonimizacao_automatica', jsonb_build_object('leads', v_count));
    end if;
  end if;

  update public.inbound_log set raw = null where raw is not null and received_at < now() - interval '30 days';
  delete from public.audit_log where created_at < now() - interval '12 months';
end;
$$;
revoke execute on function public.leads_daily_maintenance() from public, anon, authenticated;

revoke execute on function public.leads_accept_invite() from public, anon;
revoke execute on function public.leads_log_login() from public, anon;
revoke execute on function public.leads_clients_overview() from public, anon;
revoke execute on function public.leads_enable_client(uuid, text, text, uuid) from public, anon;
revoke execute on function public.leads_settings_audit() from public, anon, authenticated;
