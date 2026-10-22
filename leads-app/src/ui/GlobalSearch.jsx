import { useEffect, useRef, useState } from "react";
import { search } from "../lib/leadsApi.js";
import { ClientTag } from "./bits.jsx";

// Pesquisa global no menu: nome, telefone, email, interesse, qualificação, notas e etiquetas.
// Atalhos: / e Ctrl+K (ou Cmd+K) para abrir; setas e Enter para escolher; Esc para fechar.
export default function GlobalSearch({ opera, onOpen }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState(null);
  const [sel, setSel] = useState(0);
  const input = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
      if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault(); input.current?.focus(); input.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return undefined; }
    const t = setTimeout(() => search(q.trim()).then((r) => { setHits(r); setSel(0); }).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);

  const open = (id) => { setQ(""); setHits(null); input.current?.blur(); onOpen(id); };
  const onKeyDown = (e) => {
    if (!hits?.length) { if (e.key === "Escape") { setQ(""); input.current?.blur(); } return; }
    const shown = hits.slice(0, 10);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") { e.preventDefault(); open(shown[sel].id); }
    else if (e.key === "Escape") { setQ(""); input.current?.blur(); }
  };
  const mark = (text) => {
    const t = text || "", i = t.toLowerCase().indexOf(q.trim().toLowerCase());
    if (i < 0 || !q.trim()) return t;
    return <>{t.slice(0, i)}<mark>{t.slice(i, i + q.trim().length)}</mark>{t.slice(i + q.trim().length)}</>;
  };

  return (
    <div className="gsearch" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHits(null)}>
      <label htmlFor="gq" className="vh">Procurar leads</label>
      <input ref={input} id="gq" type="search" placeholder="Procurar leads  ( / )" autoComplete="off" value={q}
        onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} aria-controls="gres" aria-expanded={!!hits} />
      <div id="gres" className={`gres ${hits ? "on" : ""}`} role="listbox" aria-label="Resultados da pesquisa">
        {hits?.length === 0 && <div className="hint">Nenhuma lead encontrada.</div>}
        {hits?.slice(0, 10).map((h, i) => (
          <button key={h.id} type="button" role="option" aria-selected={i === sel} className={`r ${i === sel ? "act" : ""}`}
            onMouseDown={(e) => e.preventDefault()} onClick={() => open(h.id)}>
            <span className="tags"><b>{mark(h.name)}</b>{opera && <ClientTag name={h.client_name} color={h.client_color} />}<span className="src">{h.stage_name}</span></span>
            <small>{h.phone}{h.phone ? " · " : ""}encontrado em {h.found_in}{h.snippet ? <>: {mark(h.snippet)}</> : null}</small>
          </button>
        ))}
        {hits?.length > 10 && <div className="hint">Mais resultados: escreve mais para afinar.</div>}
      </div>
    </div>
  );
}
