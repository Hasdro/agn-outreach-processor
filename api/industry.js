import { handler, readBody, HttpError } from "./_zoho.js";

/* Guess the industry of an uploaded contact list.
 *
 * Delegates to the `send_to_gemini_standalone` Deluge function in the AGN CRM
 * org, which already holds the Gemini keys, rotates through them and falls back
 * across models. Re-implementing that here would duplicate a moving part that
 * is maintained elsewhere.
 *
 * What is sent: company names and non-free email domains only. Never a person's
 * name, address or phone number — the domain and the company are what identify
 * an industry, and the rest would leave the machine for no benefit.
 */

const INDUSTRIES = [
  "Real Estate", "Construction", "Retail & E-commerce", "Healthcare",
  "Education", "Hospitality & F&B", "Travel & Tourism", "Professional Services",
  "Financial Services", "Manufacturing", "Logistics & Transport",
  "Technology & IT", "Automotive", "Media & Marketing", "Energy & Utilities",
  "Government & Public Sector", "Non-profit", "Other"
];

/* A personal mailbox says nothing about an industry, so these are dropped
   rather than sent. */
const FREE_MAIL = new Set(["gmail.com","hotmail.com","outlook.com","yahoo.com","icloud.com",
  "live.com","aol.com","msn.com","protonmail.com","me.com","yahoo.co.uk","googlemail.com"]);

const MAX_COMPANIES = 40;
const MAX_DOMAINS   = 25;

export default handler(async (req) => {
  if(req.method !== "POST") throw new HttpError(405, "Use POST.");

  const zapikey = process.env.ZOHO_STANDALONE_ZAPIKEY;
  if(!zapikey) return { ok:false, reason:"not_configured",
    message:"Industry detection is off — set ZOHO_STANDALONE_ZAPIKEY to enable it." };

  const { companies = [], domains = [] } = readBody(req);

  const coList = [...new Set(companies.map(c => String(c||"").trim()).filter(Boolean))]
                   .slice(0, MAX_COMPANIES);
  const dmList = [...new Set(domains.map(d => String(d||"").trim().toLowerCase())
                                    .filter(d => d && !FREE_MAIL.has(d)))]
                   .slice(0, MAX_DOMAINS);

  if(!coList.length && !dmList.length)
    return { ok:false, reason:"no_signal",
             message:"No company names or business email domains to judge by." };

  const prompt =
    "These come from a single contact list, which normally targets one industry.\n" +
    "Choose the ONE industry from the allowed list that fits the majority.\n" +
    "If they clearly do not share an industry, answer \"Other\" and say so in the reason.\n" +
    "Judge only from the names and domains below; do not invent details.\n\n" +
    (coList.length ? "Companies:\n" + coList.map(c => "- " + c).join("\n") + "\n\n" : "") +
    (dmList.length ? "Email domains:\n" + dmList.map(d => "- " + d).join("\n") + "\n" : "");

  /* A schema with an enum means the answer is always one of our own options —
     no fuzzy matching of free text back onto the dropdown afterwards. */
  const params = {
    text: prompt,
    response_schema: {
      type: "OBJECT",
      properties: {
        industry:   { type:"STRING", enum: INDUSTRIES },
        confidence: { type:"STRING", enum: ["high","medium","low"] },
        reason:     { type:"STRING" }
      },
      required: ["industry","confidence","reason"]
    }
  };

  const url = "https://www.zohoapis.com/crm/v7/functions/send_to_gemini_standalone"
            + "/actions/execute?auth_type=apikey&zapikey=" + encodeURIComponent(zapikey)
            + "&params=" + encodeURIComponent(JSON.stringify(params));

  const res  = await fetch(url, { method:"POST" });
  const body = await res.json().catch(()=>null);

  /* The envelope's "code" is success whenever Zoho could REACH the function —
     not when the work succeeded. The verdict is always inside details.output.
     Trusting the envelope has shipped a silent failure in this org before. */
  const output = body?.details?.output;
  if(!output)
    return { ok:false, reason:"no_output",
             message:"The Gemini function returned nothing.", envelope: body?.code };

  let parsed;
  try{ parsed = JSON.parse(output); }
  catch{ return { ok:false, reason:"unparsable", message:"Gemini did not return JSON.",
                  raw: String(output).slice(0,200) }; }

  if(!INDUSTRIES.includes(parsed.industry))
    return { ok:false, reason:"off_list",
             message:`Gemini answered "${parsed.industry}", which is not an option.` };

  return {
    ok: true,
    industry:   parsed.industry,
    confidence: parsed.confidence || "medium",
    reason:     parsed.reason || "",
    judgedOn:   { companies: coList.length, domains: dmList.length }
  };
});
