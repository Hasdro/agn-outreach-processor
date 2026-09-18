import { handler, readBody, HttpError } from "./_zoho.js";

/* Map the file's own industry column onto one of our flow options.
 *
 * The file already states the industry; it just states it in its own words —
 * "Property Development", "Real-estate brokerage", "RE" — which will not match
 * a fixed dropdown. So the distinct values from that column are handed to the
 * `send_to_gemini_standalone` function in the AGN CRM org, which already holds
 * the Gemini keys, rotates them and falls back across models.
 *
 * Nothing else is sent. Not names, not emails, not phone numbers, not company
 * names — the industry column is the whole signal.
 */

const INDUSTRIES = [
  "Real Estate", "Construction", "Retail & E-commerce", "Healthcare",
  "Education", "Hospitality & F&B", "Travel & Tourism", "Professional Services",
  "Financial Services", "Manufacturing", "Logistics & Transport",
  "Technology & IT", "Automotive", "Media & Marketing", "Energy & Utilities",
  "Government & Public Sector", "Non-profit", "Other"
];

const MAX_VALUES = 40;

export default handler(async (req) => {
  if(req.method !== "POST") throw new HttpError(405, "Use POST.");

  const zapikey = process.env.ZOHO_STANDALONE_ZAPIKEY;
  if(!zapikey) return { ok:false, reason:"not_configured",
    message:"Industry detection is off — set ZOHO_STANDALONE_ZAPIKEY to enable it." };

  const { values = [] } = readBody(req);

  /* Count the distinct spellings so the prompt can say which dominates — a
     file with 900 "Real Estate" rows and 3 "Construction" ones targets real
     estate, and the majority should not be a coin toss. */
  const tally = new Map();
  for(const v of values){
    const k = String(v||"").trim();
    if(!k) continue;
    tally.set(k, (tally.get(k)||0) + 1);
  }
  if(!tally.size)
    return { ok:false, reason:"no_signal",
             message:"The industry column is empty." };

  const ranked = [...tally.entries()].sort((a,b) => b[1]-a[1]).slice(0, MAX_VALUES);

  /* If the column already says exactly what the dropdown says, there is nothing
     to interpret — answer without a round trip, and without the values leaving
     the machine at all. */
  const top = ranked[0][0];
  const exact = INDUSTRIES.find(i => i.toLowerCase() === top.toLowerCase());
  if(exact && ranked.length === 1)
    return { ok:true, industry:exact, confidence:"high",
             reason:"The industry column already matches this option exactly.",
             judgedOn:{ values: tally.size, matched:"exact" } };

  const total = [...tally.values()].reduce((a,b)=>a+b, 0);
  const prompt =
    "A contact list has an industry column. These are its distinct values with " +
    "how many rows carry each, most common first.\n" +
    "Map the list to the ONE industry from the allowed list that fits the " +
    "majority of rows.\n" +
    "The wording will not match the allowed list exactly — interpret it.\n" +
    "If the values genuinely span unrelated industries, answer \"Other\" and say so.\n\n" +
    ranked.map(([v,n]) => `- ${v} (${n} row${n===1?"":"s"})`).join("\n") +
    `\n\nTotal rows with a value: ${total}.`;

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
    judgedOn:   { values: tally.size, matched:"interpreted" }
  };
});
