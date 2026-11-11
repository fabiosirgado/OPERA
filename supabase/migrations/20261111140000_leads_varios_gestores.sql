-- OPERA Leads: um cliente pode ter mais do que um gestor (pedido do Fábio, 2026-11-11, para a OPERA).
--
-- * Nova tabela client_managers: os gestores de cada cliente.
-- * clients.manager_id continua a ser o gestor principal (o primeiro da lista). É a ele que chegam as respostas
--   aos emails de leads qualificadas e é o nome que aparece nas notas das chamadas.
-- * Contam todos os gestores: avisos das conversas do cliente, carga de cada gestor (máximo de 8 clientes) e o
--   nome do gestor no dashboard e na lista de clientes.
-- * Atribuir gestores: leads_set_managers(cliente, lista). leads_assign_manager (um só gestor) continua a funcionar.

-- ============================================================ TABELA
create table public.client_managers (
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  primary key (client_id, user_id)
);
create index client_managers_user_idx on public.client_managers (user_id);
alter table public.client_managers enable row level security;
create policy "opera vê gestores dos clientes" on public.client_managers for select using ((select private.leads_is_opera()));
grant select on public.client_managers to authenticated;

insert into public.client_managers (client_id, user_id) select id, manager_id from public.clients where manager_id is not null;

-- Máximo de 8 clientes ativos por gestor.
create or replace function public.leads_check_manager_capacity()
returns trigger language plpgsql set search_path = public as $$
declare v_user uuid;
begin
  if tg_table_name = 'client_managers' then
    if exists (select 1 from public.clients c where c.id = new.client_id and c.leads_enabled and c.leads_status = 'ativo')
       and (select count(*) from public.client_managers m join public.clients c on c.id = m.client_id
             where m.user_id = new.user_id and c.leads_enabled and c.leads_status = 'ativo' and c.id <> new.client_id) >= 8 then
      raise exception 'Este gestor já tem 8 clientes, que é o máximo.';
    end if;
    return new;
  end if;
  -- clients: ao reativar um cliente, cada gestor dele não pode passar dos 8.
  if new.leads_enabled and new.leads_status = 'ativo'
     and (tg_op = 'INSERT' or new.leads_status is distinct from old.leads_status or new.leads_enabled is distinct from old.leads_enabled) then
    for v_user in select user_id from public.client_managers where client_id = new.id loop
      if (select count(*) from public.client_managers m join public.clients c on c.id = m.client_id
           where m.user_id = v_user and c.leads_enabled and c.leads_status = 'ativo' and c.id <> new.id) >= 8 then
        raise exception 'Este gestor já tem 8 clientes, que é o máximo.';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
create trigger client_managers_capacity before insert on public.client_managers
  for each row execute function public.leads_check_manager_capacity();

-- ============================================================ ATRIBUIR
create function public.leads_set_managers(p_client_id uuid, p_manager_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v_ids uuid[] := coalesce((select array_agg(x order by o) from (select distinct on (x) x, o
                                    from unnest(coalesce(p_manager_ids, '{}')) with ordinality u(x, o) where x is not null order by x, o) d), '{}');
begin
  if not private.leads_is_admin() then raise exception 'Só o admin atribui gestores.'; end if;
  if exists (select 1 from unnest(v_ids) x where not exists (
       select 1 from public.profiles p where p.id = x and p.leads_role in ('admin', 'gestor') and p.leads_status in ('ativo', 'convidado'))) then
    raise exception 'Um dos utilizadores escolhidos não é gestor.';
  end if;
  delete from public.client_managers where client_id = p_client_id and not (user_id = any (v_ids));
  insert into public.client_managers (client_id, user_id, position)
  select p_client_id, x, o - 1 from unnest(v_ids) with ordinality u(x, o)
  on conflict (client_id, user_id) do update set position = excluded.position;
  perform set_config('opera.leads_rpc', 'on', true);
  update public.clients set manager_id = v_ids[1] where id = p_client_id;
  perform public.leads_audit('atribuir_gestor', jsonb_build_object('client_id', p_client_id, 'manager_ids', to_jsonb(v_ids)));
end;
$$;
revoke execute on function public.leads_set_managers(uuid, uuid[]) from public, anon;
grant execute on function public.leads_set_managers(uuid, uuid[]) to authenticated;

create or replace function public.leads_assign_manager(p_client_id uuid, p_manager_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.leads_set_managers(p_client_id, case when p_manager_id is null then '{}'::uuid[] else array[p_manager_id] end);
end;
$$;

create or replace function public.leads_enable_client(p_client_id uuid, p_color text, p_inbox_alias text, p_manager_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not private.leads_is_admin() then raise exception 'Só o admin ativa clientes no OPERA Leads.'; end if;
  perform set_config('opera.leads_rpc', 'on', true);
  update public.clients set color = coalesce(p_color, color), inbox_alias = p_inbox_alias,
                            leads_enabled = true, leads_status = 'ativo'
   where id = p_client_id and not leads_enabled;
  if not found then raise exception 'Cliente não encontrado ou já ativado.'; end if;
  if p_manager_id is not null then perform public.leads_set_managers(p_client_id, array[p_manager_id]); end if;
  perform public.leads_audit('ativar_cliente_leads', jsonb_build_object('client_id', p_client_id));
end;
$$;

-- ============================================================ LEITURAS
drop function public.leads_clients_overview();
create function public.leads_clients_overview()
returns table (id uuid, name text, color text, inbox_alias text, manager_id uuid, manager_name text, manager_ids uuid[],
               leads_status text, leads_deactivated_at timestamptz, leads_purge_at timestamptz,
               users_active bigint, users_invited bigint, leads_count bigint)
language sql stable set search_path = public as $$
  select c.id, c.name, c.color, c.inbox_alias, c.manager_id,
         (select string_agg(coalesce(p.full_name, p.email), ', ' order by m.position, p.full_name)
            from public.client_managers m join public.profiles p on p.id = m.user_id where m.client_id = c.id),
         coalesce((select array_agg(m.user_id order by m.position) from public.client_managers m where m.client_id = c.id), '{}'),
         c.leads_status, c.leads_deactivated_at, c.leads_purge_at,
         (select count(*) from public.profiles p where p.client_id = c.id and p.leads_role is not null and p.leads_status = 'ativo'),
         (select count(*) from public.profiles p where p.client_id = c.id and p.leads_role is not null and p.leads_status = 'convidado'),
         (select count(*) from public.leads l where l.client_id = c.id)
    from public.clients c
   where c.leads_enabled
   order by c.leads_status, c.name;
$$;
revoke execute on function public.leads_clients_overview() from public, anon;
grant execute on function public.leads_clients_overview() to authenticated;

create or replace function public.leads_managers_load()
returns table (id uuid, name text, role text, clients jsonb, leads_working bigint, overdue bigint)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(p.full_name, p.email), p.leads_role,
         coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                     from public.clients c join public.client_managers m on m.client_id = c.id
                    where m.user_id = p.id and c.leads_enabled and c.leads_status = 'ativo'), '[]'::jsonb),
         (select count(*) from public.leads l join public.lead_stages s on s.id = l.stage_id
           join public.clients c on c.id = l.client_id join public.client_managers m on m.client_id = c.id
           where m.user_id = p.id and c.leads_enabled and c.leads_status = 'ativo' and s.position < 50),
         (select count(*) from public.lead_tasks t join public.leads l on l.id = t.lead_id
           join public.clients c on c.id = l.client_id join public.client_managers m on m.client_id = c.id
           where m.user_id = p.id and c.leads_enabled and c.leads_status = 'ativo'
             and t.done_at is null and t.canceled_at is null and t.due_at < now())
    from public.profiles p
   where private.leads_is_opera() and p.leads_status = 'ativo'
     and (p.leads_role = 'gestor' or (p.leads_role = 'admin' and exists (select 1 from public.client_managers m where m.user_id = p.id)))
   order by 2;
$$;

-- Quem da OPERA recebe os avisos das conversas de um cliente: todos os gestores dele (ou os admins, se não houver).
create or replace function private.leads_message_readers(p_client_id uuid, p_side text)
returns setof public.profiles
language sql stable security definer set search_path = public as $$
  select p.* from public.profiles p
   where p_side = 'cliente' and p.client_id = p_client_id and p.leads_status = 'ativo'
     and p.leads_role in ('cliente_admin', 'cliente') and p.email is not null
  union all
  select p.* from public.profiles p
   where p_side = 'opera' and p.leads_status = 'ativo' and p.email is not null
     and (p.id in (select m.user_id from public.client_managers m where m.client_id = p_client_id)
          or (p.leads_role = 'admin' and not exists (select 1 from public.client_managers m join public.profiles g on g.id = m.user_id
                                                      where m.client_id = p_client_id and g.leads_status = 'ativo')));
$$;

-- Dashboard: o nome de todos os gestores do cliente.
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_dashboard(uuid,text,date,date)'::regprocedure;
  old constant text := $a$'manager', (select full_name from public.profiles pr where pr.id = p.manager_id),$a$;
  new constant text := $a$'manager', (select string_agg(pr.full_name, ', ' order by m.position, pr.full_name) from public.client_managers m join public.profiles pr on pr.id = m.user_id where m.client_id = p.id),$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, old, new);
  if length(d) - n <> length(new) - length(old) then raise exception 'leads_dashboard: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;
