-- Dashboard Admin: o comercial (vendedor) de um contrato da OPERA (pedido do Fábio, 2026-11-11).
-- Quem agenda a R1 ou passa a lead para Closed não é necessariamente quem fechou o negócio.
--
-- * Por defeito, o vendedor é quem passou a lead para Em Onboarding (ou uma etapa a seguir) pela primeira vez.
--   Até lá fica, provisoriamente, quem criou o contrato (quem passou para Closed).
-- * O vendedor continua a poder ser mudado à mão no Dashboard Admin (Gestão → Contratos → Editar). Depois de
--   mudado à mão, já não é trocado automaticamente.
-- * Na tabela "Por pessoa" do separador Comercial, os fechos contam para o vendedor do contrato (antes contavam
--   para quem passou a lead para Closed). As R1 e R2 continuam a contar para quem as marcou.

alter table public.opera_contratos add column if not exists vendedor_manual boolean not null default false;
comment on column public.opera_contratos.vendedor_manual is
  'O vendedor foi escolhido à mão (no Dashboard Admin ou num contrato manual); deixa de ser trocado automaticamente.';

-- Etapas de Em Onboarding em diante (cliente interno OPERA).
create or replace function private.opera_fase_pos_fecho(p_stage uuid) returns boolean
language sql stable set search_path = public as $$
  select coalesce((select lower(trim(name)) in ('em onboarding', 'entrega de serviço', 'entrega de servico', 'serviço terminado', 'servico terminado')
                     from public.lead_stages where id = p_stage), false);
$$;

-- Contrato novo: vendedor provisório = quem o criou; contrato manual com vendedor = escolha à mão.
create or replace function public.opera_contratos_vendedor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tipo_venda is null then
    new.tipo_venda := case when new.origem = 'renovacao' then 'renovacao' else 'nova' end;
  end if;
  if new.vendedor is not null and coalesce(current_setting('opera.vendedor_auto', true), '') <> 'on' and new.origem = 'manual' then
    new.vendedor_manual := true;
  end if;
  if new.vendedor is null and new.lead_id is not null and auth.uid() is not null then
    select nullif(split_part(trim(full_name), ' ', 1), '') into new.vendedor from profiles where id = auth.uid();
  end if;
  return new;
end $$;

-- Mudança do vendedor fora das regras automáticas = escolha à mão.
create or replace function private.opera_contratos_vendedor_manual()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.vendedor is distinct from old.vendedor and coalesce(current_setting('opera.vendedor_auto', true), '') <> 'on' then
    new.vendedor_manual := true;
  end if;
  return new;
end $$;
create trigger trg_opera_contratos_vendedor_manual before update of vendedor on public.opera_contratos
  for each row execute function private.opera_contratos_vendedor_manual();

-- A lead da OPERA entra em Em Onboarding (ou depois): quem a passou fica como vendedor, salvo escolha à mão.
create or replace function private.opera_vendedor_onboarding()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_nome text;
begin
  if new.stage_id is not distinct from old.stage_id or auth.uid() is null then return null; end if;
  if not coalesce((select leads_internal from public.clients where id = new.client_id), false) then return null; end if;
  if not private.opera_fase_pos_fecho(new.stage_id) or private.opera_fase_pos_fecho(old.stage_id) then return null; end if;
  -- Só a primeira vez que chega a Em Onboarding ou depois.
  if exists (select 1 from public.lead_events e where e.lead_id = new.id and e.type = 'stage'
               and private.opera_fase_pos_fecho(e.to_stage_id) and e.created_at < now()) then return null; end if;
  select nullif(split_part(trim(full_name), ' ', 1), '') into v_nome from public.profiles where id = auth.uid();
  if v_nome is null then return null; end if;
  perform set_config('opera.vendedor_auto', 'on', true);
  update public.opera_contratos set vendedor = v_nome, updated_at = now()
   where lead_id = new.id and estado <> 'cancelado' and not vendedor_manual and vendedor is distinct from v_nome;
  perform set_config('opera.vendedor_auto', '', true);
  return null;
end $$;
-- Corre depois de leads_opera_financeiro (que cria o contrato), pela ordem alfabética dos nomes.
create trigger leads_opera_vendedor_onboarding after update of stage_id on public.leads
  for each row execute function private.opera_vendedor_onboarding();

-- Contratos que já existem: vendedor = quem passou a lead para Em Onboarding (ou depois) pela primeira vez.
do $$
begin
  perform set_config('opera.vendedor_auto', 'on', true);
  update public.opera_contratos c set vendedor = x.nome, updated_at = now()
    from (select distinct on (e.lead_id) e.lead_id, nullif(split_part(trim(p.full_name), ' ', 1), '') nome
            from public.lead_events e join public.profiles p on p.id = e.author_id
           where e.type = 'stage' and private.opera_fase_pos_fecho(e.to_stage_id)
           order by e.lead_id, e.created_at) x
   where c.lead_id = x.lead_id and c.estado <> 'cancelado' and not c.vendedor_manual and x.nome is not null
     and c.vendedor is distinct from x.nome;
  perform set_config('opera.vendedor_auto', '', true);
end $$;

-- Tabela "Por pessoa": os fechos contam para o vendedor do contrato.
do $do$
declare d text; n int;
  sig regprocedure := 'public.opera_admin_dados(date,date)'::regprocedure;
  old1 constant text := $a$fecho as ( select distinct on (lead_id) lead_id, author_id from ev where fase in ('Closed','Em Onboarding','Entrega de serviço') order by lead_id, created_at )$a$;
  new1 constant text := $a$fecho as ( select distinct on (ev.lead_id) ev.lead_id, coalesce((select p.id from opera_contratos oc join profiles p on p.leads_role in ('admin','gestor') and split_part(trim(p.full_name), ' ', 1) = oc.vendedor where oc.lead_id = ev.lead_id and oc.estado <> 'cancelado' order by oc.created_at desc, p.created_at limit 1), ev.author_id) author_id from ev where fase in ('Closed','Em Onboarding','Entrega de serviço') order by ev.lead_id, ev.created_at )$a$;
  old2 constant text := $a$from (select distinct author_id from ev where fase in ('R1','R2','Em decisão','Closed','Em Onboarding','Entrega de serviço')) a$a$;
  new2 constant text := $a$from (select author_id from ev where fase in ('R1','R2','Em decisão') union select author_id from fecho) a$a$;
begin
  d := pg_get_functiondef(sig);
  n := length(d);
  d := replace(replace(d, old1, new1), old2, new2);
  if length(d) - n <> length(new1) - length(old1) + length(new2) - length(old2) then
    raise exception 'opera_admin_dados: substituição falhou (%)', length(d) - n;
  end if;
  execute d;
end;
$do$;
