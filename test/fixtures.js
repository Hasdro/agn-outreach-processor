/* Fixtures that exist to break the thing, not to pass.
 * Each returns { name, csv, expect } where expect states what must be true. */

const RUN = process.env.RUN_ID || "T";

module.exports = [

{ name:"plain — the happy path",
  csv:`Full Name,Email,Mobile,Company
Aya Khan,aya.${RUN}@alpha.ae,0501234801,Alpha Trading
Omar Nasser,omar.${RUN}@beta.ae,+971 55 123 4802,Beta LLC`,
  expect:{ rows:2, both:2, importable:2 } },

{ name:"quoted commas and embedded newlines",
  csv:`Name,Email,Mobile,Notes
"Khan, Aya",q1.${RUN}@x.ae,0501234803,"line one
line two"
"Nasser, Omar",q2.${RUN}@x.ae,0501234804,"has ""quotes"" inside"`,
  expect:{ rows:2, both:2, importable:2 },
  note:"a newline inside a quoted cell must not split the row" },

{ name:"Excel dropped the leading zero",
  csv:`Name,Email,Mobile
Zero One,z1.${RUN}@x.ae,501234805
Zero Two,z2.${RUN}@x.ae,502234806`,
  expect:{ rows:2, both:2, importable:2 },
  note:"a bare 9-digit number starting 5 is a mobile with the zero eaten" },

{ name:"non-UAE numbers must be rejected, never coerced",
  csv:`Name,Email,Mobile
Saudi Person,sa.${RUN}@x.ae,+966501234567
UK Person,uk.${RUN}@x.ae,+442079460958
India Person,in.${RUN}@x.ae,+919876543210`,
  expect:{ rows:3, both:0, emailOnly:3, importable:3 },
  note:"must land as email-only, with no fabricated +971 number" },

{ name:"whole office shares one landline",
  csv:`Name,Email,Mobile
A One,o1.${RUN}@x.ae,043456789
B Two,o2.${RUN}@x.ae,043456789
C Three,o3.${RUN}@x.ae,043456789
D Four,o4.${RUN}@x.ae,043456789`,
  expect:{ rows:4, emailOnly:4, neither:0, importable:4 },
  note:"the shared landline must not discard three unique emails" },

{ name:"duplicate emails inside the file",
  csv:`Name,Email,Mobile
Dup One,same.${RUN}@x.ae,0501234807
Dup Two,same.${RUN}@x.ae,0501234808
Dup Three,SAME.${RUN}@X.AE,0501234809`,
  expect:{ rows:3, importable:3 },
  note:"case-insensitive dedupe: only the first keeps the email, others keep phone" },

{ name:"unicode and Arabic names",
  csv:`Name,Email,Mobile
محمد الفلاسي,ar1.${RUN}@x.ae,0501234810
Zoë Müller-O'Brien,ar2.${RUN}@x.ae,0501234811
李 明,ar3.${RUN}@x.ae,0501234812`,
  expect:{ rows:3, both:3, importable:3 },
  note:"names must survive to the CRM unmangled" },

{ name:"apostrophe in the email local part",
  csv:`Name,Email,Mobile
O Brien,o'brien.${RUN}@x.ae,0501234813`,
  expect:{ rows:1, both:1, importable:1 },
  note:"an apostrophe must not break the COQL lookup query" },

{ name:"value longer than the CRM field allows",
  csv:`Name,Email,Mobile
${"VeryLongSurname".repeat(12)},long.${RUN}@x.ae,0501234814`,
  expect:{ rows:1, both:1, importable:1 },
  note:"Last_Name caps at 80; a 180-char name must not silently corrupt" },

{ name:"every row unusable",
  csv:`Name,Email,Mobile
No One,,
Bad One,not-an-email,12345
Junk,n/a,0000000000`,
  expect:{ rows:3, neither:3, importable:0 },
  note:"nothing to import; must not crash or send an empty batch" },

{ name:"header only, no data",
  csv:`Name,Email,Mobile`,
  expect:{ rows:0, importable:0 } },

{ name:"BOM and CRLF line endings",
  csv:`﻿Name,Email,Mobile\r\nBom One,bom.${RUN}@x.ae,0501234815\r\n`,
  expect:{ rows:1, both:1, importable:1 },
  note:"the BOM must not become part of the first header name" },

{ name:"whitespace and mixed case everywhere",
  csv:`Name,Email,Mobile
  Spacey Person  ,   WS.${RUN}@X.AE   ,  050 123 4816  `,
  expect:{ rows:1, both:1, importable:1 } },

{ name:"batch boundary — 101 rows crosses the 100 limit",
  csv:["Name,Email,Mobile"].concat(
      Array.from({length:101},(_,i)=>`P${i},b${i}.${RUN}@x.ae,05${String(51234900+i).padStart(8,"0")}`)
    ).join("\n"),
  expect:{ rows:101, importable:101 },
  note:"must split into 2 calls and import all 101" }

];
