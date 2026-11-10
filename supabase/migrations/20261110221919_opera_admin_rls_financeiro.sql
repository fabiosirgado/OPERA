-- Financeiro: só quem tem nível 'total' no Dashboard Admin lê e escreve.
drop policy if exists opera_contratos_admin on public.opera_contratos;
drop policy if exists opera_pagamentos_admin on public.opera_pagamentos;
drop policy if exists opera_custos_admin on public.opera_custos;
drop policy if exists opera_saldo_admin on public.opera_saldo;

create policy opera_contratos_total on public.opera_contratos for all to authenticated
  using (private.opera_nivel() = 'total') with check (private.opera_nivel() = 'total');
create policy opera_pagamentos_total on public.opera_pagamentos for all to authenticated
  using (private.opera_nivel() = 'total') with check (private.opera_nivel() = 'total');
create policy opera_custos_total on public.opera_custos for all to authenticated
  using (private.opera_nivel() = 'total') with check (private.opera_nivel() = 'total');
create policy opera_saldo_total on public.opera_saldo for all to authenticated
  using (private.opera_nivel() = 'total') with check (private.opera_nivel() = 'total');

grant select, insert, update, delete on public.opera_contratos, public.opera_pagamentos, public.opera_custos, public.opera_saldo to authenticated;

-- Funções que mexem em prestações: versões para o ecrã, que confirmam o nível antes de chamar as internas.
create or replace function public.opera_admin_definir_plano(p_contrato uuid, p_plano jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  perform public.opera_definir_plano(p_contrato, p_plano);
end $$;
create or replace function public.opera_admin_gerar_prestacoes(p_contrato uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  perform public.opera_gerar_prestacoes(p_contrato);
end $$;
create or replace function public.opera_admin_recalcular_prestacoes(p_contrato uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  perform public.opera_recalcular_prestacoes(p_contrato);
end $$;
create or replace function public.opera_admin_renovar(p_contrato uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso ao financeiro.'; end if;
  perform public.opera_renovar(p_contrato);
end $$;
revoke all on function public.opera_admin_definir_plano(uuid, jsonb), public.opera_admin_gerar_prestacoes(uuid), public.opera_admin_recalcular_prestacoes(uuid), public.opera_admin_renovar(uuid) from public, anon;
grant execute on function public.opera_admin_definir_plano(uuid, jsonb), public.opera_admin_gerar_prestacoes(uuid), public.opera_admin_recalcular_prestacoes(uuid), public.opera_admin_renovar(uuid) to authenticated;

-- O meu nível (para o menu mostrar ou não o Dashboard Admin)
create or replace function public.opera_admin_meu_nivel() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('nivel', a.nivel, 'vendedor', a.vendedor)
  from public.opera_admin_acessos a where a.user_id = auth.uid() and private.opera_nivel() is not null
$$;
revoke all on function public.opera_admin_meu_nivel() from public, anon;
grant execute on function public.opera_admin_meu_nivel() to authenticated;

-- Gestão de acessos (só nível total): lista e define o acesso de alguém da equipa OPERA.
create or replace function public.opera_admin_acessos_lista() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', p.id, 'nome', p.full_name, 'email', p.email, 'papel', p.leads_role, 'nivel', a.nivel, 'vendedor', a.vendedor) order by p.full_name), '[]'::jsonb)
          from public.profiles p left join public.opera_admin_acessos a on a.user_id = p.id
          where p.leads_role in ('admin','gestor'));
end $$;
create or replace function public.opera_admin_definir_acesso(p_user uuid, p_nivel text, p_vendedor text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if private.opera_nivel() is distinct from 'total' then raise exception 'Sem acesso.'; end if;
  if p_user = auth.uid() then raise exception 'Não podes mudar o teu próprio acesso.'; end if;
  if p_nivel is null then delete from public.opera_admin_acessos where user_id = p_user; return; end if;
  if p_nivel not in ('total','comercial') then raise exception 'Nível inválido.'; end if;
  if not exists (select 1 from public.profiles where id = p_user and leads_role in ('admin','gestor')) then raise exception 'Só pessoas da equipa OPERA.'; end if;
  insert into public.opera_admin_acessos (user_id, nivel, vendedor) values (p_user, p_nivel, nullif(trim(p_vendedor), ''))
  on conflict (user_id) do update set nivel = excluded.nivel, vendedor = excluded.vendedor;
end $$;
revoke all on function public.opera_admin_acessos_lista(), public.opera_admin_definir_acesso(uuid, text, text) from public, anon;
grant execute on function public.opera_admin_acessos_lista(), public.opera_admin_definir_acesso(uuid, text, text) to authenticated;
