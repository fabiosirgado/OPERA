import { useCallback, useEffect, useState } from "react";
import { waClienteDefinir, waDefinicoesGuardar, waFilaHoje, waLigar, waMeta, waMetricas, waPainel, waPrevisao } from "../lib/leadsApi.js";
import { useAction } from "../ui/feedback.jsx";

// Ecrã WhatsApp (só admin): reativação da BD por WhatsApp, especificação REATIVACAO_WHATSAPP (secções 8, 9.1 e 10.2).
// Tudo começa desligado: sem um cliente com WhatsApp ligado e consentimento verificado não sai nenhuma mensagem.

const ESTADO_FILA = { pending: "Por enviar", sending: "A enviar", sent: "Enviada", skipped: "Não enviada", failed: "Falhou" };
const MODELO = { D: "D · Comprador", B: "B · Proprietário", C: "C · Geral", N: "N · Lead nova não alcançada", M1: "M1 · Lead nova não atendida", M3: "M3 · Reativada não atendida" };
const TIPO = { sim: "Sim", mais_tarde: "Mais tarde", ja_nao: "Já não", nao_contactar: "Não contactar", texto: "Resposta escrita", marcar_chamada: "Marcou chamada", outro: "Outro" };
const hoje = () => new Date().toISOString().slice(0, 10);
const diasAtras = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const hora = (t) => (t ? new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }) : "");

export default function WhatsApp() {
  const [p, setP] = useState(null);
  const [fila, setFila] = useState(null);
  const [prev, setPrev] = useState({});
  const [meta, setMeta] = useState(null);
  const [def, setDef] = useState(null);
  const [periodo, setPeriodo] = useState({ de: diasAtras(7), ate: hoje() });
  const [met, setMet] = useState(null);
  const [run, busy] = useAction();

  const load = useCallback(() => Promise.all([
    waPainel().then((d) => { setP(d); setDef((x) => x ?? d.definicoes); }),
    waFilaHoje().then(setFila),
  ]), []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  useEffect(() => { waMetricas(periodo.de, periodo.ate).then(setMet).catch(() => setMet(null)); }, [periodo]);

  const cliente = (c, patch, ok) => run(() => waClienteDefinir(c.id, patch), ok).then((r) => r && load());
  const previsao = (c) => {
    if (prev[c.id]) { setPrev((x) => ({ ...x, [c.id]: null })); return; }
    run(() => waPrevisao(c.id)).then((r) => r && setPrev((x) => ({ ...x, [c.id]: r })));
  };
  const metaAcao = (a, ok) => run(() => waMeta(a), ok).then((r) => { if (r) { setMeta({ acao: a, ...r }); load(); } });

  if (!p) return <div className="empty">A carregar…</div>;
  const d = p.definicoes;
  return (
    <>
      <div className="top">
        <div><h1>WhatsApp</h1><div className="sub">Reativação da BD por WhatsApp. Só quem responde entra na fila, como lead nova.</div></div>
      </div>

      <div className={`banner ${d.wa_live ? "green" : "orange"}`} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <span style={{ flex: 1, minWidth: 240 }}>
          {d.wa_live
            ? <><b>WhatsApp em funcionamento.</b> A Fila segue as regras do WhatsApp nos clientes ligados e a etapa "Nova Lead Reativada" está ativa.</>
            : <><b>Desligado (wa_live).</b> As regras novas da Fila e a etapa "Nova Lead Reativada" só entram no dia de arranque. Os envios dependem de cada cliente estar ligado.</>}
        </span>
        <button type="button" className={`btn sm ${d.wa_live ? "" : "dark"}`} disabled={busy}
          onClick={() => {
            if (!d.wa_live && !window.confirm("Arrancar o WhatsApp? A Fila passa a seguir as regras novas nos clientes ligados e é criada a etapa \"Nova Lead Reativada\".")) return;
            run(() => waLigar(!d.wa_live), d.wa_live ? "WhatsApp desligado" : "WhatsApp ligado").then((r) => r && load());
          }}>{d.wa_live ? "Desligar" : "Arrancar (dia de arranque)"}</button>
      </div>

      <div className="stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <div className="stat"><span>Hoje por enviar</span><b>{p.hoje.pendentes}</b><small>{p.dia_util ? `janela ${d.wa_window_start} às ${d.wa_window_end}` : "hoje não é dia útil"}</small></div>
        <div className="stat"><span>Enviadas hoje</span><b>{p.hoje.enviadas}</b><small>reativação, M1 e M3</small></div>
        <div className="stat"><span>Não enviadas</span><b>{p.hoje.ignoradas}</b><small>bloqueadas à última hora</small></div>
        <div className={`stat ${p.hoje.falhadas ? "warn" : ""}`}><span>Falhadas</span><b>{p.hoje.falhadas}</b><small>erro da Meta</small></div>
      </div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3>Clientes</h3>
        <span className="sub" style={{ margin: 0, fontSize: 13 }}>
          Um cliente só recebe envios com WhatsApp ligado, consentimento verificado e o nome do consultor. Pré visualiza antes de ligar.
        </span>
        <div className="tbl"><table>
          <thead><tr><th>Cliente</th><th>Consultor (nas mensagens)</th><th>Consentimento</th><th>Fim de semana</th><th>WhatsApp</th>
            <th className="n">Enviadas hoje</th><th className="n">Por enviar</th><th></th></tr></thead>
          <tbody>
            {(p.clientes ?? []).map((c) => (
              <ClienteLinha key={c.id} c={c} busy={busy} prev={prev[c.id]} onPrev={() => previsao(c)} onSet={cliente} />
            ))}
          </tbody>
        </table></div>
      </div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <h3>Envios de hoje e de ontem</h3>
          <button type="button" className="btn sm" disabled={busy} onClick={() => load()}>Atualizar</button>
        </div>
        {!fila?.length && <div className="sub" style={{ fontSize: 13 }}>Ainda não há envios. O plano do dia é feito às {d.wa_window_start}, nos dias úteis, para os clientes ligados.</div>}
        {fila?.length > 0 && (
          <div className="tbl" style={{ maxHeight: 420, overflowY: "auto" }}><table>
            <thead><tr><th>Hora</th><th>Lead</th><th>Cliente</th><th>Modelo</th><th>Estado</th><th>Mensagem</th></tr></thead>
            <tbody>{fila.map((q) => (
              <tr key={q.id}>
                <td>{hora(q.enviada || q.quando)}</td><td>{q.lead}</td><td>{q.cliente}</td><td>{q.modelo}</td>
                <td>{ESTADO_FILA[q.estado] ?? q.estado}{q.motivo ? ` · ${q.motivo}` : ""}</td>
                <td style={{ maxWidth: 380, fontSize: 12, color: "var(--mute)" }}>{q.texto}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
        <div className="panel" style={{ flex: "1 1 340px", display: "flex", flexDirection: "column", gap: 10 }}>
          <h3>Modelos na Meta</h3>
          <div className="tbl"><table>
            <thead><tr><th>Modelo</th><th>Nome</th><th>Estado</th></tr></thead>
            <tbody>{(p.modelos ?? []).map((m) => (
              <tr key={m.code}><td>{MODELO[m.code] ?? m.code}</td><td style={{ fontSize: 12 }}>{m.name}</td>
                <td style={{ color: m.status === "APPROVED" ? "var(--greenText)" : "#7C2D12" }}>{m.status === "APPROVED" ? "Aprovado" : m.status ? m.status : "Por verificar"}</td></tr>))}
            </tbody>
          </table></div>
          <span style={{ fontSize: 12, color: "var(--mute2)" }}>Só os modelos aprovados são enviados. O estado é lido da Meta a cada 30 minutos.</span>
          <div className="row">
            <button type="button" className="btn sm" disabled={busy} onClick={() => metaAcao("templates", "Estado dos modelos atualizado")}>Ler estado na Meta</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => metaAcao("estado")}>Verificar ligação</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => metaAcao("configurar", "Pedido enviado à Meta")}>Configurar webhook</button>
          </div>
          {meta && <pre style={{ margin: 0, fontSize: 11, background: "#F8FAFC", border: "1px solid var(--line)", borderRadius: 8, padding: 10, overflowX: "auto", maxHeight: 220 }}>{JSON.stringify(meta, null, 2)}</pre>}
        </div>

        {def && (
          <div className="panel" style={{ flex: "1 1 340px", display: "flex", flexDirection: "column", gap: 10 }}>
            <h3>Definições</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
              <label className="f">Envios por cliente por dia<input type="number" min="0" max="250" value={def.wa_per_client_daily} onChange={(e) => setDef({ ...def, wa_per_client_daily: e.target.value })} /></label>
              <label className="f">Teto global por dia<input type="number" min="0" value={def.wa_daily_limit} onChange={(e) => setDef({ ...def, wa_daily_limit: e.target.value })} /></label>
              <label className="f">Janela: início<input type="time" value={def.wa_window_start} onChange={(e) => setDef({ ...def, wa_window_start: e.target.value })} /></label>
              <label className="f">Janela: fim<input type="time" value={def.wa_window_end} onChange={(e) => setDef({ ...def, wa_window_end: e.target.value })} /></label>
              <label className="f">Dias sem resposta<input type="number" min="1" max="60" value={def.wa_no_reply_days} onChange={(e) => setDef({ ...def, wa_no_reply_days: e.target.value })} /></label>
            </div>
            <div className="row"><button type="button" className="btn sm primary" disabled={busy}
              onClick={() => run(() => waDefinicoesGuardar({ wa_per_client_daily: Number(def.wa_per_client_daily), wa_daily_limit: Number(def.wa_daily_limit),
                wa_window_start: def.wa_window_start, wa_window_end: def.wa_window_end, wa_no_reply_days: Number(def.wa_no_reply_days) }), "Definições guardadas").then((r) => r && load())}>
              Guardar</button></div>
            <span style={{ fontSize: 12, color: "var(--mute2)" }}>O teto global é o limite da Meta sem verificação da empresa (250 contactos únicos por 24 horas). O M1 tem sempre prioridade dentro do teto.</span>
          </div>
        )}
      </div>

      <Metricas met={met} periodo={periodo} setPeriodo={setPeriodo} />
    </>
  );
}

function ClienteLinha({ c, busy, prev, onPrev, onSet }) {
  const [nome, setNome] = useState(c.wa_consultant_name ?? "");
  useEffect(() => { setNome(c.wa_consultant_name ?? ""); }, [c.wa_consultant_name]);
  return (
    <>
      <tr>
        <td><span className="dot" style={{ background: c.color, display: "inline-block", marginRight: 8 }}></span>{c.name}</td>
        <td><input aria-label={`Nome do consultor de ${c.name}`} value={nome} placeholder="Ex.: João Marafuz" style={{ minHeight: 34, border: "1px solid var(--line2)", borderRadius: 8, padding: "0 10px", width: 180 }}
          onChange={(e) => setNome(e.target.value)}
          onBlur={() => nome !== (c.wa_consultant_name ?? "") && onSet(c, { wa_consultant_name: nome }, "Nome do consultor guardado")} /></td>
        <td><input type="checkbox" aria-label="Consentimento verificado" checked={c.wa_consent_ok} disabled={busy}
          onChange={() => onSet(c, { wa_consent_ok: !c.wa_consent_ok, ...(c.wa_consent_ok ? { wa_enabled: false } : {}) }, c.wa_consent_ok ? "Consentimento retirado" : "Consentimento verificado")} /></td>
        <td><input type="checkbox" aria-label="Plano de fim de semana" checked={c.weekend_enabled} disabled={busy}
          onChange={() => onSet(c, { weekend_enabled: !c.weekend_enabled }, "Fim de semana atualizado")} /></td>
        <td><input type="checkbox" aria-label="WhatsApp ligado" checked={c.wa_enabled} disabled={busy}
          onChange={() => {
            if (!c.wa_enabled && !window.confirm(`Ligar o WhatsApp de ${c.name}? Começam a sair mensagens a leads reais (até ao limite por dia).`)) return;
            onSet(c, { wa_enabled: !c.wa_enabled }, c.wa_enabled ? "WhatsApp desligado" : "WhatsApp ligado");
          }} /></td>
        <td className="n">{c.enviadas_hoje}</td><td className="n">{c.na_fila_hoje}</td>
        <td><button type="button" className="link" disabled={busy} onClick={onPrev}>{prev ? "Fechar" : "Pré visualizar"}</button></td>
      </tr>
      {prev && (
        <tr><td colSpan={8} style={{ background: "#F8FAFC" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "6px 0" }}>
            <span style={{ fontSize: 13 }}><b>{prev.elegiveis}</b> leads elegíveis de {prev.candidatas} candidatas ·{" "}
              {Object.entries(prev.por_modelo).map(([k, n]) => `${MODELO[k] ?? k}: ${n}`).join(" · ") || "nenhuma por modelo"}</span>
            {Object.keys(prev.bloqueadas).length > 0 && (
              <span style={{ fontSize: 12, color: "var(--mute)" }}>Fora do envio: {Object.entries(prev.bloqueadas).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(" · ")}</span>
            )}
            {prev.exemplos.map((e, i) => (
              <div key={i} style={{ fontSize: 13, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px" }}>
                <span style={{ fontSize: 11, color: "var(--mute)" }}>{MODELO[e.modelo] ?? e.modelo} · {e.lead}</span><br />{e.texto}
              </div>
            ))}
          </div>
        </td></tr>
      )}
    </>
  );
}

function Metricas({ met, periodo, setPeriodo }) {
  const tot = (met?.por_cliente ?? []).reduce((a, c) => ({ env: a.env + c.enviadas, ent: a.ent + c.entregues, lid: a.lid + c.lidas, fal: a.fal + c.falhadas }), { env: 0, ent: 0, lid: 0, fal: 0 });
  const respostas = met?.respostas ?? [];
  const modelos = [...new Set(respostas.map((r) => r.modelo))];
  const tipos = [...new Set(respostas.map((r) => r.tipo))];
  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <h3>Métricas</h3>
        <div className="row">
          <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>De<input type="date" value={periodo.de} onChange={(e) => setPeriodo({ ...periodo, de: e.target.value })} /></label>
          <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>Até<input type="date" value={periodo.ate} onChange={(e) => setPeriodo({ ...periodo, ate: e.target.value })} /></label>
        </div>
      </div>
      {!met && <div className="sub" style={{ fontSize: 13 }}>A carregar…</div>}
      {met && (
        <>
          <div className="stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <div className="stat"><span>Modelos enviados</span><b>{tot.env}</b><small>{tot.ent} entregues · {tot.lid} lidos · {tot.fal} falhados</small></div>
            <div className="stat"><span>Taxa de entrega</span><b>{pct(tot.ent, tot.env)}</b><small>a meta no arranque é acima de 90%</small></div>
            <div className="stat"><span>Taxa de resposta</span><b>{pct(met.leads_que_responderam, met.leads_com_modelo)}</b><small>{met.leads_que_responderam} de {met.leads_com_modelo} leads com modelo entregue</small></div>
            <div className="stat"><span>Reativadas</span><b>{met.reativadas}</b><small>{met.reativadas_qualificadas} já qualificadas · {pct(met.reativadas, met.leads_com_modelo)} das entregues</small></div>
            <div className="stat"><span>Time to Lead de reativação</span><b>{met.ttl_reativacao_min != null ? `${met.ttl_reativacao_min} min` : "—"}</b><small>mediana entre a resposta e a 1.ª chamada</small></div>
            <div className={`stat ${met.reativadas_por_ligar_hoje ? "warn" : ""}`}><span>Reativadas por ligar hoje</span><b>{met.reativadas_por_ligar_hoje}</b><small>responderam hoje e ainda sem chamada</small></div>
          </div>
          {met.por_cliente.length > 0 && (
            <div className="tbl"><table>
              <thead><tr><th>Cliente</th><th className="n">Enviadas</th><th className="n">Entregues</th><th className="n">Lidas</th><th className="n">Falhadas</th><th className="n">Bloqueios</th></tr></thead>
              <tbody>{met.por_cliente.map((c) => (
                <tr key={c.cliente}><td>{c.cliente}</td><td className="n">{c.enviadas}</td><td className="n">{c.entregues} ({pct(c.entregues, c.enviadas)})</td>
                  <td className="n">{c.lidas}</td><td className="n">{c.falhadas}</td><td className="n">{c.bloqueios}</td></tr>))}</tbody>
            </table></div>
          )}
          {respostas.length > 0 && (
            <div className="tbl"><table>
              <thead><tr><th>Respostas</th>{tipos.map((t) => <th key={t} className="n">{TIPO[t] ?? t}</th>)}</tr></thead>
              <tbody>{modelos.map((m) => (
                <tr key={m}><td>{MODELO[m] ?? m}</td>{tipos.map((t) => <td key={t} className="n">{respostas.find((r) => r.modelo === m && r.tipo === t)?.n ?? 0}</td>)}</tr>))}</tbody>
            </table></div>
          )}
          {met.tentativas_por_dia.length > 0 && (
            <div className="tbl" style={{ maxHeight: 260, overflowY: "auto" }}><table>
              <thead><tr><th>Dia</th><th>Gestor</th><th className="n">Chamadas</th></tr></thead>
              <tbody>{met.tentativas_por_dia.map((r, i) => <tr key={i}><td>{r.dia}</td><td>{r.gestor}</td><td className="n">{r.chamadas}</td></tr>)}</tbody>
            </table></div>
          )}
          <span style={{ fontSize: 12, color: "var(--mute2)" }}>
            Base de comparação das chamadas por dia do Gestor de Leads: 117 chamadas por dia e 1,7 h em linha (26 out a 19 nov).
            A qualidade do número vê-se em "Verificar ligação" (quality_rating).
          </span>
        </>
      )}
    </div>
  );
}
