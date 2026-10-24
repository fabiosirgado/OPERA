-- CRM: as chaves da Anthropic e do Resend saem do código das funções e passam para o Vault (correção 2).
-- Aplicado na produção a 2026-10-24, com chaves novas criadas só para o CRM:
--   vault: crm_resend_api_key     (Resend, só envio, domínio opera-os.com)
--          crm_anthropic_api_key  (Anthropic, espaço de trabalho Default)
-- Funções alteradas (todas security definer, dono postgres): notify_new_attachment, notify_new_mensagem,
-- notify_new_pedido, notify_pedido_stage_change, _iniciar_leitura_documento, processar_documento_financeiro,
-- iniciar_relatorio_financeiro, gerar_relatorio_financeiro.
--
-- A troca é feita na base de dados, sobre a definição atual de cada função, para as chaves nunca saírem dela:
-- serve tanto para as chaves reais (produção) como para os marcadores "<... removida>" do esquema inicial.
-- Os segredos crm_* têm de existir no Vault antes de esta migração correr.
do $$
declare r record; def text; n int := 0;
begin
  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and (p.prosrc ~ 'sk-ant-[A-Za-z0-9_-]{10,}' or p.prosrc ~ 're_[A-Za-z0-9_]{10,}'
            or p.prosrc like '%<ANTHROPIC_API_KEY removida>%' or p.prosrc like '%<RESEND_API_KEY removida>%')
  loop
    def := pg_get_functiondef(r.oid);
    def := regexp_replace(def, '''Bearer (re_[A-Za-z0-9_]{10,}|<RESEND_API_KEY removida>)''',
      '(''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''crm_resend_api_key''))', 'g');
    def := regexp_replace(def, '''(sk-ant-[A-Za-z0-9_-]{10,}|<ANTHROPIC_API_KEY removida>)''',
      '(select decrypted_secret from vault.decrypted_secrets where name = ''crm_anthropic_api_key'')', 'g');
    if def ~ 'sk-ant-[A-Za-z0-9_-]{10,}' or def ~ 're_[A-Za-z0-9_]{10,}' or def like '%removida>%' then
      raise exception 'Ainda há uma chave na função %', r.proname;
    end if;
    execute def;
    n := n + 1;
  end loop;
  raise notice 'Funções alteradas: %', n;
end $$;
