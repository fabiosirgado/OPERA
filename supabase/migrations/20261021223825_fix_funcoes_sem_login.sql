-- Correção de segurança: funções internas deixam de poder ser chamadas sem login,
-- e a leitura de documentos por IA passa a confirmar que o documento é de quem a pede.
-- A função original é renomeada (não é recriada) para não voltar a escrever a chave da API.

-- 1. Leitura de documentos: a função original passa a ser interna.
alter function public.iniciar_leitura_documento(uuid, text, text, text)
  rename to _iniciar_leitura_documento;

create function public.iniciar_leitura_documento(p_row_id uuid, p_tipo text, p_mime_type text, p_file_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_storage_path text;
begin
  if auth.uid() is null then
    raise exception 'Sessão em falta.';
  end if;

  if p_tipo = 'custo' then
    select client_id, storage_path into v_client_id, v_storage_path
      from public.financeiro_despesas where id = p_row_id and status = 'processando';
  else
    select client_id, storage_path into v_client_id, v_storage_path
      from public.financeiro_receitas where id = p_row_id and status = 'processando';
  end if;

  if v_client_id is null
     or not (public.current_role() = 'equipa'
             or (v_client_id = public.current_client_id() and public.current_is_responsavel())) then
    raise exception 'Sem permissão para este documento.';
  end if;

  -- Só aceita o link assinado do próprio documento, no storage deste projeto.
  if v_storage_path is null
     or left(p_file_url, length('https://tdxooskqhpncylwmakvv.supabase.co/storage/v1/object/sign/financeiro-docs/' || v_storage_path || '?'))
        <> 'https://tdxooskqhpncylwmakvv.supabase.co/storage/v1/object/sign/financeiro-docs/' || v_storage_path || '?' then
    raise exception 'Link do documento inválido.';
  end if;

  perform public._iniciar_leitura_documento(p_row_id, p_tipo, p_mime_type, p_file_url);
end;
$$;

-- 2. Funções internas: só o servidor (triggers, tarefa agendada, outras funções) as usa.
revoke execute on function public._iniciar_leitura_documento(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.processar_respostas_ia() from public, anon, authenticated;
revoke execute on function public.notify_new_attachment() from public, anon, authenticated;
revoke execute on function public.notify_new_mensagem() from public, anon, authenticated;
revoke execute on function public.notify_new_pedido() from public, anon, authenticated;
revoke execute on function public.notify_pedido_stage_change() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.equipa_notify_emails() from public, anon, authenticated;
revoke execute on function public.pedido_client_recipients(uuid) from public, anon, authenticated;
revoke execute on function public.gerar_relatorio_financeiro(uuid, integer, integer) from public, anon, authenticated;

-- 3. Funções usadas pela app: só com sessão iniciada.
revoke execute on function public.iniciar_leitura_documento(uuid, text, text, text) from public, anon;
grant execute on function public.iniciar_leitura_documento(uuid, text, text, text) to authenticated;
revoke execute on function public.iniciar_relatorio_financeiro(uuid, integer, integer) from public, anon;
revoke execute on function public.processar_documento_financeiro(uuid, text, text, text, text) from public, anon;
