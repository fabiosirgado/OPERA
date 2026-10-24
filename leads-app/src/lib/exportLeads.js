// Exportação: o servidor devolve 1000 leads de cada vez e regista a exportação no registo de atividade.
import { sb } from "../supabase.js";
import { downloadXlsx, exportRows } from "./excel.js";

export async function exportLeads({ client = null, stages = null, since = null, history = false, pipedrive = false, fileName, onProgress }) {
  const all = [];
  let total = Infinity;
  while (all.length < total) {
    const { data, error } = await sb.rpc("leads_export", {
      p_client: client, p_stages: stages, p_since: since, p_history: history || pipedrive, p_offset: all.length,
    });
    if (error) throw error;
    total = data.total;
    all.push(...data.rows);
    onProgress?.(all.length, total);
    if (!data.rows.length) break;
  }
  if (!all.length) throw new Error("Não há leads para exportar com estes filtros.");
  downloadXlsx(exportRows(all, { history, pipedrive }), fileName);
  return all.length;
}
