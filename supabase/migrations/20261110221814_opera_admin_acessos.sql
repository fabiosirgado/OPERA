-- Quem vê o Dashboard Admin: lista explícita. 'total' vê tudo; 'comercial' vê só o seu controlo comercial.
-- Nota: as tabelas opera_contratos, opera_pagamentos, opera_custos e opera_saldo, as funções opera_* e a vista
-- opera_comissoes foram criadas diretamente no Supabase em 10/11/2026 (migrações 20261110160057 a 20261110220918).
create table if not exists public.opera_admin_acessos (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nivel text not null check (nivel in ('total','comercial')),
  vendedor text,
  created_at timestamptz not null default now()
);
alter table public.opera_admin_acessos enable row level security;
revoke all on public.opera_admin_acessos from anon, authenticated;

-- Fábio: acesso total
insert into public.opera_admin_acessos (user_id, nivel, vendedor)
values ('44cb04ce-63c9-40e8-8074-23c0b6eeb6ed', 'total', 'Fábio')
on conflict (user_id) do nothing;

create or replace function private.opera_nivel() returns text
language sql stable security definer set search_path = public as $$
  select a.nivel from public.opera_admin_acessos a
  join public.profiles p on p.id = a.user_id
  where a.user_id = auth.uid() and coalesce(p.leads_status, 'ativo') = 'ativo'
$$;
revoke all on function private.opera_nivel() from public, anon;
grant execute on function private.opera_nivel() to authenticated;

-- Fechar tudo o que é financeiro ao público: só as funções opera_admin_* (com verificação de nível) ficam abertas.
revoke execute on function public.opera_pnl(date, date) from public, anon, authenticated;
revoke execute on function public.opera_definir_plano(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.opera_gerar_prestacoes(uuid) from public, anon, authenticated;
revoke execute on function public.opera_recalcular_prestacoes(uuid) from public, anon, authenticated;
revoke execute on function public.opera_renovar(uuid) from public, anon, authenticated;
revoke execute on function public.opera_lead_para_financeiro() from public, anon, authenticated;
revoke execute on function public.opera_lead_servico_terminado() from public, anon, authenticated;
revoke execute on function public.opera_contratos_vendedor() from public, anon, authenticated;
revoke all on public.opera_comissoes from anon, authenticated;
revoke all on public.opera_contratos_metricas from anon, authenticated;
revoke all on public.opera_contratos, public.opera_pagamentos, public.opera_custos, public.opera_saldo from anon, authenticated;
