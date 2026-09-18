import { crm, handler, config } from "./_zoho.js";

/* Which modules this tool can import into, and the fields each one has.
 *
 * Fields are fetched live on every call, never cached to disk or bundled: a
 * CRM admin can add, rename or make a field mandatory at any time, and an
 * import built against a stale schema fails in ways that are tedious to
 * diagnose.
 */

const IMPORTABLE = ["Leads","Contacts","Accounts"];

/* Field types we can sensibly fill from a spreadsheet column. Anything else
 * (lookups to other records, subforms, formulas) is offered for static values
 * only, or skipped. */
const MAPPABLE = new Set([
  "text","textarea","email","phone","website","picklist","integer","bigint",
  "double","currency","date","datetime","boolean","multiselectpicklist"
]);

export default handler(async (req) => {
  const cfg = config();
  if(!cfg.ok) return { configured:false, missing: cfg.missing, modules: [] };

  const module = (req.query?.module || "").trim();

  if(!module){
    const { modules } = await crm("/settings/modules");
    return {
      configured: true,
      modules: modules
        .filter(m => IMPORTABLE.includes(m.api_name) && m.creatable)
        .map(m => ({ api_name:m.api_name, label:m.plural_label || m.api_name, id:m.id }))
    };
  }

  if(!IMPORTABLE.includes(module))
    return { error:`"${module}" is not an importable module.` };

  const { fields } = await crm(`/settings/fields?module=${encodeURIComponent(module)}`);

  const usable = fields
    .filter(f => !f.read_only && f.api_name !== "id" && f.data_type !== "subform")
    .map(f => ({
      api_name:  f.api_name,
      label:     f.field_label,
      type:      f.data_type,
      mandatory: !!f.system_mandatory,
      length:    f.length || null,
      mappable:  MAPPABLE.has(f.data_type),
      options:   (f.pick_list_values || [])
                   .map(v => v.actual_value)
                   .filter(v => v && v !== "-None-")
    }));

  /* Sort so the fields a user actually needs are at the top of the picker:
     mandatory first, then the common contact fields, then everything else. */
  const COMMON = ["Last_Name","First_Name","Email","Phone","Mobile","Company",
                  "Account_Name","Lead_Source","Title","Description"];
  usable.sort((a,b) =>
    (b.mandatory - a.mandatory) ||
    ((COMMON.indexOf(a.api_name)+1||99) - (COMMON.indexOf(b.api_name)+1||99)) ||
    a.label.localeCompare(b.label));

  return {
    configured: true,
    module,
    fields: usable,
    mandatory: usable.filter(f => f.mandatory).map(f => f.api_name)
  };
});
