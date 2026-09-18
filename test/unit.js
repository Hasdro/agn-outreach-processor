/* Pure-logic checks that need no CRM. Run by test/run.js before the live pass. */
const E = require("../public/engine.js");

const checks = [];
const is = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

/* --- validators ------------------------------------------------------- */
is("email: plain",            E.validateEmail("a@b.ae").ok, true);
is("email: role kept",        E.validateEmail("info@b.ae").role, true);
is("email: typo caught",      E.validateEmail("x@gmial.com").suggestion, "x@gmail.com");
is("email: tld too short",    E.validateEmail("x@y.c").ok, false);
is("email: mailto + spaces",  E.validateEmail("  MailTo:S@Example.COM ").value, "S@example.com");
is("email: domain lowercased, local kept", E.validateEmail("A@B.AE").value, "A@b.ae");

is("phone: local form",       E.validatePhone("050 123 4567").value, "+971501234567");
is("phone: excel lost zero",  E.validatePhone(501234567).recovered, true);
is("phone: landline kind",    E.validatePhone("04 234 5678").kind, "landline");
is("phone: non-UAE rejected", E.validatePhone("+966501234567").ok, false);
is("phone: placeholder",      E.validatePhone("0501111111").ok, false);

/* --- csv -------------------------------------------------------------- */
is("csv: quoted comma",   E.parseCSV('a,b\n"x, y",2')[1], ["x, y","2"]);
is("csv: escaped quote",  E.parseCSV('a\n"he said ""hi"""')[1], ['he said "hi"']);
is("csv: bom stripped",   E.parseCSV('﻿Name\nx')[0], ["Name"]);

/* --- dedupe ----------------------------------------------------------- */
{
  const rows=[["A","same@x.ae","0501234901"],["B","SAME@X.AE","0501234902"]];
  const cls=E.classify(rows,1,2);
  is("dedupe: case-insensitive", [cls[0].bucket, cls[1].bucket], ["both","phone"]);
  const ctx={headers:["N","E","M"],dataRows:rows,mandatory:[],mappings:[
    {field:"Email",type:"computed",key:"email_clean"}]};
  is("dedupe: duplicate does not carry the email",
     [!!E.buildRecord(cls[0],ctx).Email, !!E.buildRecord(cls[1],ctx).Email], [true,false]);
}
{
  const rows=[["A","a@x.ae","043456789"],["B","b@x.ae","043456789"]];
  const cls=E.classify(rows,1,2);
  is("dedupe: shared landline keeps both emails",
     cls.map(r=>r.bucket), ["email","email"]);
}

/* --- field length ------------------------------------------------------ */
{
  const long="x".repeat(200);
  const rows=[[long,"l@x.ae","0501234905"]];
  const cls=E.classify(rows,1,2); const notes=[];
  const ctx={headers:["Name","E","M"],dataRows:rows,mandatory:["Last_Name"],notes,
    fieldMeta:{Last_Name:{length:80,type:"text"},Email:{length:5,type:"email"}},
    mappings:[{field:"Last_Name",type:"computed",key:"last_derived"},
              {field:"Email",type:"computed",key:"email_clean"}]};
  const rec=E.buildRecord(cls[0],ctx);
  is("length: text trimmed to limit", rec.Last_Name.length, 80);
  is("length: identifier dropped not trimmed", rec.Email, undefined);
  is("length: both reported", notes.map(n=>n.kind).sort(), ["dropped","trimmed"]);
}

/* --- batch halving ----------------------------------------------------- */
async function halving(){
  const rows=Array.from({length:100},(_,i)=>({row:i+2,poison:i===41}));
  let calls=0;
  const send=async s=>{ calls++;
    if(s.some(r=>r.poison)) throw new Error("whole request refused");
    return s.map(()=>({ok:true,id:"x"})); };
  const good=[],bad=[];
  await E.sendInHalves(rows,send,(r)=>good.push(r),(r)=>bad.push(r));
  is("halving: good rows survive a poison batch", good.length, 99);
  is("halving: only the poison row fails", bad.map(r=>r.row), [43]);
  is("halving: cost stays logarithmic", calls < 20, true);
}

module.exports = async function runUnit(){
  await halving();
  const failed = checks.filter(c => !c.ok);
  checks.forEach(c => {
    if(!c.ok) console.log(`  \x1b[31mFAIL\x1b[0m ${c.name}\n       got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`);
  });
  console.log(`  ${checks.length - failed.length}/${checks.length} unit checks passed`);
  return failed.length;
};
