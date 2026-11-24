-- OPERA Leads, Setting B2B (docs/setting/especificacao_setting.md, prioridade 1: pipeline do setting).
-- Cada cliente passa a ter um tipo de serviço: imobiliário (todos os atuais, sem mudança nenhuma) ou setting.
-- Num cliente de setting:
--   * as etapas base mantêm as chaves e mostram outro nome (name_setting): Nova Lead, Reunião Agendada, Desqualificada;
--     a etapa imoveis fica escondida (no ecrã);
--   * as quatro etapas do cliente (Compareceu, Não compareceu, Fechado, Perdido) são criadas sozinhas (outcome);
--   * os campos de qualificação são os do cliente (qual_fields) e o Objetivo deixa de ser obrigatório;
--   * passar a Reunião Agendada pede data e hora, quem faz a reunião e a ligação;
--   * desqualificar pede o motivo (desq_reason, de uma lista do cliente);
--   * Não compareceu devolve a lead à OPERA (Follow Up OPERA) com uma tarefa para remarcar e conta a remarcação.
-- Só acrescenta: colunas novas, valores por omissão que mantêm tudo igual e regras que só atuam em clientes de setting.

-- ---------- Cliente
alter table public.clients add column if not exists service_type text not null default 'imobiliario';
do $$ begin
  alter table public.clients add constraint clients_service_type_check check (service_type in ('imobiliario', 'setting'));
exception when duplicate_object then null; end $$;
-- Campos de qualificação do cliente: [{ "key": "Empresa", "type": "texto" | "sim_nao" | "escolha", "options": [...] }].
-- Vazio (null) = os seis campos de imobiliário de sempre.
alter table public.clients add column if not exists qual_fields jsonb;
-- Motivos de desqualificação do cliente (setting). O último pode ser "Outro" (pede texto).
alter table public.clients add column if not exists desq_reasons text[];

-- ---------- Etapas
alter table public.lead_stages add column if not exists name_setting text;
do $$ begin
  alter table public.lead_stages add constraint lead_stages_name_setting_check check (name_setting is null or char_length(name_setting) between 1 and 60);
exception when duplicate_object then null; end $$;
-- Resultado da reunião que a etapa do cliente representa (só nas etapas criadas para clientes de setting).
alter table public.lead_stages add column if not exists outcome text;
do $$ begin
  alter table public.lead_stages add constraint lead_stages_outcome_check check (outcome is null or (outcome in ('compareceu', 'nao_compareceu', 'fechado', 'perdido') and client_id is not null));
exception when duplicate_object then null; end $$;
create unique index if not exists lead_stages_outcome_por_cliente on public.lead_stages (client_id, outcome) where outcome is not null;

update public.lead_stages set name_setting = 'Nova Lead' where key = 'meta' and client_id is null and name_setting is null;
update public.lead_stages set name_setting = 'Reunião Agendada' where key = 'qualificada' and client_id is null and name_setting is null;
update public.lead_stages set name_setting = 'Desqualificada' where key = 'desq' and client_id is null and name_setting is null;

-- ---------- Lead
alter table public.leads add column if not exists meeting_at timestamptz;
alter table public.leads add column if not exists meeting_with text;
alter table public.leads add column if not exists meeting_link text;
alter table public.leads add column if not exists desq_reason text;
alter table public.leads add column if not exists reschedules integer not null default 0;

create or replace function private.leads_is_setting(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select service_type = 'setting' from public.clients where id = p_client), false);
$$;

-- Nome da etapa a mostrar para um cliente (o de setting quando existe e o cliente é de setting).
create or replace function private.leads_stage_label(p_stage uuid, p_client uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when s.name_setting is not null and private.leads_is_setting(p_client) then s.name_setting else s.name end
    from public.lead_stages s where s.id = p_stage;
$$;

-- ---------- Configuração por omissão de um cliente de setting e etapas do cliente
create or replace function private.leads_setting_preparar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_cor text := coalesce(new.color, '#475569');
begin
  if new.service_type <> 'setting' then return null; end if;
  if new.qual_fields is null then
    update public.clients set qual_fields = '[
      {"key": "Empresa", "type": "texto"},
      {"key": "Cargo", "type": "texto"},
      {"key": "É decisor", "type": "sim_nao"},
      {"key": "Necessidade", "type": "texto"},
      {"key": "Orçamento", "type": "texto"},
      {"key": "Prazo", "type": "texto"}
    ]'::jsonb where id = new.id;
  end if;
  if new.desq_reasons is null then
    update public.clients set desq_reasons = array['Sem orçamento', 'Não é decisor', 'Sem interesse', 'Já tem fornecedor', 'Contacto errado', 'Outro']
     where id = new.id;
  end if;
  insert into public.lead_stages (name, color, position, client_id, owner, is_base, outcome)
  select x.name, v_cor, x.pos, new.id, 'cliente', false, x.outcome
    from (values ('Compareceu', 60, 'compareceu'), ('Não compareceu', 70, 'nao_compareceu'),
                 ('Fechado', 80, 'fechado'), ('Perdido', 90, 'perdido')) as x(name, pos, outcome)
   where not exists (select 1 from public.lead_stages s where s.client_id = new.id and s.outcome = x.outcome);
  return null;
end $$;

drop trigger if exists clients_setting_preparar on public.clients;
create trigger clients_setting_preparar after insert or update of service_type on public.clients
  for each row when (new.service_type = 'setting') execute function private.leads_setting_preparar();

-- ---------- Regras ao mudar de etapa
-- Imobiliário: igual a antes (Objetivo obrigatório para qualificar). Setting: reunião completa para Reunião Agendada
-- e motivo para Desqualificada.
create or replace function public.leads_require_objetivo() returns trigger
language plpgsql security definer set search_path = 'public' as $function$
declare v_key text := (select key from public.lead_stages where id = new.stage_id);
begin
  if new.stage_id is not distinct from old.stage_id or new.anonymized then return new; end if;
  if private.leads_is_setting(new.client_id) then
    if v_key = 'qualificada' and (new.meeting_at is null or coalesce(btrim(new.meeting_with), '') = ''
                                  or coalesce(btrim(new.meeting_link), '') = '') then
      raise exception 'Para agendar a reunião indica a data e a hora, quem faz a reunião e a ligação.';
    end if;
    if v_key = 'desq' and coalesce(btrim(new.desq_reason), '') = '' then
      raise exception 'Indica o motivo da desqualificação.';
    end if;
    return new;
  end if;
  if v_key = 'qualificada'
     and coalesce((select position from public.lead_stages where id = old.stage_id), 0) < 50
     and not coalesce((select leads_internal from public.clients where id = new.client_id), false)
     and cardinality(private.leads_objetivo_tipos(new.qualification ->> 'Objetivo')) = 0 then
    raise exception 'Indica o Objetivo da lead (Comprador, Proprietário, Crédito, Arrendamento ou Senhorio) antes de a qualificar.';
  end if;
  return new;
end;
$function$;

-- Não compareceu: a lead volta à OPERA (Follow Up OPERA), conta a remarcação e fica com uma chamada para remarcar.
create or replace function private.leads_setting_nao_compareceu() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_fu uuid;
begin
  if new.stage_id is not distinct from old.stage_id then return null; end if;
  if (select outcome from public.lead_stages where id = new.stage_id) is distinct from 'nao_compareceu' then return null; end if;
  select id into v_fu from public.lead_stages where key = 'followup' and client_id is null;
  update public.leads set stage_id = v_fu, reschedules = reschedules + 1 where id = new.id;
  insert into public.lead_tasks (lead_id, type, due_at, note, created_by)
  values (new.id, 'call', now(), 'Remarcar a reunião (não compareceu)', auth.uid());
  insert into public.lead_events (lead_id, type, title, body, author_id)
  values (new.id, 'auto', 'Não compareceu à reunião',
          format('A lead volta à OPERA para remarcar.%s',
                 case when new.meeting_at is not null
                      then ' Reunião de ' || to_char(new.meeting_at at time zone 'Europe/Lisbon', 'DD/MM/YYYY "às" HH24:MI') || '.' else '' end),
          auth.uid());
  return null;
end $$;

drop trigger if exists leads_setting_nao_compareceu on public.leads;
create trigger leads_setting_nao_compareceu after update of stage_id on public.leads
  for each row execute function private.leads_setting_nao_compareceu();
