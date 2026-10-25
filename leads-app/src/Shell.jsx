import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sb } from "./supabase.js";
import { ROLE_LABEL, initials } from "./lib/format.js";
import { activeClients, conversations, countNewLeads, isAutoNewLead, listLabels, listStages, subscribeChanges, today } from "./lib/leadsApi.js";
import GlobalSearch from "./ui/GlobalSearch.jsx";
import NewLeadAlerts from "./ui/NewLeadAlerts.jsx";
import Clientes from "./screens/Clientes.jsx";
import Equipa from "./screens/Equipa.jsx";
import Privacidade from "./screens/Privacidade.jsx";
import Pipeline from "./screens/Pipeline.jsx";
import Hoje from "./screens/Hoje.jsx";
import ImportExport from "./screens/ImportExport.jsx";
import Dashboard from "./screens/Dashboard.jsx";
import Entradas from "./screens/Entradas.jsx";
import Conversas from "./screens/Conversas.jsx";
import LeadModal from "./screens/LeadModal.jsx";
import { LabelsModal, NewLeadModal, StageModal } from "./screens/smallModals.jsx";

const VIEW_KEY = "opera-leads-vista";
const CLIENT_KEY = "opera-leads-cliente";
const read = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* sem armazenamento */ } };

// Menu lateral, ecrã escolhido e janelas (ficha da lead, nova lead, etapas, etiquetas), como no protótipo.
export default function Shell({ access }) {
  const { profile, client: myClient, opera } = access;
  const role = profile.leads_role;
  const items = opera
    ? [["pipeline", "Pipeline geral"], ["hoje", "Hoje"], ["conversas", "Conversas"], ["dash", "Dashboard"], ["io", "Importar e exportar"], ["entradas", "Entradas automáticas"], ["clientes", "Clientes e acessos"], ...(role === "admin" ? [["privacidade", "Privacidade e RGPD"]] : [])]
    : [["pipeline", "As vossas leads"], ["conversa", "Conversa com a OPERA"], ["dash", "Dashboard"], ...(role === "cliente_admin" ? [["equipa", "A minha equipa"]] : [])];
  const [view, setView] = useState(() => (items.some(([k]) => k === read(VIEW_KEY)) ? read(VIEW_KEY) : items[0][0]));
  const go = (v) => { setView(v); write(VIEW_KEY, v); };

  const [stages, setStages] = useState([]);
  const [labels, setLabels] = useState([]);
  const [clients, setClients] = useState(myClient ? [myClient] : []);
  const [filterClient, setFilterClientState] = useState(() => (opera ? read(CLIENT_KEY) || null : null));
  const [version, setVersion] = useState(0);
  const [modal, setModal] = useState(null);
  const [dueToday, setDueToday] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [chats, setChats] = useState([]);
  const [chatVersion, setChatVersion] = useState(0);
  const [chatClient, setChatClient] = useState(null);
  const setFilterClient = (id) => { setFilterClientState(id); write(CLIENT_KEY, id); };

  const loadRefs = useCallback(async () => {
    const [s, l, c] = await Promise.all([listStages(), listLabels(), opera ? activeClients() : Promise.resolve([myClient])]);
    setStages(s); setLabels(l); setClients(c);
    if (opera && filterClient && !c.some((x) => x.id === filterClient)) setFilterClient(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opera, myClient]);
  useEffect(() => { loadRefs().catch(() => {}); }, [loadRefs]);

  // Tempo real: quando entra uma lead ou alguém muda uma etapa, os ecrãs voltam a pedir os dados.
  const bumpTimer = useRef();
  const bump = useCallback(() => {
    clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => setVersion((v) => v + 1), 400);
  }, []);
  // Lead nova vinda de uma entrada automática: aviso no ecrã (só a equipa OPERA as vê nas etapas de entrada).
  const refs = useRef({ stages: [], clients: [] });
  refs.current = { stages, clients };
  const chatTimer = useRef();
  const onChange = useCallback((table, payload) => {
    // Mensagens das conversas: só a conversa e os números por ler voltam a pedir os dados.
    if (table === "client_messages" || table === "client_message_reads" || table === "*") {
      clearTimeout(chatTimer.current);
      chatTimer.current = setTimeout(() => setChatVersion((v) => v + 1), 250);
      if (table !== "*") return;
    }
    bump();
    if (!opera || table !== "leads" || payload?.eventType !== "INSERT") return;
    const l = payload.new;
    const stageById = Object.fromEntries(refs.current.stages.map((x) => [x.id, x]));
    if (!isAutoNewLead(l, stageById)) return;
    const client = refs.current.clients.find((c) => c.id === l.client_id)?.name ?? "";
    setAlerts((a) => (a.some((x) => x.id === l.id) ? a : [...a, { id: l.id, name: l.name, client, source: l.source }]));
  }, [bump, opera]);
  useEffect(() => subscribeChanges(onChange), [onChange]);
  const closeAlert = (id) => setAlerts((a) => (id === "*" ? [] : a.filter((x) => x.id !== id)));

  // Conversas: mensagens por ler em cada cliente (número no menu e nos clientes ativos).
  const loadChats = useCallback(() => { conversations().then(setChats).catch(() => {}); }, []);
  useEffect(() => { loadChats(); }, [loadChats, chatVersion]);
  const unreadBy = Object.fromEntries(chats.map((c) => [c.client_id, c.unread]));
  const unread = chats.reduce((n, c) => n + (c.unread || 0), 0);
  const openChat = (id) => { setChatClient(id); go(opera ? "conversas" : "conversa"); };

  // Número no menu "Pipeline geral": leads novas em que ainda ninguém pegou.
  useEffect(() => {
    if (!opera || !stages.length) return;
    countNewLeads(stages.filter((x) => x.position < 50).map((x) => x.id)).then(setNewCount).catch(() => {});
  }, [opera, stages, version]);

  // Número no menu "Hoje": tarefas até ao fim do dia.
  useEffect(() => {
    if (!opera) return;
    today(null, null).then((r) => {
      const end = new Date(); end.setHours(23, 59, 59, 999);
      const n = r.filter((t) => new Date(t.due_at) <= end).length;
      setDueToday(r.length >= 500 && n === r.length ? "500+" : n);
    }).catch(() => {});
  }, [opera, version]);

  const ctx = useMemo(() => ({
    me: profile.id, opera, myClient, stages, labels, clients, version, filterClient, setFilterClient,
    defaultClient: filterClient,
    onChanged: () => { bump(); },
    onRefsChanged: () => { loadRefs(); bump(); },
    onOpenLead: (id) => setModal({ kind: "lead", id }),
    onGo: (v) => go(v),
    onNewLead: () => setModal({ kind: "newLead" }),
    onNewStage: () => setModal({ kind: "newStage" }),
    onOpenLabels: () => setModal((m) => ({ kind: "labels", back: m?.kind === "lead" ? m.id : null })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [profile.id, opera, myClient, stages, labels, clients, version, filterClient, bump, loadRefs]);

  // Links dos emails de aviso: ?lead=<id> abre logo a ficha e ?conversa=<cliente> a conversa (depois do login); depois sai do endereço.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("lead");
    const chat = params.get("conversa");
    if (!id && !chat) return;
    if (id && /^[0-9a-f-]{36}$/i.test(id)) setModal({ kind: "lead", id });
    else if (chat && /^[0-9a-f-]{36}$/i.test(chat)) openChat(chat);
    window.history.replaceState(null, "", window.location.pathname);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeModal = useCallback(() => setModal(null), []);
  const refCtx = { ...ctx, onChanged: ctx.onRefsChanged };

  return (
    <div className="app">
      <nav className="side" aria-label="Menu principal">
        <div className="brand"><b>OPERA</b><span>Leads</span></div>
        <GlobalSearch opera={opera} onOpen={ctx.onOpenLead} />
        <div className="nav">
          {items.map(([k, label]) => (
            <button key={k} type="button" className={view === k ? "on" : ""} aria-current={view === k ? "page" : undefined} onClick={() => go(k)}>
              {label}{k === "hoje" && dueToday > 0 && <span className="badge">{dueToday}</span>}
              {k === "pipeline" && newCount > 0 && <span className="badge new" title="Leads novas por pegar">{newCount}</span>}
              {(k === "conversas" || k === "conversa") && unread > 0 && <span className="badge msg" title="Mensagens por ler">{unread}</span>}
            </button>
          ))}
        </div>
        {opera && clients.length > 0 && (
          <div>
            <h4>Clientes ativos</h4>
            <div className="clients">
              {clients.map((c) => (
                <button key={c.id} type="button" onClick={() => { setFilterClient(c.id); go("pipeline"); }}>
                  <span className="dot" style={{ background: c.color }}></span>{c.name}
                  {unreadBy[c.id] > 0 && <span className="ubadge" title="Mensagens por ler na conversa">{unreadBy[c.id]}<span className="vh"> mensagens por ler</span></span>}
                  <small>{c.leads_count}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="ubox">
          <div className="who">
            <span className="av">{initials(profile.full_name || profile.email)}</span>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <b style={{ fontSize: 13 }}>{profile.full_name || profile.email}</b>
              <small>{ROLE_LABEL[role]}{myClient ? ` · ${myClient.name}` : ""}</small>
            </div>
          </div>
          <button type="button" onClick={() => sb.auth.signOut()}>Terminar sessão</button>
        </div>
      </nav>
      <main>
        {stages.length > 0 && view === "pipeline" && <Pipeline ctx={ctx} />}
        {stages.length > 0 && view === "hoje" && <Hoje ctx={ctx} />}
        {stages.length > 0 && view === "io" && <ImportExport ctx={ctx} />}
        {(view === "conversas" || view === "conversa") && (
          <Conversas ctx={ctx} list={chats} selected={chatClient} onSelect={setChatClient} chatVersion={chatVersion} onRead={loadChats} />
        )}
        {view === "dash" && <Dashboard ctx={ctx} isAdmin={role === "admin"} opera={opera} />}
        {view === "entradas" && <Entradas ctx={ctx} isAdmin={role === "admin"} />}
        {view === "clientes" && <Clientes profile={profile} />}
        {view === "equipa" && <Equipa profile={profile} client={myClient} />}
        {view === "privacidade" && <Privacidade />}
      </main>

      <NewLeadAlerts alerts={alerts} onClose={closeAlert}
        onOpen={(id) => { closeAlert(id); setModal({ kind: "lead", id }); }} />
      {modal?.kind === "lead" && <LeadModal key={modal.id} id={modal.id} ctx={ctx} onClose={closeModal} />}
      {modal?.kind === "newLead" && <NewLeadModal ctx={ctx} onClose={closeModal} />}
      {modal?.kind === "newStage" && <StageModal ctx={refCtx} onClose={closeModal} />}
      {modal?.kind === "labels" && (
        <LabelsModal ctx={refCtx} onClose={() => (modal.back ? setModal({ kind: "lead", id: modal.back }) : closeModal())} />
      )}
    </div>
  );
}
