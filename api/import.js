import { crm, handler, readBody, HttpError } from "./_zoho.js";

/* Import one batch of records.
 *
 * The browser slices the file into batches and calls this repeatedly, so the
 * progress bar reflects real completed work rather than an animation, and a
 * failure costs one batch instead of the whole run. Zoho caps a write at 100
 * records, which sets the batch size.
 *
 * Every response is per-record: Zoho reports partial success, so a batch of
 * 100 can be 97 inserts, 2 duplicates and 1 validation error. Collapsing that
 * into a single pass/fail would throw away exactly the detail the user needs.
 */

const MAX_BATCH = 100;

export default handler(async (req) => {
  if(req.method !== "POST") throw new HttpError(405, "Use POST.");

  const {
    module,               // "Leads" | "Contacts" | "Accounts"
    records = [],         // already mapped to CRM api names by the browser
    tag,                  // optional tag name, created beforehand via /api/tags
    mode = "insert",      // "insert" | "upsert"
    duplicateCheck = [],  // fields to match on when upserting
    accountLinking = "none" // "none" | "create" — Contacts only
  } = readBody(req);

  if(!module) throw new HttpError(400, "module is required.");
  if(!Array.isArray(records) || !records.length)
    throw new HttpError(400, "records must be a non-empty array.");
  if(records.length > MAX_BATCH)
    throw new HttpError(400, `Batch of ${records.length} exceeds Zoho's limit of ${MAX_BATCH}.`);

  const notes = [];
  let data = records.map(r => ({ ...r }));

  /* ---- Contacts: an Account must exist before a Contact can point at it ----
     Zoho will accept a Contact with a plain-text Account_Name and quietly drop
     the link, so the account is resolved to a real id first. Names are matched
     case-insensitively; anything unmatched is created once per batch. */
  if(module === "Contacts" && accountLinking === "create"){
    const names = [...new Set(
      data.map(r => String(r.Account_Name||"").trim()).filter(Boolean)
    )];

    if(names.length){
      const idByName = new Map();

      for(const name of names){
        const esc = name.replace(/[()]/g,"\\$&");
        const found = await crm(
          `/Accounts/search?criteria=(Account_Name:equals:${encodeURIComponent(esc)})`);
        if(found.data?.length) idByName.set(name.toLowerCase(), found.data[0].id);
      }

      const missing = names.filter(n => !idByName.has(n.toLowerCase()));
      if(missing.length){
        for(let i=0; i<missing.length; i+=MAX_BATCH){
          const chunk = missing.slice(i, i+MAX_BATCH);
          const made = await crm("/Accounts", {
            method:"POST",
            body:{ data: chunk.map(Account_Name => ({ Account_Name })), trigger: [] }
          });
          (made.data||[]).forEach((r,j) => {
            if(r.status === "success"){
              idByName.set(chunk[j].toLowerCase(), r.details.id);
              notes.push({ type:"account_created", name: chunk[j], id: r.details.id });
            }else{
              notes.push({ type:"account_failed", name: chunk[j], message: r.message });
            }
          });
        }
      }

      data = data.map(r => {
        const n = String(r.Account_Name||"").trim();
        const id = n ? idByName.get(n.toLowerCase()) : null;
        return id ? { ...r, Account_Name: { id } }
                  : (n ? { ...r, Account_Name: undefined } : r);
      });
    }
  }

  if(tag) data = data.map(r => ({ ...r, Tag: [{ name: tag }] }));

  const body = { data, trigger: [] };
  let path = `/${module}`;
  if(mode === "upsert"){
    path = `/${module}/upsert`;
    if(duplicateCheck.length) body.duplicate_check_fields = duplicateCheck;
  }

  const res = await crm(path, { method:"POST", body });

  /* Map Zoho's answer back onto the rows we sent, in order. Zoho preserves
     ordering, which is the only way to tell which input row a result belongs
     to — the response carries no echo of the input. */
  const results = (res.data||[]).map((r, i) => ({
    index:   i,
    ok:      r.status === "success",
    action:  r.action || (mode === "upsert" ? null : "insert"),
    id:      r.details?.id || null,
    code:    r.code,
    field:   r.details?.api_name || r.duplicate_field || null,
    message: friendly(r)
  }));

  return {
    results,
    notes,
    counts:{
      inserted: results.filter(r => r.ok && r.action !== "update").length,
      updated:  results.filter(r => r.ok && r.action === "update").length,
      failed:   results.filter(r => !r.ok).length
    }
  };
});

/* Zoho's messages are terse and sometimes name a field only in details. */
function friendly(r){
  if(r.status === "success") return r.message;
  const f = r.details?.api_name || r.duplicate_field;
  switch(r.code){
    case "MANDATORY_NOT_FOUND":   return `Required field missing: ${f||"unknown"}`;
    case "DUPLICATE_DATA":        return `Already in CRM (matched on ${f||"a unique field"})`;
    case "INVALID_DATA":          return `Invalid value for ${f||"a field"}`;
    case "NOT_APPROVED":          return "Blocked by an approval rule";
    case "LIMIT_EXCEEDED":        return `Value too long for ${f||"a field"}`;
    default:                      return r.message || r.code || "Rejected";
  }
}
