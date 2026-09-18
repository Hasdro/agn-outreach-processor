/* Outreach Agent — validation and record-building engine.
 *
 * Loaded by the page with a plain <script src>, and required directly by the
 * tests, so what is tested is what ships rather than a copy that drifts.
 * Everything here is pure: no DOM, no network, no globals. State the page owns
 * (headers, rows, mappings) is passed in as a ctx argument.
 */
const MAX_ROWS = 10000;

/* --- section 2 config: industry -> the email flows it may map to ---------- */
const INDUSTRY_FLOWS = {
  "Real Estate":        ["Off-plan launch", "Investor nurture", "Cold outreach"],
  "Retail & E-commerce":["Store launch", "Seasonal promo", "Cold outreach"],
  "Healthcare":         ["Clinic onboarding", "Patient re-activation"],
  "Education":          ["Course enrolment", "Webinar invite"],
  "Hospitality":        ["Venue promo", "Corporate rates"],
  "Professional Services":["Consultation offer", "Cold outreach"],
  "Construction":       ["Project enquiry", "Supplier intro"],
  "Other":              ["Generic nurture", "Cold outreach"]
};

/* --- email reference data ------------------------------------------------ */
const PLACEHOLDERS = new Set(["noemail","no-email","none","n/a","na","null","test","abc","xxx",
  "nil","unknown","tbd","-","0","email","na@na.com","test@test.com","abc@abc.com"]);
const DISPOSABLE = ["mailinator.com","tempmail","10minutemail","guerrillamail","yopmail",
  "throwaway","trashmail","sharklasers","getnada","dispostable","maildrop.cc","fakeinbox"];
const ROLE_LOCALS = new Set(["info","sales","admin","support","contact","hr","careers","office",
  "enquiry","enquiries","marketing","accounts","billing","hello","team","mail","help"]);
const KNOWN_DOMAINS = ["gmail.com","hotmail.com","outlook.com","yahoo.com","icloud.com","live.com",
  "aol.com","msn.com","protonmail.com","me.com","emirates.net.ae","eim.ae","yahoo.co.uk"];

/* --- UAE phone reference ------------------------------------------------- */
const MOBILE_SECOND = new Set(["0","2","4","5","6","8"]);   // +9715X…
const LANDLINE_AREA = new Set(["2","3","4","6","7","9"]);   // Abu Dhabi, Al Ain, Dubai, …

/* ========================= validators ==================================== */

/* Damerau-Levenshtein (optimal string alignment): a transposition costs 1, not 2.
   That matters — "gmial.com" is a swap, and it is the single most common typo. */
function editDistance(a,b){
  const m=a.length,n=b.length; if(!m)return n; if(!n)return m;
  const d=Array.from({length:m+1},(_,i)=>{const r=new Array(n+1).fill(0);r[0]=i;return r;});
  for(let j=0;j<=n;j++) d[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const c = a[i-1]===b[j-1]?0:1;
      d[i][j]=Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+c);
      if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])
        d[i][j]=Math.min(d[i][j], d[i-2][j-2]+1);
    }
  }
  return d[m][n];
}

/* Tier 1 syntax + Tier 2 junk filter. Returns
   {ok, value, reason, role, suggestion} */
function validateEmail(raw){
  let s = String(raw ?? "")
    .replace(/[​-‍﻿]/g,"")   // zero-width junk from copy/paste
    .trim()
    .replace(/^mailto:/i,"")                // after the trim, or a leading space defeats it
    .trim();
  if(!s) return {ok:false, value:"", reason:"EMPTY"};

  // a cell holding several addresses — take the first, flag it
  let multi = false;
  if(/[;,\s]/.test(s)){ const first = s.split(/[;,\s]+/)[0]; if(first!==s){ multi=true; s=first; } }

  if(PLACEHOLDERS.has(s.toLowerCase())) return {ok:false, value:s, reason:"PLACEHOLDER"};

  const at = s.indexOf("@");
  if(at<0 || s.indexOf("@",at+1)>=0) return {ok:false, value:s, reason:"SYNTAX_AT"};
  let local = s.slice(0,at), domain = s.slice(at+1).toLowerCase();  // domain is case-insensitive
  if(PLACEHOLDERS.has(local.toLowerCase())) return {ok:false, value:s, reason:"PLACEHOLDER"};

  if(local.length<1 || local.length>64) return {ok:false, value:s, reason:"SYNTAX_LOCAL_LEN"};
  if(domain.length<4 || domain.length>255) return {ok:false, value:s, reason:"SYNTAX_DOMAIN_LEN"};
  if(!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return {ok:false,value:s,reason:"SYNTAX_LOCAL_CHARS"};
  if(local.startsWith(".")||local.endsWith(".")||local.includes("..")) return {ok:false,value:s,reason:"SYNTAX_DOTS"};
  if(!/^[a-z0-9.-]+$/.test(domain)) return {ok:false,value:s,reason:"SYNTAX_DOMAIN_CHARS"};
  if(domain.startsWith(".")||domain.endsWith(".")||domain.includes("..")
     ||domain.startsWith("-")||domain.endsWith("-")) return {ok:false,value:s,reason:"SYNTAX_DOTS"};

  const parts = domain.split(".");
  if(parts.length<2) return {ok:false, value:s, reason:"SYNTAX_NO_TLD"};
  const tld = parts[parts.length-1];
  if(!/^[a-z]{2,}$/.test(tld)) return {ok:false, value:s, reason:"SYNTAX_TLD"};   // kills .c and .123

  if(DISPOSABLE.some(d=>domain.includes(d))) return {ok:false, value:s, reason:"DISPOSABLE"};

  // likely typo: one edit away from a domain we know, but not that domain
  for(const known of KNOWN_DOMAINS){
    if(domain!==known && Math.abs(domain.length-known.length)<=2 && editDistance(domain,known)===1){
      return {ok:false, value:s, reason:"TYPO_SUSPECT",
              suggestion: local+"@"+known};
    }
  }

  const email = local+"@"+domain;
  return {ok:true, value:email, reason: multi?"MULTI_TAKEN_FIRST":"",
          role: ROLE_LOCALS.has(local.toLowerCase())};
}

/* House UAE normalisation, then a structural check.
   Returns {ok, value, kind:"mobile"|"landline"|"", reason, recovered} */
function validatePhone(raw){
  if(raw===null||raw===undefined||raw==="") return {ok:false,value:"",kind:"",reason:"EMPTY"};

  // Excel often stores a phone as a number, which loses the leading zero.
  let s = (typeof raw === "number")
        ? (Number.isInteger(raw) ? raw.toFixed(0) : String(raw))
        : String(raw).trim();
  if(!s) return {ok:false,value:"",kind:"",reason:"EMPTY"};

  const hadPlus = s.trim().startsWith("+");
  let d = s.replace(/[^0-9]/g,"");
  if(!d) return {ok:false,value:s,kind:"",reason:"NO_DIGITS"};

  // strip local / international prefixes — the AGN house rule
  const before = d;
  d = d.replace(/^(?:00971|0971|971|00|0)/,"");
  const recovered = (!hadPlus && before.length===9 && before[0]==="5"); // lost leading zero

  // placeholders such as 0000000000, 0555555555, 0501111111 — a real list does not
  // contain a number whose whole subscriber part is one repeated digit
  if(/^(\d)\1+$/.test(d) || /^(\d)\1{6,}$/.test(d.slice(-7)))
    return {ok:false,value:s,kind:"",reason:"REPEATED_DIGITS"};

  if(d.length===9 && d[0]==="5"){
    if(!MOBILE_SECOND.has(d[1])) return {ok:false,value:s,kind:"",reason:"BAD_MOBILE_PREFIX"};
    return {ok:true, value:"+971"+d, kind:"mobile", reason: recovered?"LOST_LEADING_ZERO":"", recovered};
  }
  if(d.length===8 && LANDLINE_AREA.has(d[0])){
    return {ok:true, value:"+971"+d, kind:"landline", reason:"LANDLINE"};
  }
  return {ok:false, value:s, kind:"",
          reason: d.length<8 ? "TOO_SHORT" : d.length>9 ? "TOO_LONG" : "NOT_UAE_FORMAT"};
}

/* ========================= file reading ================================== */

/* A CSV parser that handles quoted fields, so we work with no network too. */
function parseCSV(text){
  const rows=[]; let row=[], cell="", q=false;
  text = text.replace(/^﻿/,"");
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; }
      else cell+=c;
    } else if(c==='"'){ q=true; }
    else if(c===","){ row.push(cell); cell=""; }
    else if(c==="\n"){ row.push(cell); rows.push(row); row=[]; cell=""; }
    else if(c!=="\r"){ cell+=c; }
  }
  if(cell!==""||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(v=>String(v).trim()!==""));
}


/* ---- values derived from validation rather than read from a column ------- */
/* A row whose email was already claimed by an earlier row is classified as
   phone-only, and must not carry that email into the CRM anyway — doing so
   writes the duplicate we just decided to suppress. The dedupe flags therefore
   gate the value, not merely the bucket. */
const COMPUTED = {
  email_clean:  { label:"Email (validated)",    get:(r)      => (r.email.ok && !r.dupEmail) ? r.email.value : "" },
  mobile_clean: { label:"Mobile (normalised)",  get:(r)      => (r.phone.ok && r.phone.kind==="mobile" && !r.dupPhone) ? r.phone.value : "" },
  phone_clean:  { label:"Landline (normalised)",get:(r)      => (r.phone.ok && r.phone.kind==="landline")? r.phone.value : "" },
  first_derived:{ label:"First name (from name column)", get:(r,ctx) => splitName(r,ctx).first },
  last_derived: { label:"Last name (from name column)",  get:(r,ctx) => splitName(r,ctx).last  },
  channel:      { label:"Channel (email/phone/both)",    get:(r)     => r.bucket }
};

/* A single "Name" column is the common case, and Last_Name is mandatory in
   every module we import to, so this must never return an empty surname. */
function splitName(r, ctx){
  const { headers = [], dataRows = [] } = ctx || {};
  const orig = dataRows[r.row-2] || [];
  const cell = pats => {
    const i = headers.findIndex(h => pats.test(String(h).trim()));
    return i>=0 ? String(orig[i] ?? "").trim() : "";
  };
  let first = cell(/^first|given/i), last = cell(/^last|surname|family/i);
  if(!last){
    const full = cell(/^(full[\s_-]*)?name$|^contact[\s_-]*name/i);
    if(full){ const b = full.split(/\s+/); last = b.pop(); first = first || b.join(" "); }
  }
  if(!last) last = r.email.ok ? r.email.value.split("@")[0] : "Unknown";
  return { first, last };
}

/* ---- classify every row and bucket it ----------------------------------- */
/* Dedupe is per channel and case-insensitive. A repeated phone must not
   discard a unique email: whole offices share one landline, and killing the
   row would throw away every good address behind it. Landlines never enter the
   phone key set, because they are not a routing channel at all. */
function classify(dataRows, ei, pi){
  const out = [], seenEmail = new Set(), seenPhone = new Set();
  dataRows.forEach((row, i) => {
    const email = validateEmail(row[ei]), phone = validatePhone(row[pi]);
    const eKey = email.ok ? email.value.toLowerCase() : "";
    const pKey = (phone.ok && phone.kind === "mobile") ? phone.value : "";
    const dupEmail = !!eKey && seenEmail.has(eKey);
    const dupPhone = !!pKey && seenPhone.has(pKey);
    if(eKey) seenEmail.add(eKey);
    if(pKey) seenPhone.add(pKey);

    const emailOK = email.ok && !dupEmail;
    const phoneOK = phone.ok && phone.kind === "mobile" && !dupPhone;
    out.push({
      row: i+2,
      bucket: emailOK&&phoneOK ? "both" : emailOK ? "email" : phoneOK ? "phone" : "neither",
      email, phone, dupEmail, dupPhone
    });
  });
  return out;
}

/* ---- turn a classified row into a CRM record via the mapping table ------- */
/* Values are clipped to the CRM's own field lengths before sending.
 *
 * Zoho rejects an over-length value with a 400 for the WHOLE request, not for
 * the offending record, so one 180-character name in a batch of 100 destroys
 * 99 good rows. Clipping here keeps the row, and the clip is reported through
 * ctx.notes so it is visible rather than silent.
 *
 * Identifiers are the exception: half an email address is not a shorter email,
 * it is a wrong one, so those are dropped instead of trimmed. */
const IDENTIFIER = new Set(["email","phone","website"]);

function buildRecord(r, ctx){
  const { headers = [], dataRows = [], mappings = [], mandatory = [],
          fieldMeta = {}, notes = null } = ctx || {};
  const orig = dataRows[r.row-2] || [];
  const rec = {};
  for(const m of mappings){
    if(!m.field) continue;
    let v = "";
    if(m.type === "column")        v = String(orig[m.index] ?? "").trim();
    else if(m.type === "computed") v = COMPUTED[m.key] ? COMPUTED[m.key].get(r, ctx) : "";
    else if(m.type === "static")   v = String(m.value ?? "").trim();

    const meta = fieldMeta[m.field];
    if(v !== "" && meta?.length && v.length > meta.length){
      if(IDENTIFIER.has(meta.type)){
        notes?.push({ row:r.row, field:m.field, kind:"dropped",
                      was:v.length, limit:meta.length });
        v = "";
      }else{
        notes?.push({ row:r.row, field:m.field, kind:"trimmed",
                      was:v.length, limit:meta.length });
        v = v.slice(0, meta.length);
      }
    }
    if(v !== "") rec[m.field] = v;
  }
  if(mandatory.includes("Last_Name") && !rec.Last_Name){
    const lim = fieldMeta.Last_Name?.length || 80;
    rec.Last_Name = splitName(r,ctx).last.slice(0, lim);
  }
  if(mandatory.includes("Account_Name") && !rec.Account_Name) rec.Account_Name = "Unknown";
  return rec;
}

/* Send rows, halving on a wholesale rejection until the offending ones are
 * alone. Zoho answers a malformed value with a 400 for the entire request
 * rather than for the record at fault, so without this a single poison row
 * costs the ninety-nine good ones sent beside it.
 *
 * `send` takes an array and resolves to per-row results, or throws to mean the
 * whole request was refused. Worst case is about log2(batch) extra calls, and
 * only when something has already failed.
 */
async function sendInHalves(rows, send, onRow, onReject){
  if(!rows.length) return;
  try{
    const results = await send(rows);
    results.forEach((res, i) => onRow(rows[i], res));
  }catch(err){
    if(rows.length === 1){
      onReject(rows[0], err);
      return;
    }
    const mid = Math.ceil(rows.length/2);
    await sendInHalves(rows.slice(0,mid), send, onRow, onReject);
    await sendInHalves(rows.slice(mid),   send, onRow, onReject);
  }
}

const Engine = { MAX_ROWS, sendInHalves, INDUSTRY_FLOWS, validateEmail, validatePhone, parseCSV,
                 editDistance, COMPUTED, splitName, classify, buildRecord };

if(typeof window !== "undefined") window.Engine = Engine;
if(typeof module !== "undefined" && module.exports){
  module.exports = { MAX_ROWS, sendInHalves, INDUSTRY_FLOWS, validateEmail, validatePhone, parseCSV,
                     editDistance, COMPUTED, splitName, classify, buildRecord };
}
