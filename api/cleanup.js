import { crm, handler, readBody, HttpError } from "./_zoho.js";

/* Delete records by id. Used by the stress test to remove what it created.
 *
 * Deletion is permanent, so this is off unless ALLOW_CLEANUP is explicitly set,
 * and it only ever accepts an explicit list of ids — never a tag, a filter or
 * anything else that could match more than the caller intended. A test that
 * tidies up must not be one typo away from emptying a module.
 */
export default handler(async (req) => {
  if(process.env.ALLOW_CLEANUP !== "1")
    throw new HttpError(403,
      "Cleanup is disabled. Set ALLOW_CLEANUP=1 to enable it (local testing only).");

  const { module, ids = [], tagId } = readBody(req);
  if(!module) throw new HttpError(400, "module is required.");

  const list = [...new Set(ids.map(String).filter(Boolean))];
  let deleted = 0;

  for(let i=0; i<list.length; i+=100){
    const chunk = list.slice(i, i+100);
    const res = await crm(`/${module}?ids=${chunk.join(",")}`, { method:"DELETE" });
    deleted += (res.data||[]).filter(r => r.code === "SUCCESS").length;
  }

  if(tagId) await crm(`/settings/tags/${tagId}`, { method:"DELETE" }).catch(()=>{});

  return { deleted, requested: list.length };
});
