import { useCallback, useEffect, useRef, useState } from "react";
import {
  EDIT_WINDOW_MS, attachableLeads, conversation, deleteMessage, editMessage, markConversationRead, sendMessage,
} from "../lib/leadsApi.js";
import { QUALIFIED_POSITION, fmtWhen, initials } from "../lib/format.js";
import { useAction } from "../ui/feedback.jsx";

const MAX = 4000;
const PAGE_SIZE = 50;

// Conversas entre a OPERA e cada cliente. A equipa OPERA vê a lista dos clientes e abre uma conversa de cada vez
// (no telemóvel, a lista ou a conversa); o cliente vê só a sua conversa com a OPERA.
export default function Conversas({ ctx, list, selected, onSelect, chatVersion, onRead }) {
  const { opera, myClient } = ctx;
  if (!opera) {
    return (
      <>
        <div className="top"><div><h1>Conversa com a OPERA</h1>
          <div className="sub">Fala aqui com a equipa OPERA sobre as vossas leads. Também recebem um email quando há mensagens por ler.</div></div></div>
        <Thread key={myClient.id} ctx={ctx} clientId={myClient.id} chatVersion={chatVersion} onRead={onRead} />
      </>
    );
  }
  const current = list.find((c) => c.client_id === selected) || null;
  return (
    <>
      <div className="top"><div><h1>Conversas</h1>
        <div className="sub">Uma conversa com cada cliente. O cliente recebe um email se não ler em 15 minutos.</div></div></div>
      <div className={`chat ${current ? "has-sel" : ""}`}>
        <div className="chatList" role="list" aria-label="Clientes">
          {!list.length && <div className="empty">Ainda não há clientes ativos.</div>}
          {list.map((c) => (
            <button key={c.client_id} type="button" role="listitem" className={c.client_id === selected ? "on" : ""}
              aria-current={c.client_id === selected ? "true" : undefined} onClick={() => onSelect(c.client_id)}>
              <span className="dot" style={{ background: c.client_color }}></span>
              <span className="cl">
                <b>{c.client_name}</b>
                <small>{c.last_at ? `${c.last_author ? `${c.last_author}: ` : ""}${c.last_body}` : "Sem mensagens"}</small>
              </span>
              <span className="cr">
                {c.last_at && <small>{fmtWhen(c.last_at)}</small>}
                {c.unread > 0 && <span className="ubadge" aria-label={`${c.unread} por ler`}>{c.unread}</span>}
              </span>
            </button>
          ))}
        </div>
        {current ? (
          <Thread key={current.client_id} ctx={ctx} clientId={current.client_id} title={current.client_name}
            chatVersion={chatVersion} onRead={onRead} onBack={() => onSelect(null)} />
        ) : (
          <div className="thread empty-thread"><div className="empty">Escolhe um cliente para ver a conversa.</div></div>
        )}
      </div>
    </>
  );
}

function Thread({ ctx, clientId, title, chatVersion, onRead, onBack }) {
  const { me, opera, stages } = ctx;
  const [msgs, setMsgs] = useState(null);
  const [more, setMore] = useState(false);
  const [text, setText] = useState("");
  const [lead, setLead] = useState(null);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(null);
  const [, setTick] = useState(0);
  const [run, busy] = useAction();
  const box = useRef();
  const atBottom = useRef(true);
  const lastRead = useRef(null);
  const count = useRef(PAGE_SIZE);

  // O botão Mudar desaparece sozinho aos 15 minutos.
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  const load = useCallback(async () => {
    const r = await conversation(clientId, null, Math.min(Math.max(count.current, PAGE_SIZE), 200));
    setMsgs(r);
    setMore(r.length >= count.current);
    // Marca como lido só quando chega uma mensagem nova de outra pessoa (evita voltar a marcar a cada atualização).
    const last = r.filter((m) => m.author_id !== me).at(-1);
    if (last && document.visibilityState === "visible" && (!lastRead.current || last.created_at > lastRead.current)) {
      lastRead.current = last.created_at;
      await markConversationRead(clientId).catch(() => {});
      onRead?.();
    }
  }, [clientId, me, onRead]);
  useEffect(() => { run(load); }, [load, chatVersion, run]);
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && load().catch(() => {});
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  // Desce para a última mensagem quando chegam novas, se já se estava no fim.
  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);
  const onScroll = () => {
    const el = box.current;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const older = async () => {
    const el = box.current;
    const h = el?.scrollHeight ?? 0;
    const r = await run(() => conversation(clientId, msgs[0].created_at, PAGE_SIZE));
    if (!r) return;
    count.current += r.length;
    setMore(r.length >= PAGE_SIZE);
    atBottom.current = false;
    setMsgs((m) => [...r, ...m]);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - h; });
  };

  const send = async (e) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    const ok = await run(() => sendMessage(clientId, body, lead?.id ?? null));
    if (!ok) return;
    setText(""); setLead(null); setPicking(false);
    atBottom.current = true;
    count.current += 1;
    await load().catch(() => {});
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const saveEdit = async () => {
    if (await run(() => editMessage(editing.id, editing.body), "Mensagem mudada")) { setEditing(null); await load().catch(() => {}); }
  };
  const remove = async (m) => {
    if (!window.confirm("Apagar esta mensagem? Fica a indicação de que foi apagada.")) return;
    if (await run(() => deleteMessage(m.id), "Mensagem apagada")) await load().catch(() => {});
  };

  const canChange = (m) => m.author_id === me && !m.deleted_at && Date.now() - new Date(m.created_at) < EDIT_WINDOW_MS;
  const who = (m) => (m.side === "opera" ? (opera ? m.author_name : `${m.author_name} · OPERA`) : m.author_name);

  return (
    <section className="thread" aria-label={title ? `Conversa com ${title}` : "Conversa com a OPERA"}>
      {opera && (
        <header className="th">
          {onBack && <button type="button" className="btn sm back" onClick={onBack}>Voltar</button>}
          <b>{title}</b>
        </header>
      )}
      <div className="msgs" ref={box} onScroll={onScroll} aria-live="polite">
        {more && <button type="button" className="link older" disabled={busy} onClick={older}>Ver mensagens anteriores</button>}
        {msgs && !msgs.length && (
          <div className="empty">{opera ? "Ainda não há mensagens. Escreve a primeira." : "Ainda não há mensagens. Escreve à equipa OPERA quando precisares."}</div>
        )}
        {(msgs || []).map((m) => {
          const mine = m.author_id === me;
          return (
            <div key={m.id} className={`msg ${mine ? "mine" : ""} ${m.side === "opera" ? "op" : ""} ${m.deleted_at ? "del" : ""}`}>
              <div className="mm">
                {!mine && <span className="av sm" aria-hidden="true">{initials(m.author_name)}</span>}
                <b>{mine ? "Eu" : who(m)}</b><span>{fmtWhen(m.created_at)}</span>
                {m.edited_at && !m.deleted_at && <span>· editada</span>}
              </div>
              {editing?.id === m.id ? (
                <div className="medit">
                  <textarea value={editing.body} maxLength={MAX} aria-label="Mudar a mensagem" autoFocus
                    onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                  <div className="row">
                    <button type="button" className="btn sm primary" disabled={busy || !editing.body.trim()} onClick={saveEdit}>Guardar</button>
                    <button type="button" className="btn sm" onClick={() => setEditing(null)}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <p>{m.deleted_at ? "Mensagem apagada" : m.body}</p>
              )}
              {m.lead_id && !m.deleted_at && (
                <button type="button" className="mlead" onClick={() => ctx.onOpenLead(m.lead_id)}>
                  <b>{m.lead_name}</b><small>{m.lead_stage}</small>
                </button>
              )}
              {canChange(m) && editing?.id !== m.id && (
                <div className="mtools">
                  <button type="button" className="link" onClick={() => setEditing({ id: m.id, body: m.body })}>Mudar</button>
                  <button type="button" className="link" onClick={() => remove(m)}>Apagar</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <form className="composer" onSubmit={send}>
        {picking && <LeadPicker clientId={clientId} stages={stages} onPick={(l) => { setLead(l); setPicking(false); }} onClose={() => setPicking(false)} />}
        {lead && (
          <div className="chips"><span className="chip">Lead: <b>{lead.name}</b></span>
            <button type="button" className="link" onClick={() => setLead(null)}>Tirar a lead</button></div>
        )}
        <label className="vh" htmlFor={`msg-${clientId}`}>Mensagem</label>
        <textarea id={`msg-${clientId}`} value={text} maxLength={MAX} rows={2} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder={opera ? "Escreve ao cliente…" : "Escreve à equipa OPERA…"} />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button type="button" className="btn sm" onClick={() => setPicking((x) => !x)} aria-expanded={picking}>Juntar lead</button>
          <span className="row">
            {text.length > MAX - 200 && <small className="sub" style={{ margin: 0 }}>{text.length} / {MAX}</small>}
            <button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>Enviar</button>
          </span>
        </div>
      </form>
    </section>
  );
}

// Escolher uma lead do cliente (a partir de Lead Qualificada) para juntar à mensagem.
function LeadPicker({ clientId, stages, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [run] = useAction();
  const ids = stages.filter((s) => s.position >= QUALIFIED_POSITION).map((s) => s.id);
  const stageName = Object.fromEntries(stages.map((s) => [s.id, s.name]));
  const key = ids.join(",");
  useEffect(() => {
    const t = setTimeout(() => run(() => attachableLeads(clientId, key.split(","), q)).then((r) => r && setRows(r)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [clientId, key, q, run]);
  return (
    <div className="picker">
      <div className="row">
        <label className="search" style={{ flex: 1 }}><span className="vh">Procurar lead</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar lead pelo nome"
            onKeyDown={(e) => e.key === "Escape" && onClose()} /></label>
        <button type="button" className="btn sm" onClick={onClose}>Fechar</button>
      </div>
      <div className="plist">
        {rows && !rows.length && <div className="empty">Sem leads a partir de Lead Qualificada{q ? " com esse nome" : ""}.</div>}
        {(rows || []).map((l) => (
          <button key={l.id} type="button" onClick={() => onPick(l)}><b>{l.name}</b><small>{stageName[l.stage_id]}</small></button>
        ))}
      </div>
    </div>
  );
}
