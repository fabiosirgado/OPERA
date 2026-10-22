import { useCallback, useEffect, useState } from "react";
import { auditLog, getSettings, setAnonymizeAfter } from "../lib/api.js";
import { RETENTION_MONTHS, ROLE_LABEL, fmtWhen } from "../lib/format.js";
import { useAction } from "../ui/feedback.jsx";

const ACTION_LABEL = {
  inicio_sessao: "Início de sessão",
  convite_enviado: "Convite enviado",
  convite_reenviado: "Convite reenviado",
  convite_cancelado: "Convite cancelado",
  convite_aceite: "Convite aceite",
  acesso_dado: "Acesso dado a conta existente",
  ativar_utilizador: "Utilizador reativado",
  desativar_utilizador: "Utilizador desativado",
  atribuir_gestor: "Gestor atribuído",
  ativar_cliente_leads: "Cliente ativado no Leads",
  desativar_cliente: "Cliente desativado",
  reativar_cliente: "Cliente reativado",
  apagar_dados_cliente: "Dados do cliente apagados",
  apagamento_automatico: "Apagamento automático",
  pedido_titular_apagar: "Pedido do titular: apagar",
  anonimizacao_automatica: "Anonimização automática",
  regra_anonimizacao: "Regra de anonimização alterada",
  exportacao: "Exportação",
  pedido_titular_exportar: "Pedido do titular: exportar",
};

// Detalhe legível, sem repetir identificadores internos.
function detailText(a) {
  const d = a.detail || {};
  const parts = [];
  if (d.role) parts.push(ROLE_LABEL[d.role] || d.role);
  if (d.leads !== undefined) parts.push(`${d.leads} leads`);
  if (d.meses !== undefined) parts.push(d.meses ? `${d.meses} meses` : "desligada");
  if (d.apagar_em) parts.push(`apagar a ${fmtWhen(d.apagar_em)}`);
  if (d.aal === "aal2") parts.push("com dois passos");
  return parts.join(" · ");
}

// "Privacidade e RGPD": só o admin vê.
export default function Privacidade() {
  const [log, setLog] = useState(null);
  const [settings, setSettings] = useState(null);
  const [run, busy] = useAction();
  const load = useCallback(async () => {
    const [l, s] = await Promise.all([run(auditLog), run(getSettings)]);
    if (l) setLog(l);
    if (s) setSettings(s);
  }, [run]);
  useEffect(() => { load(); }, [load]);

  const months = settings?.anonymize_after_months ?? 0;
  const change = async (e) => {
    const m = Number(e.target.value);
    if (await run(() => setAnonymizeAfter(m), m ? `Leads desqualificadas sem atividade há ${m} meses vão ser anonimizadas` : "Anonimização automática desligada")) load();
  };

  return (
    <>
      <div className="top"><div><h1>Privacidade e RGPD</h1><div className="sub">Só o admin vê este ecrã</div></div></div>
      <div className="dgrid">
        <div className="panel s6" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3>Conservação de dados</h3>
          <div className="kv" style={{ margin: 0 }}><span>Depois de um cliente sair</span><b>{RETENTION_MONTHS} meses, depois apagado automaticamente</b></div>
          <label className="f">Anonimizar leads desqualificadas sem atividade há mais de
            <select value={months} onChange={change} disabled={!settings || busy}>
              <option value={0}>Desligado</option><option value={12}>12 meses</option><option value={24}>24 meses</option>
            </select>
          </label>
          <span className="sub" style={{ margin: 0, fontSize: 13 }}>
            {months ? "A regra corre todas as noites." : "Desligado: as leads desqualificadas ficam guardadas enquanto o cliente estiver ativo."} A anonimização mantém as chamadas e mudanças de etapa sem dados pessoais, para o dashboard continuar certo.
          </span>
        </div>
        <div className="panel s6" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h3>O que fica fora desta ferramenta</h3>
          <span className="sub" style={{ margin: 0, fontSize: 13 }}>A ferramenta cobre a parte técnica. Para estarem em conformidade faltam também:</span>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "#334155" }}>
            <li>Contrato de subcontratação (artigo 28.º do RGPD) assinado com cada cliente: o cliente é o responsável pelos dados das leads e a OPERA trata os por conta dele.</li>
            <li>Política de privacidade do cliente indicada nos formulários do Meta e nos anúncios dos portais.</li>
            <li>Aviso no início das chamadas de que podem ser gravadas, se a gravação da CloudTalk estiver ligada.</li>
            <li>Registo das atividades de tratamento da OPERA e lista de subcontratantes (Supabase, Netlify, CloudTalk, Make, Anthropic).</li>
            <li>Procedimento para violações de dados: comunicar à CNPD em 72 horas.</li>
          </ol>
        </div>
        <div className="panel s12">
          <h3>Registo de atividade</h3>
          <div className="sub" style={{ margin: "4px 0 0", fontSize: 13 }}>Inícios de sessão, convites, exportações, desativações e apagamentos. Guardado 12 meses.</div>
          <div className="tbl">
            <table>
              <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead>
              <tbody>
                {!log && <tr><td colSpan={4} className="empty">A carregar…</td></tr>}
                {log?.length === 0 && <tr><td colSpan={4} className="empty">Sem registos.</td></tr>}
                {log?.map((a) => (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(a.created_at)}</td>
                    <td>{a.actor ? (a.actor.full_name || a.actor.email) : "Sistema"}</td>
                    <td>{ACTION_LABEL[a.action] || a.action}</td>
                    <td>{detailText(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
