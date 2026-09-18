/* Shared Zoho CRM helper.
 *
 * Every credential lives here, server side. The browser never sees the refresh
 * token, the client secret, or even the access token — it only ever talks to
 * our own /api/* routes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API      = process.env.ZOHO_API_HOST      || "https://www.zohoapis.com";

/* Access tokens last an hour. Zoho rate-limits how often a refresh token may be
 * exchanged, so minting one per request is not merely wasteful — it earns an
 * "Access Denied" partway through a run, which looks like a credential problem
 * and is not one.
 *
 * The cache hangs off globalThis rather than a module-level binding so it
 * survives the module being re-evaluated inside a still-living process, which
 * is what `vercel dev` does between requests. An in-flight refresh is shared
 * too, so a burst of concurrent calls triggers one exchange, not twenty. */
const store = globalThis.__zohoToken ||= { token:null, expires:0, inflight:null };

/* Local development only, and opt-in.
 *
 * `vercel dev` re-evaluates the function module between requests, so an
 * in-process cache is empty on most calls and every request mints a token —
 * which walks straight into Zoho's refresh rate limit after a dozen or so
 * calls. Persisting to the OS temp directory survives that.
 *
 * Deliberately NOT on by default and never on Vercel: this writes a live access
 * token to disk. It is scoped to a filename derived from a hash of the refresh
 * token, and holds a credential that expires in an hour. */
const DISK_CACHE = process.env.ZOHO_TOKEN_CACHE === "1" && !process.env.VERCEL;
const cacheFile = () => join(tmpdir(),
  `.zoho-token-${createHash("sha256").update(process.env.ZOHO_REFRESH_TOKEN||"").digest("hex").slice(0,12)}.json`);

function readDisk(){
  if(!DISK_CACHE) return null;
  try{
    const d = JSON.parse(readFileSync(cacheFile(), "utf8"));
    return (d.expires > Date.now()) ? d : null;
  }catch{ return null; }
}
function writeDisk(token, expires){
  if(!DISK_CACHE) return;
  try{ writeFileSync(cacheFile(), JSON.stringify({token, expires}), { mode: 0o600 }); }catch{}
}

export function config(){
  const missing = ["ZOHO_CLIENT_ID","ZOHO_CLIENT_SECRET","ZOHO_REFRESH_TOKEN"]
    .filter(k => !process.env[k]);
  return { ok: missing.length === 0, missing, accounts: ACCOUNTS, api: API };
}

export async function accessToken(){
  if(store.token && Date.now() < store.expires) return store.token;

  const onDisk = readDisk();
  if(onDisk){ store.token = onDisk.token; store.expires = onDisk.expires; return store.token; }

  if(store.inflight) return store.inflight;          // a refresh is already running
  store.inflight = refresh().finally(()=>{ store.inflight = null; });
  return store.inflight;
}

async function refresh(){
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

  /* One retry on the rate limiter: the window is short, and failing the whole
     run because two calls arrived together is worse than waiting. */
  let json = {};
  for(let attempt=0; attempt<2; attempt++){
    const res = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body
    });
    json = await res.json().catch(()=>({}));
    if(json.access_token) break;
    if(attempt === 0 && /access denied|too many/i.test(json.error||""))
      await new Promise(r => setTimeout(r, 5000));
    else break;
  }

  /* Zoho answers 200 with an "error" key rather than an error status, so the
   * HTTP code alone is not a verdict. */
  if(!json.access_token){
    const e = json.error || "unknown_error";
    throw new HttpError(502,
      e === "invalid_code"   ? "The refresh token is invalid or has been revoked. Generate a new one."
    : e === "invalid_client" ? "Client id or secret is wrong, or belongs to a different data centre."
    : /access denied|too many/i.test(e)
        ? "Zoho is rate-limiting token refreshes. Wait a minute and try again."
    : `Zoho refused the token request: ${e}`);
  }

  store.token   = json.access_token;
  store.expires = Date.now() + (json.expires_in - 300) * 1000;
  writeDisk(store.token, store.expires);
  return store.token;
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
    store.token = null; store.expires = 0;
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
