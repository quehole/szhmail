const { nowtempmail, providerKey } = require("./_lib");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  try {
    providerKey();
    const { response, data } = await nowtempmail("/v1/me");
    return res.status(200).json({
      ok: true,
      status: response.status,
      plan: data?.plan || null,
      limits: data?.limits || null,
      usage: data?.usage || null
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      status: error.status || 500,
      requestId: error.requestId || null,
      contentType: error.providerContentType || null,
      providerBody: error.providerBody || null
    });
  }
};
