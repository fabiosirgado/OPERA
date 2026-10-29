-- OPERA Leads: o Objetivo da qualificação passa a ter também Arrendamento (quem procura casa para arrendar) e
-- Senhorio (quem tem casa para pôr a arrendar). Decisão do Fábio, 2026-10-29.
-- Contam para a regra de qualificação e têm o seu número no dashboard, como os outros tipos.

create or replace function private.leads_objetivo_tipos(p text) returns text[]
language sql immutable set search_path to '' as $$
  select array_remove(array[
    case when coalesce(p, '') ~* 'compr' then 'Comprador' end,
    case when coalesce(p, '') ~* 'propriet|vend' then 'Proprietário' end,
    case when coalesce(p, '') ~* 'cr[eé]dito|financ' then 'Crédito' end,
    case when coalesce(p, '') ~* 'arrend|inquilin' then 'Arrendamento' end,
    case when coalesce(p, '') ~* 'senhori' then 'Senhorio' end], null);
$$;

create or replace function public.leads_require_objetivo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage_id is distinct from old.stage_id and not new.anonymized
     and (select key from public.lead_stages where id = new.stage_id) = 'qualificada'
     and coalesce((select position from public.lead_stages where id = old.stage_id), 0) < 50
     and not coalesce((select leads_internal from public.clients where id = new.client_id), false)
     and cardinality(private.leads_objetivo_tipos(new.qualification ->> 'Objetivo')) = 0 then
    raise exception 'Indica o Objetivo da lead (Comprador, Proprietário, Crédito, Arrendamento ou Senhorio) antes de a qualificar.';
  end if;
  return new;
end;
$$;
revoke execute on function public.leads_require_objetivo() from public, anon, authenticated;

-- Dashboard: qualificadas de arrendamento e de senhorios.
do $do$
declare d text; n int;
  sig regprocedure := 'public.leads_dashboard(uuid,text,date,date)'::regprocedure;
  add constant text := $a$
        'arrendamento', count(*) filter (where 'Arrendamento' = any (t.tipos)),
        'senhorio', count(*) filter (where 'Senhorio' = any (t.tipos)),$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(d, $a$'credito', count(*) filter (where 'Crédito' = any (t.tipos)),$a$,
                  $a$'credito', count(*) filter (where 'Crédito' = any (t.tipos)),$a$ || add);
  if length(d) - n <> length(add) then raise exception 'leads_dashboard: substituição falhou (%)', length(d) - n; end if;
  execute d;
end;
$do$;
