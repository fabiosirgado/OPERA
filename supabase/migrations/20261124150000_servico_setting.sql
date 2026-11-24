-- Categoria de serviço SETTING (OPERA Setting, setting B2B).
-- Aplicada em produção a 24 nov 2026. Conta como slot de Gestor de Leads e usa o custo de lugar do SA.
alter table opera_contratos drop constraint opera_contratos_servico_check;
alter table opera_contratos add constraint opera_contratos_servico_check check (servico = any (array['SA','BO','BUNDLE','SETTING','OUTRO']));

do $do$
declare d text; n text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname='opera_lead_para_financeiro';
  n := replace(d, $a$s := case when v_srv like '%BUNDLE%'$a$, $a$s := case when v_srv like '%SETTING%' then 'SETTING'
            when v_srv like '%BUNDLE%'$a$);
  if n = d then raise exception 'opera_lead_para_financeiro: padrão não encontrado'; end if;
  execute n;

  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname='opera_admin_dados';
  n := d;
  n := replace(n, $a$servico in ('SA','BUNDLE')$a$, $a$servico in ('SA','SETTING','BUNDLE')$a$);
  n := replace(n, $a$when 'SA' then coalesce(lugar.sa,0)$a$, $a$when 'SA' then coalesce(lugar.sa,0) when 'SETTING' then coalesce(lugar.sa,0)$a$);
  n := replace(n, $a$when 'SA' then coalesce(l.sa,0)$a$, $a$when 'SA' then coalesce(l.sa,0) when 'SETTING' then coalesce(l.sa,0)$a$);
  n := replace(n, $a$('BUNDLE','Bundle SA + BO',3),('GLOBAL','Global',4)$a$, $a$('BUNDLE','Bundle SA + BO',3),('SETTING','OPERA Setting',4),('GLOBAL','Global',5)$a$);
  if n = d then raise exception 'opera_admin_dados: padrões não encontrados'; end if;
  execute n;
end $do$;
