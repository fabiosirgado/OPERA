// Pedido de acesso do titular: tudo o que existe sobre a pessoa, num ficheiro JSON.
// A exportação fica no registo de atividade antes de o ficheiro ser gerado.
import { sb } from "../supabase.js";

export async function exportSubject(lead, events, tasks, labels) {
  const { error } = await sb.rpc("leads_log_export", { p_scope: "titular", p_count: 1, p_lead_id: lead.id });
  if (error) throw error;
  const labelName = Object.fromEntries(labels.map((l) => [l.id, l.name]));
  const data = {
    exportado_em: new Date().toISOString(),
    cliente: lead.client.name,
    lead: {
      nome: lead.name, telefone: lead.phone, email: lead.email, origem: lead.source, interesse: lead.interest,
      qualificacao: lead.qualification, entrada: lead.created_at, hora_na_origem: lead.source_created_at,
      primeira_chamada: lead.first_call_at, ultimo_contacto: lead.last_contact_at, tentativas: lead.attempts,
      etiquetas: lead.links.map((x) => labelName[x.label_id]).filter(Boolean),
    },
    historico: events.map((e) => ({ tipo: e.type, titulo: e.title, texto: e.body, quando: e.created_at, dados: e.meta })),
    tarefas: tasks.map((t) => ({ tipo: t.type, quando: t.due_at, nota: t.note, concluida: t.done_at })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `dados_titular_${lead.name.replace(/[^\p{L}\p{N}]+/gu, "_").toLowerCase()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
