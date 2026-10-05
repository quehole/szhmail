const crypto = require("node:crypto");
const https = require("node:https");

const MAIL_API = "https://nowtempmail.com";
const COOKIE = "szh_session";
const SESSION_TTL_SECONDS = 60 * 60;
const IS_PRODUCTION = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
const SECURE_COOKIE = IS_PRODUCTION;

function secretKey() {
  const configured = process.env.SZH_SESSION_SECRET;
  const raw = configured || (!process.env.VERCEL_ENV ? "szh-mail-local-development-secret-change-for-production-2026" : "");
  if (!raw || raw.length < 32) throw new Error("SZH_SESSION_SECRET is missing or too short. Set it to a random value of at least 32 characters.");
  return crypto.createHash("sha256").update(raw).digest();
}

function providerKey() {
  const key = process.env.NTM_API_KEY;
  if (!key) {
    const error = new Error("NTM_API_KEY is missing. Add your NowTempMail API key to Vercel Production environment variables.");
    error.code = "NO_PROVIDER_KEY";
    throw error;
  }
  return key;
}

function b64url(value) { return Buffer.from(value).toString("base64url"); }
function unb64url(value) { return Buffer.from(value, "base64url"); }

function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
}

function decrypt(value) {
  try {
    const [ivRaw, tagRaw, cipherRaw] = String(value || "").split(".");
    if (!ivRaw || !tagRaw || !cipherRaw) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), unb64url(ivRaw));
    decipher.setAuthTag(unb64url(tagRaw));
    const plaintext = Buffer.concat([decipher.update(unb64url(cipherRaw)), decipher.final()]).toString("utf8");
    const data = JSON.parse(plaintext);
    if (!data.id || !data.address || !data.token || !data.expiresAt) return null;
    if (Date.now() >= data.expiresAt) return null;
    return data;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function setSessionCookie(res, session) {
  const value = encrypt(session);
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly;${SECURE_COOKIE ? " Secure;" : ""} SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly;${SECURE_COOKIE ? " Secure;" : ""} SameSite=Lax; Max-Age=0`);
}
function getSession(req) { return decrypt(parseCookies(req)[COOKIE]); }

function parseProviderBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function requestProvider(path, options = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${MAIL_API}${path}`);
    const method = options.method || "GET";
    const body = options.body || null;
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${providerKey()}`,
      "User-Agent": "SZH-Mail/1.0",
      Connection: "close",
      ...(options.headers || {})
    };
    if (body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (body && !headers["Content-Length"]) headers["Content-Length"] = Buffer.byteLength(body);

    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      agent: false,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode || 0, headers: response.headers, text, data: parseProviderBody(text) });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("NowTempMail request timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function nowtempmail(path, options = {}, timeoutMs = 15000) {
  try {
    const result = await requestProvider(path, options, timeoutMs);
    if (result.status >= 200 && result.status <= 204) return { response: result, data: result.data };
    const message = result.data?.detail || result.data?.message || result.data?.error || `NowTempMail request failed with status ${result.status}`;
    const error = new Error(message);
    error.status = result.status;
    error.providerBody = result.text.slice(0, 2000);
    error.providerContentType = result.headers["content-type"] || null;
    error.requestId = result.data?.requestId || result.headers["x-request-id"] || null;
    throw error;
  } catch (error) {
    throw error;
  }
}

function authOptions(session, options = {}) {
  return options;
}
function publicSession(session) { return { address: session.address, createdAt: session.createdAt, expiresAt: session.expiresAt }; }

function friendlyError(error) {
  if (error?.code === "NO_PROVIDER_KEY") return "NowTempMail API key is not configured on the server.";
  if (error?.code === "ETIMEDOUT") return "NowTempMail took too long to respond.";
  if (error?.status === 401) return "The mailbox session is no longer valid.";
  if (error?.status === 404) return "The mailbox could not be found.";
  if (error?.status === 409) return "That mailbox address is already in use.";
  if (error?.status === 429) return "NowTempMail rate limit reached. Please wait a moment.";
  if (error?.status === 500) return "NowTempMail had a temporary server error. Please try again.";
  if (error?.code === "ECONNRESET" || error?.code === "EAI_AGAIN" || error?.code === "ENOTFOUND") return "Vercel could not reach NowTempMail. Please try again.";
  return error?.message || "Mail service unavailable.";
}

module.exports = { MAIL_API, SESSION_TTL_SECONDS, setSessionCookie, clearSessionCookie, getSession, nowtempmail, authOptions, publicSession, friendlyError, providerKey };
