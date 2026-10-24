-- Correção de segurança: a processar_documento_financeiro não é usada pelo CRM e a sua verificação
-- de permissões falha para contas sem cliente associado. Passa a ser só interna.
revoke execute on function public.processar_documento_financeiro(uuid, text, text, text, text) from public, anon, authenticated;
