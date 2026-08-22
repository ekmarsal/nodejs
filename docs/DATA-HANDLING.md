# Data handling, disclosures, and obligations

Reference notes for the FareHarbor → Postgres pipeline. **This is
engineering documentation, not legal advice.** Have counsel review the
policy language before publishing anything customer-facing.

---

## 1. What role does USA Guided Tours play?

Under GDPR terms, USAGT is the **controller** of booking data: we decide
why it is collected and what happens to it. FareHarbor is a **processor**
acting on our instructions. Once this webhook copies data into our own
Postgres, that copy is entirely ours — FareHarbor's policies, security
certifications, and retention schedule stop applying to it.

That distinction is the core compliance point. Everything below follows
from it.

Under US state law (CCPA/CPRA, Virginia, Colorado, Connecticut, and the
newer state acts) USAGT is the **business**. Any vendor we forward this
data to — Railway, n8n, HubSpot, Zapier, an LLM provider — is a **service
provider** only if a contract says so. Without that contract term, sharing
can be construed as a "sale" or "share," which triggers opt-out rights.

## 2. What personal data flows through this webhook

| Category | Field | Sensitivity |
|---|---|---|
| Identity | `contact.name` | Personal data |
| Contact | `contact.email`, `contact.phone` | Personal data; the breach-notification trigger in most US states when combined with other identifiers |
| Transaction | amount, tour, date, pax count | Personal data; also commercially confidential |
| Free text | `note` / special requests | **Unbounded** — customers write allergies, medical conditions, mobility needs here |
| Custom fields | `custom_field_values` | **Unbounded** — same risk, plus DOB or ID numbers if a tour collects them |
| Payment | `payments[]` metadata | Card brand/last-four is PCI-scoped data |

The two unbounded categories are the real exposure. A customer typing
"wheelchair user, insulin-dependent" into a booking note turns an ordinary
booking record into GDPR Article 9 special-category data and health
information under several US state laws. Nobody plans for this; it just
arrives.

**How this repo handles it:** `lib/redact.js` strips payment instrument
fields unconditionally, and masks custom-field answers whose label matches
a health/dietary/accessibility/ID pattern, before any write to Postgres.
Set `REDACT_ALL_CUSTOM_FIELDS=true` to mask every custom-field answer.

**What it does not handle:** the `note` field is still stored verbatim in
`bookings.special_requests`, because operations legitimately needs it to
run the tour. Treat that column as the most sensitive in the database.

## 3. Which laws actually apply

- **CCPA/CPRA (California).** Applies at $25M+ revenue, or 100k+ CA
  consumers/households, or 50%+ revenue from selling personal data. A DC
  and NYC tour operator may fall under the thresholds — but the safest
  position is to operate as if it applies, since the required disclosures
  are ones a reputable business wants anyway.
- **GDPR/UK GDPR.** Applies because USAGT markets tours to EU/UK visitors
  and takes their bookings. Offering services to people in the EU is the
  trigger; having no EU establishment does not exempt us. Article 27 may
  require an EU representative.
- **State breach-notification laws.** All 50 states. Name + email or phone
  is generally enough to trigger notification duties.
- **PCI DSS.** Card data is handled inside FareHarbor, so USAGT is likely
  SAQ-A. Storing card metadata in our own database would expand that scope,
  which is why the redaction layer strips it.
- **ADA / accessibility notes** are health-adjacent; handle with the same
  care as medical data.

## 4. Disclosures and policies needed

**Privacy policy (public, on usaguidedtours.com).** Must state, in plain
language:
1. Categories of personal data collected and the purposes for each.
2. That booking data is received from FareHarbor and **stored in USAGT's
   own systems** for reporting and analytics. This is the sentence most
   tour operators are missing — customers are told about the booking
   platform but not about the operator's own copy.
3. Legal basis for each purpose (contract performance for fulfilling the
   booking; legitimate interests or consent for marketing and analytics).
4. Retention periods, stated as concrete durations.
5. Third parties the data is disclosed to, by category: hosting (Railway),
   automation (n8n, Zapier), CRM (HubSpot), advertising (TikTok Events API,
   Meta, Google), and **AI/LLM providers** if the ideas in section 7 ship.
6. Data-subject rights and how to exercise them, with a working contact.
7. For CCPA: a "Do Not Sell or Share My Personal Information" link if
   booking data is forwarded to ad platforms for audience matching.

**A note on advertising pixels.** The TikTok Events API integration sends
hashed customer identifiers to TikTok for conversion matching. Under CCPA
this is generally a "share" for cross-context behavioral advertising and
requires an opt-out mechanism; under GDPR it needs consent collected before
the data is sent. This is the most common enforcement gap for tourism
businesses and worth resolving deliberately.

**Booking-flow notice.** A short link to the privacy policy at the point of
booking, plus separate, unticked consent for marketing email. A booking is
not consent to be marketed to.

**Internal documents** (not published, but expected if regulators ask):
- Record of Processing Activities (GDPR Art. 30) — one page listing each
  system, what it holds, why, and for how long.
- Data Processing Agreements with every vendor that touches this data.
  Railway, HubSpot, and Zapier all publish standard DPAs; they must be
  signed, not merely available. If an LLM provider is added, its DPA must
  include a no-training-on-our-data commitment.
- Incident response plan with the 72-hour GDPR notification clock and
  state-law timelines.
- Access register: who can read the Postgres database and the Railway logs,
  reviewed quarterly.

## 5. Retention

| Data | Retention | Rationale |
|---|---|---|
| `webhook_events.raw_payload` | 90 days (`EVENT_RETENTION_DAYS`) | Debugging and replay only |
| `bookings` (identified) | 7 years | Tax and accounting records |
| `bookings` (contact fields) | Pseudonymize at 24–36 months post-tour | Marketing value decays; risk does not |
| `customers` | Until erasure request or 36 months inactive | |
| Railway application logs | Align to 90 days | Currently outside this codebase's control |

The revenue history should outlive the personal data attached to it. That
is what the erasure endpoint below implements.

## 6. Handling data-subject requests

Two authenticated endpoints make this routine rather than a manual
database edit. Both require `Authorization: Bearer $ADMIN_API_TOKEN`.

**Access request (GDPR Art. 15, CPRA 1798.110):**

```
GET /privacy/subject?email=customer@example.com
```

Returns the customer record and every booking held for that address.

**Erasure request (GDPR Art. 17, CPRA 1798.105):**

```
POST /privacy/erase
Content-Type: application/json
{"email": "customer@example.com"}
```

Pseudonymizes rather than deletes: name becomes `ERASED`, phone and free
text are cleared, the raw payload archive is nulled, and the email is
replaced with a deterministic tombstone. Booking amounts, dates, tours, and
source attribution survive, so revenue reporting stays correct and the same
person cannot be silently re-identified by a later booking.

**Important:** this only covers the systems in this repository. A complete
erasure must also run against FareHarbor, HubSpot, any n8n-held copies, and
email marketing platforms. Keep a written checklist; the request clock is
30 days under CCPA and one month under GDPR.

## 7. Before adding AI to this pipeline

If booking data is fed to an LLM for the reporting and automation ideas
under discussion, three things must be true first:

1. **A no-training commitment in writing.** Anthropic and OpenAI's business
   and enterprise API tiers do not train on API inputs by default; consumer
   tiers may. Use the API tier, and keep the DPA on file.
2. **Aggregate, don't ship raw rows.** Almost every reporting use case is
   satisfied by counts, sums, and averages. Send `SELECT booking_source,
   COUNT(*), SUM(amount) ... GROUP BY`, not customer rows. Where per-booking
   text is genuinely needed (review analysis, note triage), strip the
   contact fields first — `lib/redact.js` gives you the pattern.
3. **Disclose it.** Add automated analysis to the privacy policy's purposes
   list. If any AI output influences a decision about an individual —
   pricing, refusal, refund — GDPR Art. 22 becomes relevant and a human must
   remain in the loop.

Prompts and completions are also a data-egress path that no firewall sees.
Treat "what gets pasted into a prompt" as a disclosure decision, not a
developer convenience.
