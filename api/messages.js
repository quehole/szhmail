const { getSession, nowtempmail, friendlyError } = require("./_lib");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false, error: "NO_SESSION" });
  try {
    const { data } = await nowtempmail(`/v1/mailboxes/${encodeURIComponent(session.address)}/messages?limit=50`);
    const messages = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
    return res.status(200).json({ ok: true, messages, total: Number(data?.total) || messages.length });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: friendlyError(error) });
  }
};
