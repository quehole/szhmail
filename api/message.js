const { getSession, nowtempmail, friendlyError } = require("./_lib");

module.exports = async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false, error: "NO_SESSION" });
  const id = req.query?.id;
  if (!id) return res.status(400).json({ ok: false, error: "MESSAGE_ID_REQUIRED" });

  try {
    const base = `/v1/mailboxes/${encodeURIComponent(session.address)}/messages/${encodeURIComponent(id)}`;
    if (req.method === "GET") {
      const { data } = await nowtempmail(base);
      return res.status(200).json({ ok: true, message: data?.message || data });
    }
    if (req.method === "PATCH") {
      // NowTempMail has no read-state mutation endpoint. The frontend tracks read state locally.
      return res.status(200).json({ ok: true, message: { id, seen: true } });
    }
    if (req.method === "DELETE") {
      await nowtempmail(base, { method: "DELETE" });
      return res.status(204).end();
    }
    res.setHeader("Allow", "GET, PATCH, DELETE");
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: friendlyError(error) });
  }
};
