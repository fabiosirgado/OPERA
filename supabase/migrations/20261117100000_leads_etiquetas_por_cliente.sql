-- OPERA Leads: cada etiqueta pertence a um cliente (pedido do Fábio, 2026-11-17).
-- Antes as etiquetas eram globais e todos os clientes viam as de todos.
-- * lead_labels ganha client_id. Cada cliente só vê as suas; a equipa OPERA vê todas e gere-as.
-- * As etiquetas já usadas por vários clientes são divididas: o cliente que mais a usa fica com a original,
--   os outros recebem uma cópia com o mesmo nome e cor (as leads passam para a cópia do seu cliente).
-- * Uma lead só pode ter etiquetas do seu cliente. Se a lead mudar de cliente, as etiquetas passam para as
--   do novo cliente com o mesmo nome (criadas se faltarem).
-- * A importação de Excel cria/procura as etiquetas no cliente de cada linha.

alter table public.lead_labels add column if not exists client_id uuid references public.clients (id) on delete cascade;

-- Dono de cada etiqueta: o cliente com mais leads com ela (as nunca usadas ficam na OPERA).
update public.lead_labels g set client_id = coalesce(
  (select l.client_id from public.lead_label_links k join public.leads l on l.id = k.lead_id
    where k.label_id = g.id group by l.client_id order by count(*) desc, l.client_id limit 1),
  (select id from public.clients where leads_internal order by created_at limit 1))
where g.client_id is null;

alter table public.lead_labels drop constraint if exists lead_labels_name_key;

-- Cópias para os outros clientes que já usavam a etiqueta, e as leads passam para a cópia.
do $$
declare r record; v_new uuid;
begin
  for r in
    select distinct g.id, g.name, g.color, l.client_id
      from public.lead_labels g join public.lead_label_links k on k.label_id = g.id join public.leads l on l.id = k.lead_id
     where l.client_id <> g.client_id
  loop
    insert into public.lead_labels (name, color, client_id) values (r.name, r.color, r.client_id) returning id into v_new;
    update public.lead_label_links k set label_id = v_new
      from public.leads l where l.id = k.lead_id and k.label_id = r.id and l.client_id = r.client_id;
  end loop;
end $$;

alter table public.lead_labels alter column client_id set not null;
create unique index if not exists lead_labels_client_name_key on public.lead_labels (client_id, lower(name));

-- Quem vê: a equipa OPERA vê todas; cada cliente só as suas.
drop policy if exists "ver etiquetas" on public.lead_labels;
create policy "ver etiquetas" on public.lead_labels for select
  using (private.leads_is_opera() or client_id = private.leads_my_client_id());

-- Uma lead só leva etiquetas do seu cliente.
create or replace function private.lead_label_link_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.lead_labels g join public.leads l on l.client_id = g.client_id
                  where g.id = new.label_id and l.id = new.lead_id) then
    raise exception 'Essa etiqueta é de outro cliente.';
  end if;
  return new;
end $$;
drop trigger if exists lead_label_links_same_client on public.lead_label_links;
create trigger lead_label_links_same_client before insert or update on public.lead_label_links
  for each row execute function private.lead_label_link_check();

-- Lead muda de cliente: as etiquetas passam para as do novo cliente com o mesmo nome.
create or replace function private.lead_labels_follow_client() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; v_new uuid;
begin
  for r in select k.label_id, g.name, g.color from public.lead_label_links k join public.lead_labels g on g.id = k.label_id
            where k.lead_id = new.id and g.client_id <> new.client_id loop
    select id into v_new from public.lead_labels where client_id = new.client_id and lower(name) = lower(r.name);
    if v_new is null then
      insert into public.lead_labels (name, color, client_id) values (r.name, r.color, new.client_id) returning id into v_new;
    end if;
    delete from public.lead_label_links where lead_id = new.id and label_id = r.label_id;
    insert into public.lead_label_links (lead_id, label_id) values (new.id, v_new) on conflict do nothing;
  end loop;
  return null;
end $$;
drop trigger if exists leads_labels_follow_client on public.leads;
create trigger leads_labels_follow_client after update of client_id on public.leads
  for each row when (old.client_id is distinct from new.client_id)
  execute function private.lead_labels_follow_client();

-- Importação de Excel: as etiquetas são procuradas e criadas no cliente da linha.
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_import_batch'::regproc::regprocedure;
  old1 constant text := $a$select id into v_label from public.lead_labels where lower(name) = lower(v_name);$a$;
  new1 constant text := $a$select id into v_label from public.lead_labels where client_id = r.client_id and lower(name) = lower(v_name);$a$;
  old2 constant text := $a$insert into public.lead_labels (name, color) values (left(v_name, 40), 'cinzento') returning id into v_label;$a$;
  new2 constant text := $a$insert into public.lead_labels (name, color, client_id) values (left(v_name, 40), 'cinzento', r.client_id) returning id into v_label;$a$;
begin
  d := pg_get_functiondef(sig);
  if (length(d) - length(replace(d, old1, ''))) / length(old1) <> 1 or (length(d) - length(replace(d, old2, ''))) / length(old2) <> 1 then
    raise exception 'leads_import_batch: pontos de alteração não encontrados (ou repetidos)';
  end if;
  n := length(d);
  d := replace(replace(d, old1, new1), old2, new2);
  if length(d) - n <> length(new1) - length(old1) + length(new2) - length(old2) then
    raise exception 'leads_import_batch: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
