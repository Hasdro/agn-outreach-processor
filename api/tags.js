import { crm, handler, readBody, HttpError } from "./_zoho.js";

/* Ensure a tag exists on a module before the import runs.
 *
 * The tag is how a batch stays traceable after the fact — without it there is
 * no way to find "the 540 records that came from Tuesday's file" short of a
 * created-time range, which also catches everything else created that day.
 *
 * Zoho rejects a duplicate tag name rather than returning the existing one, so
 * this looks first and only creates what is missing.
 */
export default handler(async (req) => {
  const { module, names } = readBody(req);
  if(!module) throw new HttpError(400, "module is required.");

  const wanted = (Array.isArray(names) ? names : [names])
    .map(n => String(n||"").trim()).filter(Boolean);
  if(!wanted.length) return { tags: [] };

  for(const n of wanted){
    /* Zoho's own limit; a longer name is silently truncated, which would make
       the tag you search for later not the tag that was applied. */
    if(n.length > 25)
      throw new HttpError(400, `Tag "${n}" is ${n.length} characters. Zoho allows 25.`);
    if(/[,]/.test(n))
      throw new HttpError(400, `Tag "${n}" contains a comma, which Zoho uses as a separator.`);
  }

  const existing = await crm(`/settings/tags?module=${encodeURIComponent(module)}`);
  const have = new Map((existing.tags||[]).map(t => [t.name.toLowerCase(), t]));

  const toCreate = wanted.filter(n => !have.has(n.toLowerCase()));
  const created = [];

  if(toCreate.length){
    const res = await crm(`/settings/tags?module=${encodeURIComponent(module)}`, {
      method:"POST",
      body:{ tags: toCreate.map(name => ({ name })) }
    });
    (res.tags||[]).forEach((r,i) => {
      if(r.status === "success"){
        created.push({ name: toCreate[i], id: r.details.id });
        have.set(toCreate[i].toLowerCase(), { name: toCreate[i], id: r.details.id });
      }else{
        throw new HttpError(502, `Could not create tag "${toCreate[i]}": ${r.message}`);
      }
    });
  }

  return {
    tags: wanted.map(n => ({ ...have.get(n.toLowerCase()), name: n })),
    created: created.map(c => c.name),
    reused:  wanted.filter(n => !created.some(c => c.name === n))
  };
});
