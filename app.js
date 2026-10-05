(() => {
  "use strict";

  const API = "/api";
  const STORAGE_KEY = "szh-mail-session-v1";
  const MAILBOX_TTL_MS = 60 * 60 * 1000; // UI session lifetime. Persisted across refreshes.
  const POLL_MS = 8000;

  const $ = (id) => document.getElementById(id);
  const els = {
    address: $("emailAddress"), copy: $("copyBtn"), newBox: $("newMailboxBtn"),
    countdown: $("countdown"), progress: $("progressBar"), expiryLabel: $("expiryLabel"),
    pollLabel: $("pollLabel"), refresh: $("refreshBtn"), discard: $("deleteBtn"),
    count: $("messageCount"), list: $("inboxList"), reader: $("reader"),
    toast: $("toast"), dot: $("connectionDot"), connection: $("connectionText")
  };

  let session = loadSession();
  let messages = [];
  const previewCache = new Map();
  const previewLoading = new Set();
  let selectedId = null;
  let pollTimer = null;
  let countdownTimer = null;
  let busy = false;
  let toastTimer = null;

  function loadSession() {
    return null;
  }

  function saveSession() {}

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      cache: "no-store"
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!response.ok) {
      const error = new Error(data?.error || data?.message || `Request failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function clearSession() {
    session = null;
  }

  async function createMailbox() {
    if (busy) return;
    setBusy(true);
    stopPolling();
    clearInterval(countdownTimer);
    setConnection("CREATING", false);
    els.address.textContent = "Creating mailbox...";
    els.pollLabel.textContent = "CONNECTING";
    els.list.innerHTML = `
      <div class="state-card">
        <div class="loader"></div>
        <strong>Creating your mailbox</strong>
        <span>Connecting to mail service...</span>
      </div>`;
    els.reader.innerHTML = `
      <div class="reader-empty">
        <div class="reader-mark">SZH</div>
        <strong>Waiting for mailbox</strong>
        <span>Your inbox will appear here when the mailbox is ready.</span>
      </div>`;

    try {
      const data = await api("/mailbox", { method: "POST" });
      if (!data?.mailbox?.address || !data.mailbox.expiresAt) {
        throw new Error("The server created a mailbox but returned an invalid session.");
      }
      session = data.mailbox;
      messages = [];
      previewCache.clear();
      previewLoading.clear();
      selectedId = null;
      renderMailbox();
      startCountdown();
      await refreshInbox();
      startPolling();
      setConnection("CONNECTED", true);
      els.pollLabel.textContent = "INBOX READY";
    } catch (err) {
      setConnection("OFFLINE", false);
      els.pollLabel.textContent = "CONNECTION FAILED";
      renderFatal(friendlyError(err));
    } finally {
      setBusy(false);
      renderMailbox();
    }
  }

  async function restoreOrCreate() {
    try {
      const data = await api("/mailbox");
      session = data.mailbox;
      renderMailbox();
      startCountdown();
      await refreshInbox();
      startPolling();
      setConnection("CONNECTED", true);
    } catch (err) {
      if (err.status === 404 || err.status === 401) {
        return createMailbox();
      }
      setConnection("OFFLINE", false);
      renderFatal(`Could not restore the mailbox. ${friendlyError(err)}`);
    }
  }

  function renderMailbox() {
    els.address.textContent = session?.address || "Creating mailbox…";
    els.copy.disabled = !session;
    els.refresh.disabled = !session;
    els.discard.disabled = !session;
    els.newBox.disabled = busy;
    els.expiryLabel.textContent = session ? `EXPIRES ${formatDate(session.expiresAt)}` : "Waiting for mailbox";
  }

  function startCountdown() {
    clearInterval(countdownTimer);
    const tick = () => {
      if (!session) return;
      const total = Math.max(1, session.expiresAt - session.createdAt);
      const remaining = Math.max(0, session.expiresAt - Date.now());
      els.countdown.textContent = formatDuration(remaining);
      els.progress.style.width = `${Math.max(0, Math.min(100, remaining / total * 100))}%`;
      els.expiryLabel.textContent = remaining > 0 ? `EXPIRES ${formatDate(session.expiresAt)}` : "MAILBOX EXPIRED";
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        stopPolling();
        setConnection("EXPIRED", false);
        els.pollLabel.textContent = "INBOX CLOSED";
        renderExpired();
      }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  async function refreshInbox() {
    if (!session || busy || Date.now() >= session.expiresAt) return;
    try {
      els.pollLabel.textContent = "SYNCING…";
      const data = await api("/messages");
      const incoming = Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data?.["hydra:member"])
          ? data["hydra:member"]
          : Array.isArray(data)
            ? data
            : [];
      messages = incoming
        .filter(Boolean)
        .sort((a, b) => (toTimestamp(b.createdAt || b.receivedAt || b.timestamp) || 0) - (toTimestamp(a.createdAt || a.receivedAt || a.timestamp) || 0));
      els.count.textContent = Number.isFinite(Number(data?.total)) ? Number(data.total) : messages.length;
      renderInbox();
      els.pollLabel.textContent = `UPDATED ${formatTime(new Date())}`;
      setConnection("CONNECTED", true);
    } catch (err) {
      els.pollLabel.textContent = "SYNC FAILED";
      if (err.status === 401 || err.status === 404) {
        setConnection("SESSION LOST", false);
        toast("Mailbox session is no longer valid.", true);
      } else {
        setConnection("DEGRADED", false);
      }
    }
  }

  function renderInbox() {
    if (!messages.length) {
      els.list.innerHTML = `
        <div class="state-card">
          <div class="reader-mark">0</div>
          <strong>No messages yet</strong>
          <span>This inbox checks for new mail automatically.</span>
        </div>`;
      return;
    }

    els.list.innerHTML = messages.map(msg => `
      <button class="message-row ${msg.seen ? "" : "unread"} ${selectedId === msg.id ? "active" : ""}" data-id="${escapeAttr(msg.id)}" type="button">
        <div class="message-meta">
          <span class="message-sender">${escapeHtml(formatPerson(msg.from, "Unknown sender"))}</span>
          <span>${escapeHtml(relativeTime(msg.createdAt || msg.receivedAt || msg.timestamp))}</span>
        </div>
        <div class="message-subject">${escapeHtml(msg.subject || "(no subject)")}</div>
        <div class="message-preview" data-preview-id="${escapeAttr(msg.id)}">${escapeHtml(previewCache.get(msg.id) || msg.intro || previewFallback(msg))}</div>
      </button>`).join("");

    els.list.querySelectorAll(".message-row").forEach(row => {
      row.addEventListener("click", () => openMessage(row.dataset.id));
    });

    enrichPreviews();
  }

  function previewFallback(msg) {
    if (Array.isArray(msg.verificationCodes) && msg.verificationCodes.length) {
      return `Verification code: ${msg.verificationCodes.join(", ")}`;
    }
    return "Loading preview…";
  }

  async function enrichPreviews() {
    const targets = messages.filter(msg => msg?.id && !previewCache.has(msg.id) && !previewLoading.has(msg.id)).slice(0, 10);
    if (!targets.length) return;
    targets.forEach(msg => previewLoading.add(msg.id));
    await Promise.all(targets.map(async msg => {
      try {
        const response = await api(`/message?id=${encodeURIComponent(msg.id)}`);
        const full = response?.message || response;
        const raw = full?.text || htmlToText(full?.html);
        const preview = makePreview(raw);
        if (preview) previewCache.set(msg.id, preview);
      } catch {}
      finally { previewLoading.delete(msg.id); }
    }));
    targets.forEach(msg => {
      const node = els.list.querySelector(`[data-preview-id="${cssEscape(msg.id)}"]`);
      if (node) node.textContent = previewCache.get(msg.id) || previewFallback(msg);
    });
  }

  function htmlToText(value) {
    if (!value) return "";
    const html = Array.isArray(value) ? value.join("\n") : String(value);
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body?.textContent || "";
  }

  function makePreview(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text ? (text.length > 150 ? `${text.slice(0, 147)}…` : text) : "No readable preview.";
  }

  function cssEscape(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
  }

  async function openMessage(id) {
    if (!session || !id) return;
    selectedId = id;
    renderInbox();
    els.reader.innerHTML = `<div class="reader-empty"><div class="loader"></div><strong>Opening message</strong><span>Fetching the full email…</span></div>`;

    try {
      const response = await api(`/message?id=${encodeURIComponent(id)}`);
      const msg = response?.message || response;
      if (!msg?.id) throw new Error("The server returned an invalid message.");
      await markSeen(id);
      const idx = messages.findIndex(m => m.id === id);
      if (idx >= 0) messages[idx] = {...messages[idx], seen: true};
      renderInbox();
      renderReader(msg);
    } catch (err) {
      els.reader.innerHTML = `<div class="reader-empty"><strong>Could not open message</strong><span>${escapeHtml(friendlyError(err))}</span></div>`;
    }
  }

  async function markSeen(id) {
    try {
      await api(`/message?id=${encodeURIComponent(id)}`, {method: "PATCH"});
    } catch {}
  }

  function renderReader(msg) {
    const html = Array.isArray(msg.html) ? msg.html.join("\n") : (msg.html || "");
    const hasHtml = Boolean(html.trim());
    const body = hasHtml
      ? `<iframe class="email-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Email content"></iframe>`
      : `<div class="text-fallback">${escapeHtml(msg.text || "This message has no readable body.")}</div>`;

    const attachments = (msg.attachments || []).map(a =>
      `<a class="attachment" href="${escapeAttr(a.downloadUrl || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.filename || "attachment")}</a>`
    ).join("");

    els.reader.innerHTML = `
      <div class="reader-content">
        <h2 class="reader-title">${escapeHtml(msg.subject || "(no subject)")}</h2>
        <div class="reader-details">
          <div class="reader-detail"><b>FROM</b><span>${escapeHtml(formatPerson(msg.from))}</span></div>
          <div class="reader-detail"><b>TO</b><span>${escapeHtml(formatRecipients(msg.to))}</span></div>
          <div class="reader-detail"><b>DATE</b><span>${escapeHtml(formatDate(msg.createdAt || msg.receivedAt || msg.timestamp, true))}</span></div>
        </div>
        ${body}
        ${attachments ? `<div class="attachments"><h3>ATTACHMENTS</h3>${attachments}</div>` : ""}
      </div>`;

    if (hasHtml) {
      const frame = els.reader.querySelector(".email-frame");
      if (!frame) throw new Error("The email reader could not create its content frame.");
      const safe = sanitizeHtml(html);
      const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
        html,body{margin:0;padding:0}body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1c211d;background:#fff;padding:24px;overflow-wrap:anywhere}
        img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}a{color:#1769aa}
      </style></head><body>${safe}</body></html>`;
      frame.srcdoc = documentHtml;
    }
  }

  function sanitizeHtml(input) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, "text/html");
    const blocked = "script,iframe,object,embed,form,base,meta,link,style,template,textarea,select,button";
    doc.querySelectorAll(blocked).forEach(el => el.remove());
    doc.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith("on") || name === "srcdoc" || name === "formaction") el.removeAttribute(attr.name);
        if ((name === "href" || name === "src" || name === "action") && /^(javascript|vbscript|data):/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      });
      if (el.tagName === "A") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    });
    return doc.body.innerHTML;
  }

  async function discardMailbox(confirmFirst = true) {
    if (!session) return;
    if (confirmFirst && !window.confirm("Discard this temporary mailbox? Its address and messages will no longer be available.")) return;
    stopPolling();
    clearInterval(countdownTimer);
    try { await api("/mailbox", { method: "DELETE" }); } catch {}
    session = null;
    messages = [];
    previewCache.clear();
    previewLoading.clear();
    selectedId = null;
    renderMailbox();
    els.count.textContent = "0";
    els.list.innerHTML = `<div class="state-card"><strong>Mailbox discarded</strong><span>Create a new address whenever you need one.</span></div>`;
    els.reader.innerHTML = `<div class="reader-empty"><div class="reader-mark">SZH</div><strong>Mailbox closed</strong><span>Your previous inbox has been discarded.</span></div>`;
    setConnection("READY", false);
    if (confirmFirst) toast("Mailbox discarded");
  }

  function renderExpired() {
    els.list.innerHTML = `<div class="state-card"><div class="reader-mark">END</div><strong>Mailbox expired</strong><span>Create a new address to continue.</span></div>`;
    els.reader.innerHTML = `<div class="reader-empty"><div class="reader-mark">SZH</div><strong>This mailbox has expired</strong><span>The temporary session has been closed.</span></div>`;
    els.refresh.disabled = true;
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => refreshInbox(), POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  function setConnection(text, online) {
    els.connection.textContent = text;
    els.dot.style.background = online ? "var(--accent)" : "#777";
    els.dot.style.boxShadow = online ? "0 0 12px var(--accent)" : "none";
  }
  function setBusy(value) {
    busy = value;
    els.newBox.disabled = value;
    els.refresh.disabled = value || !session;
    els.discard.disabled = value || !session;
  }
  function toast(message, error = false) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast show${error ? " error" : ""}`;
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3000);
  }
  function renderFatal(message) {
    els.address.textContent = "Mailbox unavailable";
    els.copy.disabled = true; els.refresh.disabled = true; els.discard.disabled = true;
    els.list.innerHTML = `<div class="state-card"><div class="reader-mark">!</div><strong>Connection failed</strong><span>${escapeHtml(message)}</span><button class="secondary-btn" id="retryBtn" type="button" style="margin-top:14px">TRY AGAIN</button></div>`;
    const retry = document.getElementById("retryBtn");
    if (retry) retry.addEventListener("click", createMailbox);
    els.reader.innerHTML = `<div class="reader-empty"><strong>Unable to connect</strong><span>Check your connection and try again.</span></div>`;
  }
  function friendlyError(err) {
    if (err?.status === 429) return "Mail.tm rate limit reached. Try again in a moment.";
    if (err?.status === 422) return "Mail.tm rejected the mailbox request.";
    if (err?.name === "AbortError") return "Mail.tm took too long to respond.";
    if (err?.message?.includes("Failed to fetch")) return "The SZH Mail server could not be reached. Check the deployment or your connection.";
    return err?.message || "Unknown error.";
  }
  function formatDuration(ms) {
    const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
    return [h,m,s].map(v => String(v).padStart(2,"0")).join(":");
  }
  function toTimestamp(value) {
    if (value === null || value === undefined || value === "") return NaN;
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value).trim() !== "") return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  function formatDate(value, detailed = false) {
    const timestamp = toTimestamp(value);
    if (!Number.isFinite(timestamp)) return "Unknown date";
    return new Intl.DateTimeFormat(undefined, detailed ? {dateStyle:"medium",timeStyle:"short"} : {dateStyle:"medium",timeStyle:"short"}).format(new Date(timestamp));
  }
  function formatTime(d) { return d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); }
  function relativeTime(value) {
    const timestamp = toTimestamp(value);
    if (!Number.isFinite(timestamp)) return "unknown";
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 60000) return "now";
    if (diff < 3600000) return `${Math.floor(diff/60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h`;
    return `${Math.floor(diff/86400000)}d`;
  }
  function formatPerson(p, fallback = "Unknown") {
    if (!p) return fallback;
    if (typeof p === "string") return p;
    if (Array.isArray(p)) return p.map(item => formatPerson(item, fallback)).join(", ");
    return p.name ? `${p.name}${p.address ? ` <${p.address}>` : ""}` : (p.address || fallback);
  }
  function formatRecipients(value) {
    if (!value) return "Unknown";
    if (Array.isArray(value)) return value.map(formatPerson).join(", ");
    if (typeof value === "string") return value;
    return formatPerson(value);
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g,"&#96;"); }

  els.copy.addEventListener("click", async () => {
    if (!session) return;
    try { await navigator.clipboard.writeText(session.address); toast("Address copied"); }
    catch { toast("Copy failed. Select the address manually.", true); }
  });
  els.newBox.addEventListener("click", async () => {
    if (busy) return;
    if (session && !window.confirm("Create a new mailbox? The current mailbox will be discarded.")) return;
    if (session) await discardMailbox(false);
    await createMailbox();
  });
  els.refresh.addEventListener("click", refreshInbox);
  els.discard.addEventListener("click", () => discardMailbox(true));
  window.addEventListener("beforeunload", stopPolling);

  renderMailbox();
  restoreOrCreate();
})();
