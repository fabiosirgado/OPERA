import { useState } from "react";
import { sb } from "./supabase.js";
import { ROLE_LABEL, initials } from "./lib/format.js";
import Clientes from "./screens/Clientes.jsx";
import Equipa from "./screens/Equipa.jsx";
import Privacidade from "./screens/Privacidade.jsx";

const VIEW_KEY = "opera-leads-vista";
const readView = () => { try { return localStorage.getItem(VIEW_KEY) || ""; } catch { return ""; } };
const saveView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* sem armazenamento */ } };

// Menu lateral e ecrã escolhido, como no protótipo. Os ecrãs das leads chegam na Fase 2.
export default function Shell({ access }) {
  const { profile, client, opera } = access;
  const role = profile.leads_role;
  const items = opera
    ? [["pipeline", "Pipeline geral"], ["clientes", "Clientes e acessos"], ...(role === "admin" ? [["privacidade", "Privacidade e RGPD"]] : [])]
    : [["pipeline", "As vossas leads"], ...(role === "cliente_admin" ? [["equipa", "A minha equipa"]] : [])];
  const [view, setView] = useState(() => (items.some(([k]) => k === readView()) ? readView() : items[0][0]));
  const go = (v) => { setView(v); saveView(v); };

  return (
    <div className="app">
      <nav className="side" aria-label="Menu principal">
        <div className="brand"><b>OPERA</b><span>Leads</span></div>
        <div className="nav">
          {items.map(([k, label]) => (
            <button key={k} type="button" className={view === k ? "on" : ""} aria-current={view === k ? "page" : undefined}
              onClick={() => go(k)}>{label}</button>
          ))}
        </div>
        <div className="ubox">
          <div className="who">
            <span className="av">{initials(profile.full_name || profile.email)}</span>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <b style={{ fontSize: 13 }}>{profile.full_name || profile.email}</b>
              <small>{ROLE_LABEL[role]}{client ? ` · ${client.name}` : ""}</small>
            </div>
          </div>
          <button type="button" onClick={() => sb.auth.signOut()}>Terminar sessão</button>
        </div>
      </nav>
      <main>
        {view === "clientes" && <Clientes profile={profile} />}
        {view === "equipa" && <Equipa profile={profile} client={client} />}
        {view === "privacidade" && <Privacidade />}
        {view === "pipeline" && (
          <>
            <div className="top"><div><h1>{opera ? "Pipeline geral" : "As vossas leads"}</h1></div></div>
            <div className="banner blue">O pipeline, a ficha da lead e a lista Hoje chegam na próxima fase.</div>
          </>
        )}
      </main>
    </div>
  );
}
