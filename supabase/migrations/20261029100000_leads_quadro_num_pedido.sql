-- OPERA Leads: o quadro pedia uma página por etapa, mais as contagens e os números do topo (10 pedidos de cada
-- vez que alguém abria ou atualizava o quadro). Agora vem tudo num só pedido. As regras de acesso são as mesmas:
-- a função corre como quem a chama e usa as funções de sempre (leads_pipeline, leads_pipeline_counts e
-- leads_pipeline_kpis).
-- Devolve { counts: {etapa: n}, cols: {etapa: [leads]}, kpis: {...} ou null }.

create function public.leads_pipeline_board(p_client uuid, p_label uuid, p_q text, p_mine boolean,
                                            p_sort text, p_dir integer, p_limit integer, p_kpis boolean default false)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v_counts jsonb; v_cols jsonb := '{}'::jsonb; v_kpis jsonb; v_stage uuid;
begin
  select coalesce(jsonb_object_agg(c.stage_id, c.n), '{}'::jsonb) into v_counts
    from public.leads_pipeline_counts(p_client, p_label, p_q, p_mine) c;
  -- As colunas do quadro: as etapas gerais e, com um cliente escolhido, as etapas só desse cliente.
  for v_stage in select s.id from public.lead_stages s where s.client_id is null or s.client_id = p_client loop
    v_cols := v_cols || jsonb_build_object(v_stage, (
      select coalesce(jsonb_agg(to_jsonb(r) - 'ordinality' order by r.ordinality), '[]'::jsonb)
        from public.leads_pipeline(p_client, v_stage, p_label, p_q, p_mine, p_sort, p_dir, 0, p_limit) with ordinality r));
  end loop;
  if p_kpis then
    select to_jsonb(k) into v_kpis from public.leads_pipeline_kpis(p_client) k;
  end if;
  return jsonb_build_object('counts', v_counts, 'cols', v_cols, 'kpis', v_kpis);
end;
$$;
revoke execute on function public.leads_pipeline_board(uuid, uuid, text, boolean, text, integer, integer, boolean) from public, anon;
grant execute on function public.leads_pipeline_board(uuid, uuid, text, boolean, text, integer, integer, boolean) to authenticated;
