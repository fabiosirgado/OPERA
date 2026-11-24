-- OPERA Leads, Setting B2B: o admin escolhe o tipo de serviço de um cliente (imobiliário ou setting) no ecrã Clientes e
-- acessos. Ao passar a setting, o gatilho clients_setting_preparar cria as etapas do cliente e a configuração por omissão.
create or replace function public.leads_cliente_tipo_servico(p_client uuid, p_tipo text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.leads_is_admin() then raise exception 'Só o administrador pode mudar o tipo de serviço.'; end if;
  if p_tipo not in ('imobiliario', 'setting') then raise exception 'Tipo de serviço inválido.'; end if;
  update public.clients set service_type = p_tipo where id = p_client;
  if not found then raise exception 'Cliente não encontrado.'; end if;
end $$;

revoke all on function public.leads_cliente_tipo_servico(uuid, text) from public, anon;
grant execute on function public.leads_cliente_tipo_servico(uuid, text) to authenticated;
