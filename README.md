# AGN Outreach Processor

Upload a contact spreadsheet, validate it, see how the contacts route across email
and WhatsApp, and import them into Zoho CRM.

## Running it

    npx vercel dev

Validation alone works by opening `public/index.html` directly — no server needed.
The CRM import needs the serverless functions, so it needs `vercel dev` locally or a
Vercel deployment.

## Layout

    public/index.html   the whole front end: parsing, validation, slicing, import UI
    api/_zoho.js        token handling and the CRM request wrapper
    api/fields.js       live module + field schemas, fetched fresh every call
    api/tags.js         creates a tag on a module if it does not already exist
    api/import.js       one batch of records, with per-record results

**Credentials live only in the serverless functions.** The browser never receives the
refresh token, the client secret, or an access token — it only talks to `/api/*`.
Copy `.env.example` to `.env.local` for local work, and set the same names in the
Vercel dashboard for deployment.

## How it works

Everything runs in the browser — **no contact data leaves the machine.** The file is
parsed locally, validated in 500-row chunks, and bucketed into three outreach channels:

| Channel | Rule | Action |
|---|---|---|
| **Email only** | valid email, no valid mobile | Email sequence |
| **Phone only** | valid mobile, no valid email | WhatsApp flow |
| **Both** | valid email *and* valid mobile | Both in parallel, WhatsApp following up 24h after an unopened email |

Anything with neither is skipped and listed with a plain-English reason, exportable as CSV.

Supports `.xlsx`, `.xls` and `.csv`, up to 10,000 rows. `.csv` works with no network at
all; `.xlsx` needs [SheetJS](https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js)
from the CDN.

Drop `sample-contacts.csv` on it to try it — 604 rows that should bucket as
**121 email only / 62 phone only / 361 both**, with **60 skipped**.

The tile denominator is the *routable* count, not the row count, so the three tiles
always sum to it (121 + 62 + 361 = 544). The line underneath reconciles that back to
the file: 544 ready to send + 60 skipped = 604 rows.

## Validation rules

**Email**
- Syntax: one `@`, local part ≤64, domain ≤255, no leading/trailing/consecutive dots,
  alphabetic TLD of 2+ characters (so `name@company.c` and `x@y.123` fail)
- Placeholders rejected: `n/a`, `none`, `test@test.com`, `abc@abc.com`, …
- Disposable domains rejected: mailinator, yopmail, guerrillamail, …
- Typo detection by Damerau-Levenshtein distance against common domains, so a
  transposition like `gmial.com` is caught and offered as a one-click fix
- **Role accounts (`info@`, `sales@`) count as valid** and are flagged in the export

**Phone — UAE only**
- Normalised with the house rule: strip non-digits → strip `00971` / `0971` / `971` /
  `00` / `0` → prefix `+971`
- Mobile: 9 digits, `5[024568]` + 7 — the only form that qualifies for the phone channel
- Landline: 8 digits, area code `[234679]` + 7 — **valid, but never routed to WhatsApp**
- Excel drops the leading zero from a phone cell; a bare 9-digit number starting `5` is
  detected and restored
- Placeholder runs (`0501111111`, `0000000000`) rejected
- Non-UAE numbers are **rejected, not coerced** — a `+966` or `+44` number fails rather
  than being mangled into a fake UAE number

**Dedupe** is per channel and case-insensitive. A duplicate phone suppresses only the
phone channel, never the email — whole offices share one landline, and discarding the
row would throw away every good address behind it.

## Known limitation

A browser cannot do DNS, so there is **no MX lookup**: a well-formed address on a dead
domain passes validation and will bounce on send. Closing that gap needs a server-side
version (Zoho Catalyst or Creator). Mailbox-level verification (ZeroBounce and similar)
is deliberately out of scope.
