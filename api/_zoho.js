/* Shared Zoho CRM helper.
 *
 * Every credential lives here, server side. The browser never sees the refresh
 * token, the client secret, or even the access token — it only ever talks to
 * our own /api/* routes.
 */

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API      = process.env.ZOHO_API_HOST      || "https://www.zohoapis.com";

/* Access tokens last an hour. A warm serverless instance reuses one; a cold
 * start mints a fresh one. Refreshing early by 5 minutes avoids racing the
 * expiry mid-batch. */
let cached = { token: null, expires: 0 };

export function config(){
  const missing = ["ZOHO_CLIENT_ID","ZOHO_CLIENT_SECRET","ZOHO_REFRESH_TOKEN"]
    .filter(k => !process.env[k]);
  return { ok: missing.length === 0, missing, accounts: ACCOUNTS, api: API };
}

export async function accessToken(){
  if(cached.token && Date.now() < cached.expires) return cached.token;

  const cfg = config();
  if(!cfg.ok) throw new HttpError(500,
    `Missing environment variable${cfg.missing.length>1?"s":""}: ${cfg.missing.join(", ")}. `+
    `Set them in the Vercel dashboard under Settings → Environment Variables.`);

  const body = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    "refresh_token"
  });

  const res = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body
  });
  const json = await res.json().catch(()=>({}));

  /* Zoho answers 200 with an "error" key rather than an error status, so the
   * HTTP code alone is not a verdict. */
  if(!json.access_token){
    const e = json.error || "unknown_error";
    throw new HttpError(502,
      e === "invalid_code"   ? "The refresh token is invalid or has been revoked. Generate a new one."
    : e === "invalid_client" ? "Client id or secret is wrong, or belongs to a different data centre."
    : `Zoho refused the token request: ${e}`);
  }

  cached = { token: json.access_token, expires: Date.now() + (json.expires_in - 300) * 1000 };
  return cached.token;
}

export class HttpError extends Error {
  constructor(status, message, extra){ super(message); this.status = status; Object.assign(this, extra||{}); }
}

/* One CRM call. Retries once on a 401 (token revoked mid-flight) and backs off
 * on 429, which Zoho returns when the per-minute credit limit is hit. */
export async function crm(path, { method="GET", body, retry=true } = {}){
  const token = await accessToken();
  const res = await fetch(`${API}/crm/v8${path}`, {
    method,
    headers:{
      "Authorization": `Zoho-oauthtoken ${token}`,
      ...(body ? {"Content-Type":"application/json"} : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if(res.status === 401 && retry){
    cached = { token:null, expires:0 };
    return crm(path, { method, body, retry:false });
  }
  if(res.status === 429){
    const wait = Number(res.headers.get("retry-after") || 2);
    await new Promise(r => setTimeout(r, Math.min(wait,10) * 1000));
    if(retry) return crm(path, { method, body, retry:false });
    throw new HttpError(429, "Zoho rate limit reached. Wait a minute and retry the remaining rows.");
  }

  /* 204 = no content, which the search endpoints use for "nothing matched" */
  if(res.status === 204) return { data: [] };

  const text = await res.json().catch(()=>null);
  if(!res.ok){
    throw new HttpError(res.status,
      text?.message || `Zoho returned ${res.status} for ${path}`,
      { code: text?.code, details: text?.details });
  }
  return text;
}

/* Small helper so every route handles its errors the same way. */
export function handler(fn){
  return async (req, res) => {
    try{
      const out = await fn(req, res);
      if(out !== undefined) res.status(200).json(out);
    }catch(err){
      const status = err.status || 500;
      res.status(status).json({
        error: err.message || "Unexpected error",
        code:  err.code || undefined
      });
    }
  };
}

export function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  if(typeof req.body === "string"){
    try{ return JSON.parse(req.body); }catch{ throw new HttpError(400,"Body is not valid JSON."); }
  }
  return {};
}
