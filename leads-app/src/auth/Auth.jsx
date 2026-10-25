import { useCallback, useEffect, useState } from "react";
import { sb, ARRIVED_ERROR, ARRIVED_VIA } from "../supabase.js";
import { acceptInvite, appUrl, getClient, getMyProfile, logLogin } from "../lib/api.js";
import { OPERA_ROLES } from "../lib/format.js";

// Sessões expiram sem atividade: 12 horas para a equipa OPERA, 30 dias para os clientes.
const IDLE_LIMIT = { opera: 12 * 3600e3, cliente: 30 * 24 * 3600e3 };
const LAST_ACTIVE_KEY = "opera-leads-ultima-atividade";
const readLastActive = () => { try { return Number(localStorage.getItem(LAST_ACTIVE_KEY)) || 0; } catch { return 0; } };
const touch = () => { try { localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now())); } catch { /* sem armazenamento */ } };

// Estado do acesso: decide que ecrã mostrar antes da aplicação.
//   loading | signedOut | setPassword | mfaEnroll | mfaCode | noAccess | ready
export function useAccess() {
  const [state, setState] = useState({ step: "loading" });
  const [recovery, setRecovery] = useState(ARRIVED_VIA === "recovery");

  const evaluate = useCallback(async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return setState({ step: "signedOut", message: ARRIVED_ERROR || undefined });

    const profile = await getMyProfile(session.user.id);
    if (!profile?.leads_role) return setState({ step: "noAccess", message: "Esta conta não tem acesso ao OPERA Leads." });
    if (profile.leads_status === "desativado") return setState({ step: "noAccess", message: "Este acesso está desativado. Fala com a OPERA." });

    const opera = OPERA_ROLES.includes(profile.leads_role);
    let client = null;
    if (!opera) {
      client = profile.client_id ? await getClient(profile.client_id) : null;
      if (!client?.leads_enabled || client.leads_status !== "ativo") {
        return setState({ step: "noAccess", message: "O acesso deste cliente está desativado. Fala com a OPERA." });
      }
    }

    // Sessão parada há demasiado tempo: termina e volta ao login.
    const last = readLastActive();
    if (last && Date.now() - last > IDLE_LIMIT[opera ? "opera" : "cliente"]) {
      await sb.auth.signOut();
      return setState({ step: "signedOut", message: "A sessão terminou por inatividade. Entra outra vez." });
    }

    if (recovery || profile.leads_status === "convidado") return setState({ step: "setPassword", profile, invited: profile.leads_status === "convidado" });

    if (opera) {
      // Sessão guardada que já não é válida (por exemplo, expirou noutro separador): volta ao login.
      const expired = async () => {
        await sb.auth.signOut().catch(() => {});
        setState({ step: "signedOut", message: "A sessão expirou. Entra outra vez." });
      };
      const { data: aal, error: aalError } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalError || !aal) return expired();
      if (aal.currentLevel !== "aal2") {
        const { data: f, error: fError } = await sb.auth.mfa.listFactors();
        if (fError || !f) return expired();
        const factor = f.totp.find((x) => x.status === "verified");
        return setState(factor ? { step: "mfaCode", factorId: factor.id } : { step: "mfaEnroll" });
      }
    }

    touch();
    const key = `opera-leads-login-${session.access_token.slice(-16)}`;
    try {
      if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, "1"); logLogin().catch(() => {}); }
    } catch { logLogin().catch(() => {}); }
    setState({ step: "ready", profile, client, opera });
  }, [recovery]);

  useEffect(() => {
    evaluate().catch((e) => setState({ step: "noAccess", message: e.message }));
    const { data: sub } = sb.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") setState({ step: "signedOut" });
    });
    // Atividade do utilizador mantém a sessão viva.
    let t = 0;
    const onActivity = () => { if (Date.now() - t > 60e3) { t = Date.now(); touch(); } };
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [evaluate]);

  const refresh = useCallback(() => evaluate().catch((e) => setState({ step: "noAccess", message: e.message })), [evaluate]);
  const passwordDone = useCallback(() => { setRecovery(false); }, []);
  return { state, refresh, passwordDone };
}

function Card({ title, children }) {
  return (
    <div className="login">
      <div className="lcard">
        <div className="brand" style={{ padding: 0 }}><b style={{ fontSize: 22 }}>OPERA</b><span>Leads</span></div>
        {title && <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>}
        {children}
      </div>
    </div>
  );
}

const Banner = ({ msg }) => msg ? <div className={`banner ${msg.ok ? "green" : "orange"}`} style={{ padding: "10px 14px" }}>{msg.text}</div> : null;

export function LoginScreen({ initialMessage, onDone }) {
  const [msg, setMsg] = useState(initialMessage ? { text: initialMessage } : null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: e.target.elements.pw.value });
    setBusy(false);
    if (error) return setMsg({ text: "Email ou palavra passe incorretos." });
    onDone();
  };
  const needEmail = () => { setMsg({ text: "Escreve primeiro o teu email." }); document.getElementById("lg-email")?.focus(); };
  const magic = async () => {
    if (!email.trim()) return needEmail();
    setBusy(true);
    // Sem criar contas: só quem foi convidado recebe o link.
    await sb.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: appUrl() } });
    setBusy(false);
    setMsg({ ok: true, text: "Se este email tiver acesso, vais receber um link para entrar." });
  };
  const forgot = async () => {
    if (!email.trim()) return needEmail();
    setBusy(true);
    await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: appUrl() });
    setBusy(false);
    setMsg({ ok: true, text: "Se este email tiver acesso, vais receber um link para definir uma nova palavra passe." });
  };

  return (
    <Card title="Entrar">
      <Banner msg={msg} />
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label className="f">Email<input id="lg-email" name="email" type="email" autoComplete="username" required autoFocus
          value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="f">Palavra passe<input name="pw" type="password" autoComplete="current-password" required /></label>
        <button type="submit" className="btn primary" style={{ justifyContent: "center" }} disabled={busy}>Entrar</button>
      </form>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button type="button" className="link" onClick={magic} disabled={busy}>Receber link de acesso por email</button>
        <button type="button" className="link" onClick={forgot} disabled={busy}>Esqueci a palavra passe</button>
      </div>
      <span className="sub" style={{ margin: 0, fontSize: 12 }}>Não há registo público. As contas são criadas por convite da OPERA.</span>
    </Card>
  );
}

export function SetPasswordScreen({ invited, onDone }) {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const pw = e.target.elements.pw.value;
    if (pw.length < 10) return setMsg({ text: "A palavra passe tem de ter pelo menos 10 caracteres." });
    if (pw !== e.target.elements.pw2.value) return setMsg({ text: "As duas palavras passe não são iguais." });
    setBusy(true);
    const { error } = await sb.auth.updateUser({ password: pw });
    if (!error && invited) await acceptInvite().catch(() => {});
    setBusy(false);
    if (error) return setMsg({ text: error.message.includes("weak") || error.message.includes("pwned")
      ? "Essa palavra passe não é segura. Escolhe outra." : "Não foi possível guardar a palavra passe." });
    try { history.replaceState(null, "", window.location.pathname); } catch { /* sem histórico */ }
    onDone();
  };
  return (
    <Card title={invited ? "Bem vindo ao OPERA Leads" : "Nova palavra passe"}>
      <span className="sub" style={{ margin: 0 }}>{invited ? "Para terminar, define a tua palavra passe." : "Escolhe a nova palavra passe."}</span>
      <Banner msg={msg} />
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label className="f">Palavra passe<input name="pw" type="password" autoComplete="new-password" required minLength={10} autoFocus /></label>
        <label className="f">Repetir a palavra passe<input name="pw2" type="password" autoComplete="new-password" required /></label>
        <button type="submit" className="btn primary" style={{ justifyContent: "center" }} disabled={busy}>Guardar e entrar</button>
      </form>
    </Card>
  );
}

const MFA_INTRO = "As contas da equipa OPERA têm acesso às leads de todos os clientes, por isso a entrada exige verificação em dois passos.";

export function MfaCodeScreen({ factorId, onDone }) {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: e.target.elements.code.value.trim() });
    setBusy(false);
    if (error) return setMsg({ text: "Código inválido. Confirma na aplicação de autenticação e tenta outra vez." });
    onDone();
  };
  return (
    <Card title="Verificação em dois passos">
      <span className="sub" style={{ margin: 0 }}>{MFA_INTRO} Introduz o código de 6 dígitos da tua aplicação de autenticação.</span>
      <Banner msg={msg} />
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label className="f">Código<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required
          autoComplete="one-time-code" placeholder="123456" autoFocus /></label>
        <button type="submit" className="btn primary" style={{ justifyContent: "center" }} disabled={busy}>Confirmar</button>
      </form>
      <button type="button" className="link" onClick={() => sb.auth.signOut()}>Voltar</button>
    </Card>
  );
}

export function MfaEnrollScreen({ onDone }) {
  const [enroll, setEnroll] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      // Limpa tentativas anteriores que ficaram por confirmar.
      const { data: f } = await sb.auth.mfa.listFactors();
      for (const x of f.all.filter((x) => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: x.id });
      const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "OPERA Leads", issuer: "OPERA Leads" });
      if (error) setMsg({ text: "Não foi possível preparar a verificação em dois passos." });
      else setEnroll(data);
    })();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enroll.id, code: e.target.elements.code.value.trim() });
    setBusy(false);
    if (error) return setMsg({ text: "Código inválido. Confirma na aplicação e tenta outra vez." });
    onDone();
  };

  return (
    <Card title="Ativar verificação em dois passos">
      <span className="sub" style={{ margin: 0 }}>{MFA_INTRO}</span>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6, color: "#334155" }}>
        <li>Instala uma aplicação de autenticação no telemóvel (Google Authenticator, Microsoft Authenticator ou 1Password).</li>
        <li>Lê o código QR com a aplicação, ou escreve a chave à mão.</li>
        <li>Escreve o código de 6 dígitos que a aplicação mostrar.</li>
      </ol>
      <Banner msg={msg} />
      {enroll && (
        <>
          <img src={enroll.totp.qr_code} alt="Código QR para a aplicação de autenticação" width={180} height={180}
            style={{ alignSelf: "center", background: "#fff" }} />
          <div className="kv" style={{ margin: 0 }}><span>Chave para escrever à mão</span>
            <b style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{enroll.totp.secret}</b></div>
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="f">Código<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required
              autoComplete="one-time-code" placeholder="123456" /></label>
            <button type="submit" className="btn primary" style={{ justifyContent: "center" }} disabled={busy}>Ativar e entrar</button>
          </form>
        </>
      )}
      <button type="button" className="link" onClick={() => sb.auth.signOut()}>Voltar</button>
    </Card>
  );
}

export function NoAccessScreen({ message }) {
  return (
    <Card title="Sem acesso">
      <div className="banner orange" style={{ padding: "10px 14px" }}>{message}</div>
      <button type="button" className="btn" style={{ justifyContent: "center" }} onClick={() => sb.auth.signOut()}>Terminar sessão</button>
    </Card>
  );
}
