const { nowtempmail, setSessionCookie, clearSessionCookie, getSession, publicSession, friendlyError } = require("./_lib");

async function createMailbox() {
  const { data } = await nowtempmail("/v1/mailboxes", { method: "POST", body: "{}" });
  if (!data?.address) throw new Error("NowTempMail returned an invalid mailbox.");

  const createdAt = data.createdAt ? Number(data.createdAt) * 1000 : Date.now();
  const providerExpiry = data.expiresAt ? Number(data.expiresAt) * 1000 : createdAt + 24 * 60 * 60 * 1000;
  const expiresAt = Math.min(providerExpiry, createdAt + 60 * 60 * 1000);

  return {
    id: data.id || data.address,
    address: data.address,
    password: "",
    token: process.env.NTM_API_KEY,
    createdAt,
    expiresAt
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const session = getSession(req);
      if (!session) {
        clearSessionCookie(res);
        return res.status(404).json({ ok: false, error: "NO_SESSION" });
      }
      try {
        await nowtempmail(`/v1/mailboxes/${encodeURIComponent(session.address)}`);
      } catch (error) {
        if (error.status === 401 || error.status === 404) {
          clearSessionCookie(res);
          return res.status(404).json({ ok: false, error: "SESSION_LOST" });
        }
        throw error;
      }
      return res.status(200).json({ ok: true, mailbox: publicSession(session) });
    }

    if (req.method === "POST") {
      const old = getSession(req);
      if (old) {
        try { await nowtempmail(`/v1/mailboxes/${encodeURIComponent(old.address)}`, { method: "DELETE" }); } catch {}
      }
      const session = await createMailbox();
      setSessionCookie(res, session);
      return res.status(201).json({ ok: true, mailbox: publicSession(session) });
    }

    if (req.method === "DELETE") {
      const session = getSession(req);
      clearSessionCookie(res);
      if (session) {
        try { await nowtempmail(`/v1/mailboxes/${encodeURIComponent(session.address)}`, { method: "DELETE" }); } catch {}
      }
      return res.status(204).end();
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: friendlyError(error) });
  }
};
