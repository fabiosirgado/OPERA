import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sb } from "./supabase.js";
import { ROLE_LABEL, initials } from "./lib/format.js";
import { activeClients, conversations, countNewLeads, isAutoNewLead, listLabels, listStages, subscribeChanges, today } from "./lib/leadsApi.js";
import GlobalSearch from "./ui/GlobalSearch.jsx";
import NewLeadAlerts from "./ui/NewLeadAlerts.jsx";
import AppSetup from "./ui/AppSetup.jsx";
import { forgetDevice } from "./lib/push.js";
import Pipeline from "./screens/Pipeline.jsx";
import Hoje from "./screens/Hoje.jsx";
import LeadModal from "./screens/LeadModal.jsx";
import { LabelsModal, NewLeadModal, StageModal } from "./screens/smallModals.jsx";

// Ecrãs menos usados: só se carregam quando se abrem, para o Leads abrir mais depressa.
const Clientes = lazy(() => import("./screens/Clientes.jsx"));
const Equipa = lazy(() => import("./screens/Equipa.jsx"));
const Privacidade = lazy(() => import("./screens/Privacidade.jsx"));
const ImportExport = lazy(() => import("./screens/ImportExport.jsx"));
const Dashboard = lazy(() => import("./screens/Dashboard.jsx"));
const Entradas = lazy(() => import("./screens/Entradas.jsx"));
const Conversas = lazy(() => import("./screens/Conversas.jsx"));
const AdminDashboard = lazy(() => import("./screens/admin/AdminDashboard.jsx"));

const VIEW_KEY = "opera-leads-vista";
const CLIENT_KEY = "opera-leads-cliente";
const read = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* sem armazenamento */ } };

// Menu lateral, ecrã escolhido e janelas (ficha da lead, nova lead, etapas, etiquetas), como no protótipo.
export default function Shell({ access }) {
  const { profile, client: myClient, opera } = access;
  const role = profile.leads_role;
  // Dashboard Admin: só para quem está na lista de acessos (o servidor confirma o nível em cada pedido).
  const [adminNivel, setAdminNivel] = useState(undefined);
  useEffect(() => {
    if (!opera) { setAdminNivel(null); return; }
    sb.rpc("opera_admin_meu_nivel").then(({ data }) => setAdminNivel(data?.nivel || null), () => setAdminNivel(null));
  }, [opera]);
  const items = opera
    ? [["pipeline", "Pipeline geral"], ["hoje", "Hoje"], ["conversas", "Conversas"], ["dash", "Dashboard"], ...(adminNivel ? [["admin", "Dashboard Admin"]] : []), ["io", "Importar e exportar"], ["entradas", "Entradas automáticas"], ["clientes", "Clientes e acessos"], ...(role === "admin" ? [["privacidade", "Privacidade e RGPD"]] : [])]
    : [["pipeline", "As vossas leads"], ["conversa", "Conversa com a OPERA"], ["dash", "Dashboard"], ...(role === "cliente_admin" ? [["equipa", "A minha equipa"]] : [])];
  const [view, setView] = useState(() => ((opera && read(VIEW_KEY) === "admin") || items.some(([k]) => k === read(VIEW_KEY)) ? read(VIEW_KEY) : items[0][0]));
  const go = (v) => { setView(v); write(VIEW_KEY, v); };
  // Sem acesso ao Dashboard Admin (ou retirado): volta ao primeiro ecrã.
  useEffect(() => { if (adminNivel === null && view === "admin") go(items[0][0]); });

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
  // No máximo uma vez a cada 2 segundos, e nunca com a janela escondida: aí fica para quando se voltar a ela.
  const bumpTimer = useRef();
  const bumpLast = useRef(0);
  const bumpPending = useRef(false);
  // Leads que mudaram desde a última atualização ("*" = não se sabe qual): a ficha aberta só volta a pedir
  // os dados quando a mudança é nela, em vez de a cada mudança em qualquer lead.
  const changedRef = useRef(new Set());
  const [changedLeads, setChangedLeads] = useState(() => new Set());
  const bump = useCallback((leadId) => {
    if (leadId !== undefined) changedRef.current.add(leadId || "*");
    if (document.visibilityState === "hidden") { bumpPending.current = true; return; }
    if (bumpTimer.current) return;
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null;
      bumpLast.current = Date.now();
      setChangedLeads(changedRef.current);
      changedRef.current = new Set();
      setVersion((v) => v + 1);
    }, Math.max(400, bumpLast.current + 2000 - Date.now()));
  }, []);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && bumpPending.current) { bumpPending.current = false; bump("*"); }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [bump]);
  const modalRef = useRef(null);
  modalRef.current = modal;
  // Lead nova vinda de uma entrada automática: aviso no ecrã (só a equipa OPERA as vê nas etapas de entrada).
  const refs = useRef({ stages: [], clients: [] });
  refs.current = { stages, clients };
  const chatTimer = useRef();
  // Negócio da OPERA fechado (lead do próprio cliente OPERA passa para Closed pela primeira vez): confetis, som de
  // dinheiro e aviso no canto, para toda a equipa OPERA que tenha o Leads aberto.
  const festaFecho = useCallback(async (e) => {
    if (!e || e.type !== "stage" || !e.to_stage_id) return;
    const st = refs.current.stages.find((s) => s.id === e.to_stage_id);
    // A etapa Closed só existe no cliente OPERA (etapa própria dele).
    if (!st || !st.client_id || st.name?.trim().toLowerCase() !== "closed") return;
    const [{ data: lead }, { count }, { data: who }] = await Promise.all([
      sb.from("leads").select("id, name, client_id").eq("id", e.lead_id).maybeSingle(),
      sb.from("lead_events").select("id", { count: "exact", head: true }).eq("lead_id", e.lead_id).eq("type", "stage").eq("to_stage_id", e.to_stage_id),
      e.author_id ? sb.from("profiles").select("full_name").eq("id", e.author_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    if (!lead || lead.client_id !== st.client_id || (count ?? 0) > 1) return;
    const by = who?.full_name ? who.full_name.trim().split(/\s+/)[0] : "";
    setAlerts((a) => (a.some((x) => x.id === `fecho-${lead.id}`) ? a : [...a, { id: `fecho-${lead.id}`, kind: "fecho", lead: lead.id, name: lead.name, by }]));
  }, []);
  const onChange = useCallback((table, payload) => {
    // Mensagens das conversas: só a conversa e os números por ler voltam a pedir os dados.
    if (table === "client_messages" || table === "client_message_reads" || table === "*") {
      clearTimeout(chatTimer.current);
      chatTimer.current = setTimeout(() => setChatVersion((v) => v + 1), 250);
      if (table !== "*") return;
    }
    // Nota ou registo novo no histórico: só interessa à ficha dessa lead, se estiver aberta, e às notas afixadas
    // (que aparecem no quadro). Mudanças de etapa e chamadas também mexem na lead, e isso já chega por "leads".
    if (opera && table === "lead_events" && payload?.eventType === "INSERT") festaFecho(payload.new);
    if (table === "lead_events" && payload?.eventType === "INSERT" && !payload.new?.pinned
        && !(modalRef.current?.kind === "lead" && modalRef.current.id === payload.new?.lead_id)) return;
    const row = payload?.new && Object.keys(payload.new).length ? payload.new : payload?.old;
    bump((table === "leads" ? row?.id : row?.lead_id) || "*");
    if (!opera || table !== "leads" || !["INSERT", "UPDATE"].includes(payload?.eventType)) return;
    const l = payload.new;
    // Lead nova, ou lead que já existia e acabou de fazer um novo pedido (new_at acabado de acender).
    if (!isAutoNewLead(l) || (payload.eventType === "UPDATE" && Date.now() - Date.parse(l.new_at) > 120000)) return;
    const client = refs.current.clients.find((c) => c.id === l.client_id)?.name ?? "";
    setAlerts((a) => (a.some((x) => x.id === l.id) ? a : [...a, { id: l.id, name: l.name, client, source: l.source }]));
  }, [bump, opera, festaFecho]);
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
    countNewLeads().then(setNewCount).catch(() => {});
  }, [opera, stages, version]);

  // Número no menu "Hoje": tarefas até ao fim do dia. Pede a lista toda, por isso no máximo uma vez por minuto
  // (antes era a cada mudança em qualquer lead, o que deixava tudo mais lento).
  const dueTimer = useRef(null);
  const dueLast = useRef(0);
  useEffect(() => {
    if (!opera || dueTimer.current) return;
    dueTimer.current = setTimeout(() => {
      dueTimer.current = null;
      dueLast.current = Date.now();
      today(null, null).then((r) => {
        const end = new Date(); end.setHours(23, 59, 59, 999);
        const n = r.filter((t) => new Date(t.due_at) <= end).length;
        setDueToday(r.length >= 500 && n === r.length ? "500+" : n);
      }).catch(() => {});
    }, Math.max(0, dueLast.current + 60000 - Date.now()));
  }, [opera, version]);
  useEffect(() => () => clearTimeout(dueTimer.current), []);

  const ctx = useMemo(() => ({
    me: profile.id, opera, myClient, stages, labels, clients, version, changedLeads, filterClient, setFilterClient,
    defaultClient: filterClient,
    onChanged: () => { bump(); },
    onRefsChanged: () => { loadRefs(); bump(); },
    onOpenLead: (id) => setModal({ kind: "lead", id }),
    onGo: (v) => go(v),
    onNewLead: () => setModal({ kind: "newLead" }),
    onNewStage: () => setModal({ kind: "newStage" }),
    onOpenLabels: () => setModal((m) => ({ kind: "labels", back: m?.kind === "lead" ? m.id : null })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [profile.id, opera, myClient, stages, labels, clients, version, changedLeads, filterClient, bump, loadRefs]);

  // Links dos emails e das notificações: ?lead=<id> abre logo a ficha e ?conversa=<cliente> a conversa (depois do login).
  const openFromLink = (search) => {
    const params = new URLSearchParams(search);
    // Regresso do Millennium (Enable Banking): guarda o código para o separador Banco do Dashboard Admin concluir a ligação.
    const st = params.get("state") || "";
    if (opera && st.startsWith("opera-banco-")) {
      try {
        sessionStorage.setItem("opera-banco-retorno", JSON.stringify(params.get("code") ? { code: params.get("code"), state: st } : { erro: true }));
        localStorage.setItem("opera-admin-separador", "banco");
      } catch { /* sem armazenamento */ }
      go("admin");
      return;
    }
    const id = params.get("lead");
    const chat = params.get("conversa");
    if (id && /^[0-9a-f-]{36}$/i.test(id)) setModal({ kind: "lead", id });
    else if (chat && /^[0-9a-f-]{36}$/i.test(chat)) openChat(chat);
  };
  const openRef = useRef(openFromLink);
  openRef.current = openFromLink;
  useEffect(() => {
    if (window.location.search) {
      openFromLink(window.location.search);
      window.history.replaceState(null, "", window.location.pathname);
    }
    // Tocar numa notificação com a app já aberta: o service worker pede para abrir a lead ou a conversa.
    const onMessage = (e) => { if (e.data?.type === "abrir") openRef.current(new URL(e.data.url).search); };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
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
          <AppSetup />
          <button type="button" onClick={() => forgetDevice().finally(() => sb.auth.signOut())}>Terminar sessão</button>
        </div>
      </nav>
      <main>
        <Suspense fallback={<div className="sub" style={{ padding: 24 }}>A carregar…</div>}>
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
        {view === "admin" && adminNivel && <AdminDashboard nivel={adminNivel} onOpenLead={ctx.onOpenLead} />}
        </Suspense>
      </main>

      <NewLeadAlerts alerts={alerts} onClose={closeAlert}
        onOpen={(id) => { setAlerts((a) => a.filter((x) => x.id !== id && x.lead !== id)); setModal({ kind: "lead", id }); }} />
      {modal?.kind === "lead" && <LeadModal key={modal.id} id={modal.id} ctx={ctx} onClose={closeModal} />}
      {modal?.kind === "newLead" && <NewLeadModal ctx={ctx} onClose={closeModal} />}
      {modal?.kind === "newStage" && <StageModal ctx={refCtx} onClose={closeModal} />}
      {modal?.kind === "labels" && (
        <LabelsModal ctx={refCtx} onClose={() => (modal.back ? setModal({ kind: "lead", id: modal.back }) : closeModal())} />
      )}
    </div>
  );
}
