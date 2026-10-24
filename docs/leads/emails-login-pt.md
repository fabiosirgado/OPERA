# Emails de login (Supabase Auth, produção) em português

Remetente: **OPERA &lt;crm@opera-os.com&gt;** (SMTP do Resend). Servem o CRM e o OPERA Leads.
Sem hífenes no texto visível. O HTML é simples, para abrir bem em qualquer programa de email.

---

## 1. Convidar utilizador (Invite user)
**Assunto:** Convite para a OPERA

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<p style="margin:0 0 16px;font-size:13px;color:#64748b"><b style="color:#0f172a">OPERA</b></p>
<h2 style="margin:0 0 12px;font-size:20px">Foi convidado para a OPERA</h2>
<p style="margin:0 0 16px;color:#334155">Carregue no botão para aceitar o convite e definir a sua palavra passe.</p>
<p style="margin:24px 0"><a href="{{ .ConfirmationURL }}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Aceitar o convite</a></p>
<p style="color:#64748b;font-size:13px">Se não estava à espera deste convite, pode ignorar este email.</p>
</div>
```

## 2. Link de entrada (Magic link or OTP)
**Assunto:** O seu link de entrada na OPERA

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<p style="margin:0 0 16px;font-size:13px;color:#64748b"><b style="color:#0f172a">OPERA</b></p>
<h2 style="margin:0 0 12px;font-size:20px">Entrar na OPERA</h2>
<p style="margin:0 0 16px;color:#334155">Carregue no botão para entrar. O link só funciona uma vez e expira em pouco tempo.</p>
<p style="margin:24px 0"><a href="{{ .ConfirmationURL }}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Entrar</a></p>
<p style="color:#64748b;font-size:13px">Também pode usar este código: <b>{{ .Token }}</b></p>
<p style="color:#64748b;font-size:13px">Se não pediu para entrar, pode ignorar este email.</p>
</div>
```

## 3. Recuperar a palavra passe (Reset password)
**Assunto:** Definir uma nova palavra passe

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<p style="margin:0 0 16px;font-size:13px;color:#64748b"><b style="color:#0f172a">OPERA</b></p>
<h2 style="margin:0 0 12px;font-size:20px">Nova palavra passe</h2>
<p style="margin:0 0 16px;color:#334155">Recebemos um pedido para mudar a palavra passe desta conta. Carregue no botão para definir uma nova.</p>
<p style="margin:24px 0"><a href="{{ .ConfirmationURL }}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Definir palavra passe</a></p>
<p style="color:#64748b;font-size:13px">Se não fez este pedido, ignore este email: a palavra passe atual continua válida.</p>
</div>
```

## 4. Confirmar o registo (Confirm sign up)
**Assunto:** Confirme o seu email

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<p style="margin:0 0 16px;font-size:13px;color:#64748b"><b style="color:#0f172a">OPERA</b></p>
<h2 style="margin:0 0 12px;font-size:20px">Confirme o seu email</h2>
<p style="margin:0 0 16px;color:#334155">Carregue no botão para confirmar o seu email e entrar na OPERA.</p>
<p style="margin:24px 0"><a href="{{ .ConfirmationURL }}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Confirmar email</a></p>
<p style="color:#64748b;font-size:13px">Se não criou esta conta, pode ignorar este email.</p>
</div>
```

## 5. Mudar o email (Change email address)
**Assunto:** Confirme o seu novo email

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<p style="margin:0 0 16px;font-size:13px;color:#64748b"><b style="color:#0f172a">OPERA</b></p>
<h2 style="margin:0 0 12px;font-size:20px">Confirme o novo email</h2>
<p style="margin:0 0 16px;color:#334155">Pediu para mudar o email da sua conta de {{ .Email }} para {{ .NewEmail }}. Carregue no botão para confirmar.</p>
<p style="margin:24px 0"><a href="{{ .ConfirmationURL }}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Confirmar o novo email</a></p>
<p style="color:#64748b;font-size:13px">Se não fez este pedido, ignore este email e avise a OPERA.</p>
</div>
```

## 6. Confirmar a identidade (Reauthentication)
**Assunto:** O seu código de confirmação

```html
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<p style="margin:0 0 16px;font-size:13px;color:#64748b"><b style="color:#0f172a">OPERA</b></p>
<h2 style="margin:0 0 12px;font-size:20px">Código de confirmação</h2>
<p style="margin:0 0 16px;color:#334155">Use este código para confirmar que é você:</p>
<p style="margin:16px 0;font-size:24px;letter-spacing:4px"><b>{{ .Token }}</b></p>
<p style="color:#64748b;font-size:13px">Se não pediu este código, pode ignorar este email.</p>
</div>
```
