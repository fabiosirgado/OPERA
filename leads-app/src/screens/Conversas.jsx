import { useCallback, useEffect, useRef, useState } from "react";
import {
  EDIT_WINDOW_MS, VOICE_MAX_SECONDS, attachableLeads, conversation, deleteMessage, editMessage, markConversationRead,
  sendMessage, uploadVoice, voiceUrl,
} from "../lib/leadsApi.js";
import { fmtWhen, initials } from "../lib/format.js";
import { useAction, useToast } from "../ui/feedback.jsx";

const MAX = 4000;
const PAGE_SIZE = 50;
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

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
  const [recording, setRecording] = useState(false);
  const [voice, setVoice] = useState(null);
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

  // Mensagem de voz gravada e ainda não enviada: o texto escrito vai como legenda.
  const dropVoice = () => setVoice((v) => { if (v) URL.revokeObjectURL(v.url); return null; });
  useEffect(() => () => dropVoice(), []);
  const send = async (e) => {
    e?.preventDefault();
    const body = text.trim();
    if ((!body && !voice) || busy || recording) return;
    const ok = await run(async () => {
      const audio = voice ? { path: await uploadVoice(clientId, voice.blob), seconds: voice.seconds } : null;
      return sendMessage(clientId, body, lead?.id ?? null, audio);
    });
    if (!ok) return;
    setText(""); setLead(null); setPicking(false); dropVoice();
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
            <div key={m.id} className={`msg ${mine ? "mine" : ""} ${m.side === "opera" ? "op" : ""} ${m.deleted_at ? "del" : ""} ${m.auto === "qualificada" && !m.deleted_at ? "qual" : ""}`}>
              {m.auto === "qualificada" && !m.deleted_at && <span className="mtag">✓ Lead qualificada</span>}
              <div className="mm">
                {!mine && <span className="av sm" aria-hidden="true">{initials(m.author_name)}</span>}
                <b>{mine ? "Eu" : who(m)}</b><span>{fmtWhen(m.created_at)}</span>
                {m.edited_at && !m.deleted_at && <span>· editada</span>}
              </div>
              {editing?.id === m.id ? (
                <div className="medit">
                  <textarea value={editing.body} maxLength={MAX} aria-label={editing.voice ? "Legenda da mensagem de voz" : "Mudar a mensagem"} autoFocus
                    onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                  <div className="row">
                    <button type="button" className="btn sm primary" disabled={busy || (!editing.body.trim() && !editing.voice)} onClick={saveEdit}>Guardar</button>
                    <button type="button" className="btn sm" onClick={() => setEditing(null)}>Cancelar</button>
                  </div>
                </div>
              ) : m.deleted_at ? (
                <p>Mensagem apagada</p>
              ) : (
                <>
                  {m.audio_path && <VoicePlayer path={m.audio_path} seconds={m.audio_seconds} />}
                  {m.body && <p>{m.body}</p>}
                </>
              )}
              {m.lead_id && !m.deleted_at && (m.lead_open ? (
                <button type="button" className="mlead" onClick={() => ctx.onOpenLead(m.lead_id)}>
                  <b>{m.lead_name}</b><small>{m.lead_stage}</small>
                </button>
              ) : (
                <div className="mlead off"><b>{m.lead_name}</b><small>{m.lead_stage}</small></div>
              ))}
              {canChange(m) && editing?.id !== m.id && (
                <div className="mtools">
                  <button type="button" className="link" onClick={() => setEditing({ id: m.id, body: m.body ?? "", voice: !!m.audio_path })}>{m.audio_path ? "Mudar legenda" : "Mudar"}</button>
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
        {recording && <VoiceRecorder onDone={(v) => { setRecording(false); setVoice(v); }} onCancel={() => setRecording(false)} />}
        {voice && (
          <div className="voiceDraft">
            <audio controls src={voice.url} aria-label="Ouvir a gravação antes de enviar" />
            <span className="sub" style={{ margin: 0 }}>{mmss(voice.seconds)}</span>
            <button type="button" className="link" onClick={dropVoice}>Descartar</button>
          </div>
        )}
        <label className="vh" htmlFor={`msg-${clientId}`}>{voice ? "Legenda (opcional)" : "Mensagem"}</label>
        <textarea id={`msg-${clientId}`} value={text} maxLength={MAX} rows={2} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder={voice ? "Legenda (opcional)…" : opera ? "Escreve ao cliente…" : "Escreve à equipa OPERA…"} />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="row">
            <button type="button" className="btn sm" onClick={() => setPicking((x) => !x)} aria-expanded={picking}>Juntar lead</button>
            {!voice && !recording && <button type="button" className="btn sm" onClick={() => setRecording(true)}>Gravar voz</button>}
          </span>
          <span className="row">
            {text.length > MAX - 200 && <small className="sub" style={{ margin: 0 }}>{text.length} / {MAX}</small>}
            <button type="submit" className="btn sm primary" disabled={busy || recording || (!text.trim() && !voice)}>Enviar</button>
          </span>
        </div>
      </form>
    </section>
  );
}

// Escolher uma lead do cliente, em qualquer etapa, para juntar à mensagem.
function LeadPicker({ clientId, stages, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [run] = useAction();
  const stageName = Object.fromEntries(stages.map((s) => [s.id, s.name]));
  useEffect(() => {
    const t = setTimeout(() => run(() => attachableLeads(clientId, q)).then((r) => r && setRows(r)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [clientId, q, run]);
  return (
    <div className="picker">
      <div className="row">
        <label className="search" style={{ flex: 1 }}><span className="vh">Procurar lead</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar lead pelo nome"
            onKeyDown={(e) => e.key === "Escape" && onClose()} /></label>
        <button type="button" className="btn sm" onClick={onClose}>Fechar</button>
      </div>
      <div className="plist">
        {rows && !rows.length && <div className="empty">{q ? "Sem leads com esse nome." : "Este cliente ainda não tem leads."}</div>}
        {(rows || []).map((l) => (
          <button key={l.id} type="button" onClick={() => onPick(l)}><b>{l.name}</b><small>{stageName[l.stage_id]}</small></button>
        ))}
      </div>
    </div>
  );
}

// Mensagem de voz na conversa: o link para ouvir é pedido ao abrir (dura uma hora).
function VoicePlayer({ path, seconds }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    voiceUrl(path).then((u) => alive && setUrl(u)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [path]);
  if (failed) return <p className="sub" style={{ margin: 0 }}>Não foi possível carregar a mensagem de voz.</p>;
  return (
    <div className="voice">
      {url ? <audio controls preload="metadata" src={url} aria-label={`Mensagem de voz, ${mmss(seconds)}`} /> : <span className="sub" style={{ margin: 0 }}>A carregar…</span>}
      <small>{mmss(seconds)}</small>
    </div>
  );
}

// Grava do microfone até 5 minutos. Começa logo ao abrir; Parar entrega a gravação para ouvir antes de enviar.
const VOICE_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
function VoiceRecorder({ onDone, onCancel }) {
  const toast = useToast();
  const [secs, setSecs] = useState(0);
  const rec = useRef(null);
  const cancelled = useRef(false);
  const started = useRef(0);

  useEffect(() => {
    let stream;
    let timer;
    let dead = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("sem suporte");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        if (dead) return;
        toast(e?.name === "NotAllowedError"
          ? "O browser não deu acesso ao microfone. Permite o microfone para este site e tenta outra vez."
          : "Este browser não consegue gravar voz.");
        onCancel();
        return;
      }
      if (dead || cancelled.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const mimeType = VOICE_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
      const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(timer);
        if (dead || cancelled.current) return;
        const seconds = Math.min(VOICE_MAX_SECONDS, Math.max(1, Math.round((Date.now() - started.current) / 1000)));
        const blob = new Blob(chunks, { type: (r.mimeType || mimeType || "audio/webm").split(";")[0] });
        onDone({ blob, seconds, url: URL.createObjectURL(blob) });
      };
      rec.current = r;
      started.current = Date.now();
      r.start(1000);
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - started.current) / 1000);
        setSecs(s);
        if (s >= VOICE_MAX_SECONDS && r.state === "recording") r.stop();
      }, 250);
    })();
    return () => {
      dead = true;
      clearInterval(timer);
      if (rec.current?.state === "recording") rec.current.stop();
      else stream?.getTracks().forEach((t) => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => { if (rec.current?.state === "recording") rec.current.stop(); };
  const cancel = () => { cancelled.current = true; stop(); onCancel(); };
  return (
    <div className="recording" role="status">
      <span className="recdot" aria-hidden="true"></span>
      <b>A gravar</b><span>{mmss(secs)} / {mmss(VOICE_MAX_SECONDS)}</span>
      <span className="row" style={{ marginLeft: "auto" }}>
        <button type="button" className="btn sm" onClick={cancel}>Cancelar</button>
        <button type="button" className="btn sm primary" onClick={stop} disabled={!rec.current && secs === 0}>Parar</button>
      </span>
    </div>
  );
}
