import { crm, handler, readBody, HttpError } from "./_zoho.js";

/* Which of these contacts are already in the CRM?
 *
 * This runs BEFORE any writing, because Zoho cannot be relied on to tell us
 * afterwards. Duplicate reporting only happens on fields an admin has marked
 * unique, and that varies per org — in the org this was built against, Contacts
 * has Email unique but Leads has no unique field at all, so importing the same
 * lead twice silently produces two records and reports complete success.
 *
 * COQL is used rather than /search: /search runs off an index that lags several
 * seconds behind a write, while COQL reads live data.
 */

const CHUNK = 50;   // keeps the IN list well inside Zoho's query length limit

export default handler(async (req) => {
  const { module, field = "Email", values = [], extra = [] } = readBody(req);
  if(!module) throw new HttpError(400, "module is required.");

  const wanted = [...new Set(
    values.map(v => String(v||"").trim()).filter(Boolean)
  )];
  if(!wanted.length) return { existing: {}, checked: 0 };

  /* Account_Name comes back as a lookup object, so it is requested by name and
     unwrapped below — a Contact's current company is what decides whether an
     update needs a new Account. */
  const cols = [...new Set(["id", field, ...extra])].join(", ");
  const existing = {};

  for(let i=0; i<wanted.length; i+=CHUNK){
    const chunk = wanted.slice(i, i+CHUNK);
    const list = chunk.map(v => `'${String(v).replace(/'/g,"\\'")}'`).join(",");
    const q = `select ${cols} from ${module} where ${field} in (${list}) limit ${CHUNK*2}`;

    const res = await crm("/coql", { method:"POST", body:{ select_query:q } });
    (res.data||[]).forEach(row => {
      const key = String(row[field]||"").toLowerCase();
      if(!key) return;
      const acct = row.Account_Name;
      existing[key] = {
        id: row.id,
        name: row.Last_Name || null,
        account: acct ? { id: acct.id, name: acct.name } : null
      };
    });
  }

  return { existing, checked: wanted.length, found: Object.keys(existing).length };
});
