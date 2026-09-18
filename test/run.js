/* Stress test: parse each fixture through the shipped engine, import it into a
 * live CRM, then read the records back and check they are actually correct.
 *
 * The verification reads from the CRM rather than trusting the import
 * response. An API that answers "success" is not evidence the data is right —
 * that mistake has been made in this codebase before.
 */

const Engine   = require("../public/engine.js");
const fixtures = require("./fixtures.js");

const BASE  = process.env.BASE_URL || "http://localhost:3311";
const RUN   = process.env.RUN_ID   || "T";
const TAG   = `stress-${RUN}`;
const KEEP  = process.env.KEEP === "1";
const BATCH = 100;

const c = { g:s=>`\x1b[32m${s}\x1b[0m`, r:s=>`\x1b[31m${s}\x1b[0m`,
            y:s=>`\x1b[33m${s}\x1b[0m`, d:s=>`\x1b[2m${s}\x1b[0m`, b:s=>`\x1b[1m${s}\x1b[0m` };

async function api(path, body){
  const res  = await fetch(BASE+path, body ? {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  } : undefined);
  const json = await res.json().catch(()=>null);
  if(!res.ok || json?.error) throw new Error(json?.error || `${path} -> ${res.status}`);
  return json;
}

/* mirrors what the page does: pick the email/phone columns from the headers */
function guess(headers, pats){
  for(const p of pats){ const i = headers.findIndex(h=>p.test(String(h).trim())); if(i>=0) return i; }
  return -1;
}

const failures = [];

async function runFixture(fx, idx){
  const label = `${String(idx+1).padStart(2)}. ${fx.name}`;
  const problems = [];

  /* ---- parse + classify through the real engine ---- */
  const rows    = Engine.parseCSV(fx.csv);
  const headers = (rows[0]||[]).map(h=>String(h).trim());
  const data    = rows.slice(1);
  const ei = Math.max(0, guess(headers,[/^e-?mail/i,/e-?mail/i]));
  const pi = Math.max(0, guess(headers,[/^(mobile|phone)/i,/mobile|phone|tel/i]));
  const cls = Engine.classify(data, ei, pi);

  const got = {
    rows: data.length,
    both:      cls.filter(r=>r.bucket==="both").length,
    emailOnly: cls.filter(r=>r.bucket==="email").length,
    phoneOnly: cls.filter(r=>r.bucket==="phone").length,
    neither:   cls.filter(r=>r.bucket==="neither").length
  };
  got.importable = got.both + got.emailOnly + got.phoneOnly;

  for(const [k,v] of Object.entries(fx.expect||{}))
    if(got[k] !== v) problems.push(`${k}: expected ${v}, got ${got[k]}`);

  /* the invariant that must hold for every file, not just these */
  if(got.both+got.emailOnly+got.phoneOnly+got.neither !== got.rows)
    problems.push(`buckets do not sum to rows`);

  /* ---- import the importable rows ---- */
  const toSend = cls.filter(r=>r.bucket!=="neither");
  const meta = await api(`/api/fields?module=Leads`).catch(()=>({fields:[]}));
  const fieldMeta = Object.fromEntries((meta.fields||[]).map(f=>[f.api_name,{length:f.length,type:f.type}]));
  const ctx = { headers, dataRows:data, mandatory:["Last_Name"], fieldMeta, notes:[], mappings:[
    { field:"Last_Name",  type:"computed", key:"last_derived" },
    { field:"First_Name", type:"computed", key:"first_derived" },
    { field:"Email",      type:"computed", key:"email_clean" },
    { field:"Mobile",     type:"computed", key:"mobile_clean" },
    { field:"Company",    type:"column",   index: guess(headers,[/company/i]) }
  ].filter(m=>m.type!=="column"||m.index>=0) };

  let sent=0, ok=0, failed=0, emails=[]; const ids=[];
  if(toSend.length){
    const records = toSend.map(r => Engine.buildRecord(r, ctx));
    emails = records.map(r=>r.Email).filter(Boolean);

    for(let i=0;i<records.length;i+=BATCH){
      const slice = records.slice(i,i+BATCH);
      try{
        const out = await api("/api/import", { module:"Leads", records:slice, tag:TAG, mode:"insert" });
        sent += slice.length;
        ok   += out.counts.inserted + out.counts.updated;
        failed += out.counts.failed;
        out.results.forEach(r => { if(r.ok && r.id) ids.push(r.id); });
        out.results.filter(r=>!r.ok).slice(0,3).forEach(r =>
          problems.push(`row rejected: ${r.message}`));
      }catch(err){ problems.push(`import failed: ${err.message}`); }
    }
    if(sent !== records.length) problems.push(`sent ${sent} of ${records.length}`);
  }

  /* ---- verify in the CRM, not from the import response ---- */
  let found = 0;
  if(emails.length){
    const look = await api("/api/lookup", { module:"Leads", field:"Email", values:emails,
                                            extra:["Last_Name"] });
    found = look.found;
    if(found !== emails.length)
      problems.push(`CRM has ${found} of ${emails.length} imported emails`);
  }

  const pass = problems.length === 0;
  console.log(`${pass ? c.g("PASS") : c.r("FAIL")}  ${label}`);
  console.log(c.d(`      rows=${got.rows} both=${got.both} email=${got.emailOnly} `+
                  `phone=${got.phoneOnly} neither=${got.neither} | sent=${sent} ok=${ok} `+
                  `failed=${failed} verifiedInCRM=${found}`));
  if(fx.note) console.log(c.d(`      ${fx.note}`));
  problems.forEach(p => { console.log(c.r(`      ! ${p}`)); });
  if(!pass) failures.push({ fixture: fx.name, problems });
  return { emails, ids };
}

(async () => {
  console.log(c.b(`\nUnit checks (no CRM)\n`));
  const unitFailed = await require("./unit.js")();
  if(unitFailed) failures.push({ fixture:"unit checks", problems:[`${unitFailed} failing`] });

  console.log(c.b(`\nStress test — run ${RUN}, tag ${TAG}, against ${BASE}\n`));
  const all = [];
  for(let i=0;i<fixtures.length;i++){
    const { ids } = await runFixture(fixtures[i], i);
    all.push(...ids);
    console.log("");
  }

  console.log(c.b(`${fixtures.length - failures.length}/${fixtures.length} fixtures passed`));
  if(failures.length){
    console.log(c.r(`\n${failures.length} failing:`));
    failures.forEach(f => console.log(c.r(`  - ${f.fixture}`),
      "\n"+f.problems.map(p=>"      "+p).join("\n")));
  }

  if(!KEEP){
    const tag = await api("/api/tags", { module:"Leads", names:[TAG] }).catch(()=>null);
    const gone = await api("/api/cleanup",
      { module:"Leads", ids: all, tagId: tag?.tags?.[0]?.id });
    console.log(c.d(`\ncleanup: ${gone.deleted} of ${gone.requested} records deleted, tag removed`));
  }else{
    console.log(c.y(`\nKEEP=1 — ${all.length} records left in the CRM under tag ${TAG}`));
  }
  process.exit(failures.length ? 1 : 0);
})().catch(err => { console.error(c.r("harness error: "+err.message)); process.exit(2); });
