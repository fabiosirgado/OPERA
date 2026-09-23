-- OPERA · Tabela de respostas do inquérito mensal de feedback
-- Correr no SQL Editor do Supabase (projeto OPERA OS).

create table if not exists public.feedback_respostas (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  ciclo            text not null check (ciclo ~ '^\d{4}-\d{2}$'),   -- mês do inquérito, ex: 2026-10
  cliente          text,                                            -- vem do link (?c=...), opcional
  satisfacao_geral smallint not null check (satisfacao_geral between 1 and 10),
  legal            smallint check (legal between 1 and 10),          -- null = não se aplica
  financeiro       smallint check (financeiro between 1 and 10),
  processual       smallint check (processual between 1 and 10),
  usa_sa           boolean not null,
  sa               smallint check (sa between 1 and 10),
  opera_os         smallint check (opera_os between 1 and 10),
  eficiencia       smallint not null check (eficiencia between 1 and 10),
  nps              smallint not null check (nps between 0 and 10),
  sugestoes        text check (char_length(sugestoes) <= 3000),
  melhoria         text check (char_length(melhoria) <= 3000),
  constraint sa_coerente check (usa_sa or sa is null)
);

create index if not exists feedback_respostas_ciclo_idx on public.feedback_respostas (ciclo);

alter table public.feedback_respostas enable row level security;

-- Qualquer pessoa com o link pode ENVIAR uma resposta (não pode ler nada).
drop policy if exists "feedback: inserir publico" on public.feedback_respostas;
create policy "feedback: inserir publico"
  on public.feedback_respostas for insert
  to anon, authenticated
  with check (true);

-- Só a equipa OPERA pode LER: qualquer sessão autenticada com email @opera-os.com.
-- O login é por link mágico enviado para o email, por isso o email está sempre verificado.
-- IMPORTANTE: em Authentication > Providers > Email, manter "Confirm email" ativo.
drop policy if exists "feedback: leitura equipa" on public.feedback_respostas;
create policy "feedback: leitura equipa"
  on public.feedback_respostas for select
  to authenticated
  using ( lower(auth.jwt() ->> 'email') like '%@opera-os.com' );
