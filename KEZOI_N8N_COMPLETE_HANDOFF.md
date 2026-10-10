# Kezoi Stays — Complete n8n and Meta WhatsApp Integration Handoff

Prepared and verified from the backend source, sanitized n8n workflow, published Meta Flow JSON, and safe production HTTP checks on 10 October 2026.

Production API base: `https://api.kezoistays.com`

This is the single document to share with the n8n/Meta automation developer.

## 1. Non-negotiable booking lifecycle

```text
WhatsApp enquiry
→ live availability and quotation
→ property selection
→ one NEW enquiry
→ secure Kezoi website identity-document upload
→ staff document verification and approval
→ manual payment follow-up
→ authorized booking confirmation
```

- An enquiry is not a confirmed booking.
- Payment remains manual.
- No automatic payment link or automatic confirmation is approved.
- Mandatory identity-document requirements cannot be bypassed.
- Email OTP and My Bookings are not part of this integration.
- n8n must use APIs, not PostgreSQL or staff dashboard credentials.

## 2. Verified readiness

| API | Local implementation | Production verification | Test evidence | Intended caller |
|---|---|---|---|---|
| `GET /api/applications/properties` | Existing | Live; HTTP 200 | Safe live GET passed | Website/n8n |
| `GET /api/applications/properties/:id/quote` | Existing | Live; HTTP 200 | Safe live GET passed for property 1 | Website/n8n fallback |
| `GET /api/applications/properties/:id/unavailable-dates` | Existing | Live; HTTP 200 | Safe live GET passed for property 1 | Website/calendar |
| `POST /api/integrations/availability` | Implemented | Deployed; unauthenticated request returned 401 | Authenticated production DB read returned 200 with one live property and GST quote | n8n |
| `POST /api/integrations/enquiries` | Implemented | Deployed; unauthenticated request returned 401 | Authentication boundary tested; production write/idempotency not yet tested | n8n |
| `POST /api/applications/enquiries/:id/identity-document` | Implemented | Deployed with backend release | No end-to-end website/upload test | Secure website |
| `POST /api/meta/flows/booking` | Implemented | Deployed, but Meta secrets are not configured | Crypto unit test passed; no Meta round trip | Meta directly |
| `GET /api/meta/flows/health` | Implemented | Deployed; HTTP 200 | Production response verified with `configured:false` | Operator/Meta setup |

Verification on 10 October 2026: 8 tests passed in the production image, 0 failed; JavaScript syntax checks passed. Production migrations `005` and `006` were applied after a verified custom-format PostgreSQL backup. An authenticated production availability read returned TG-0001 for a two-night stay with INR 19,998 taxable value, INR 3,599.64 GST at 18%, and INR 23,597.64 total. Enquiry writes, document upload, and Meta round trips remain untested.

The owner selected a production-only rollout. No separate test database is required. Before enabling the writer, back up production, deploy the migrations/code, and create one clearly identified controlled test enquiry through the API.

## 3. Correct integration architecture

| System | Responsibility | API |
|---|---|---|
| Meta WhatsApp Flow | Dynamic screen data: dates, live availability, actual quote, property options | `POST /api/meta/flows/booking` encrypted data exchange |
| Existing n8n workflow | Consume completed Flow response and create exactly one enquiry | `POST /api/integrations/enquiries` |
| n8n fallback/non-Flow conversation | Search all available properties when Meta data exchange is not being used | `POST /api/integrations/availability` |
| Secure Kezoi website | Upload the mandatory identity document using the short-lived token | `POST /api/applications/enquiries/:id/identity-document` |
| Backend | Send signed lifecycle events to n8n | n8n-provided webhook URL |

Meta data exchange must not create an enquiry during screen navigation. Meta can repeat requests and guests can go backward. n8n creates the enquiry only after the `BOOKING_REVIEW` completion payload arrives.

## 4. Existing live read-only APIs

### List properties

```http
GET https://api.kezoistays.com/api/applications/properties
Accept: application/json
```

Authentication: none currently. Production verification returned TG-0001/property ID `1`.

### Quote and validate one property

```http
GET https://api.kezoistays.com/api/applications/properties/{property_id}/quote
  ?check_in=YYYY-MM-DD
  &check_out=YYYY-MM-DD
  &adults=2
  &children=0
  &infants=0
  &pets=0
```

A successful quote does not create a hold or enquiry.

### Unavailable dates

```http
GET https://api.kezoistays.com/api/applications/properties/{property_id}/unavailable-dates
```

This is useful for a calendar but is not a substitute for write-time availability revalidation.

## 5. Dedicated n8n service authentication

After deployment, both `/api/integrations/*` endpoints require:

```http
Authorization: Bearer <N8N_SERVICE_TOKEN>
```

The backend reads `N8N_SERVICE_TOKEN` from its production secret environment and compares it with a timing-safe comparison. Provision a long random value in the deployment platform; store the same value in n8n Credentials as Header Auth.

Never place the token in exported workflow JSON, Meta Flow JSON, browser code, a Set node, or a Code node. Do not give n8n PostgreSQL credentials, `.env`, staff JWT/login credentials, or the Meta private key.

## 6. Aggregate availability API

Deployed and authenticated against the production database:

```http
POST https://api.kezoistays.com/api/integrations/availability
Authorization: Bearer <N8N_SERVICE_TOKEN>
Accept: application/json
Content-Type: application/json
```

Request:

```json
{
  "check_in": "2026-11-01",
  "check_out": "2026-11-03",
  "adults": 2,
  "children": 0,
  "infants": 0,
  "pets": 0
}
```

Rules:

- Dates use `YYYY-MM-DD`; checkout must be after check-in.
- Adults must be at least 1.
- All guest/pet counts must be non-negative whole numbers.
- Capacity uses adults + children + infants.
- Conflicts include active `HOLD`, `CONFIRMED`, and `CHECKED_IN` bookings plus property blocks.
- A successful response creates no hold.

Code-derived 200 shape:

```json
{
  "success": true,
  "quoted_at": "<ISO timestamp>",
  "hold_created": false,
  "stay": {
    "check_in": "2026-11-01",
    "check_out": "2026-11-03",
    "adults": 2,
    "children": 0,
    "infants": 0,
    "pets": 0,
    "nights": 2,
    "total_occupants": 2,
    "priced_guests": 2
  },
  "properties": [
    {
      "id": "<property id>",
      "property_code": "<code>",
      "property_name": "<name>",
      "available": true,
      "quote": {
        "nights": 2,
        "base_amount": 0,
        "extra_guests": 0,
        "extra_guest_amount": 0,
        "taxable_amount": 0,
        "gst_rate": 18,
        "cgst_amount": 0,
        "sgst_amount": 0,
        "gst_amount": 0,
        "total_amount": 0,
        "currency": "INR",
        "price_includes_gst": false
      }
    }
  ]
}
```

Implemented application errors: 400 invalid input, 401 invalid service credential, 500 search failure.

## 7. Create enquiry API — exact contract

Deployed; keep the n8n writer disabled until the controlled enquiry/idempotency test and website-handoff validation pass:

```http
POST https://api.kezoistays.com/api/integrations/enquiries
Authorization: Bearer <N8N_SERVICE_TOKEN>
Idempotency-Key: <stable-key>
Accept: application/json
Content-Type: application/json
```

### Request fields

| Field | Required | Current code contract |
|---|---:|---|
| `property_id` | Yes | Database property ID, numeric or numeric string |
| `check_in` | Yes | `YYYY-MM-DD` |
| `check_out` | Yes | `YYYY-MM-DD`, later than check-in |
| `guest_name` | Yes | Non-empty string |
| `guest_email` | Yes | Valid email; stored lower-case |
| `whatsapp_number` | Yes | Valid phone; normalized by backend |
| `country_code` | No | Defaults to `IN` |
| `adults` | No | At least 1; if absent, backend uses `guests`, then 1 |
| `guests` | No | Compatibility field from current Flow |
| `children` | No | Non-negative integer; default 0 |
| `infants` | No | Non-negative integer; default 0 |
| `pets` | No | Non-negative integer; default 0 |
| `special_requests` | No | Stored as enquiry guest message |

Copy-ready n8n JSON body for the current Flow:

```json
{
  "property_id": "={{ $json.booking_data.property === 'kezoi_manikonda_3bhk' ? 1 : Number($json.booking_data.property) }}",
  "check_in": "={{ $json.booking_data.check_in }}",
  "check_out": "={{ $json.booking_data.check_out }}",
  "guests": "={{ $json.booking_data.guests }}",
  "children": 0,
  "infants": 0,
  "pets": 0,
  "guest_name": "={{ $json.booking_data.guest_name }}",
  "guest_email": "={{ $json.booking_data.guest_email }}",
  "whatsapp_number": "={{ $json.guest_phone }}",
  "country_code": "IN",
  "special_requests": "={{ $json.booking_data.special_requests || '' }}"
}
```

The static Flow alias `kezoi_manikonda_3bhk` represents backend property ID `1`. The approved future dynamic Flow will return the real property ID and remove this compatibility mapping.

### Successful response

New enquiry: HTTP 201. Identical replay: HTTP 200 with `replayed: true`.

```json
{
  "success": true,
  "replayed": false,
  "enquiry": {
    "reference": "APP-<database-enquiry-id>",
    "id": "<database-enquiry-id>",
    "status": "NEW",
    "document_status": "PENDING"
  },
  "identity_document": {
    "required": true,
    "expires_in_seconds": 86400,
    "handoff_url": "<WEBSITE_APPLICATION_URL>?enquiry=<id>&upload_token=<signed-JWT>"
  }
}
```

This shape is extracted from the response builder; it is not yet an observed production write response. The handoff URL is returned immediately after the transaction commits. n8n sends it to the guest without parsing or logging the token.

### Idempotency

The key is mandatory and must match:

```regex
^[A-Za-z0-9:._-]{16,200}$
```

- Same key + same request hash: original enquiry returned, `replayed: true`.
- Same key + different request: HTTP 409.
- Migration `006` adds a unique partial index.
- A PostgreSQL transaction advisory lock serializes submissions for the same property while availability is rechecked.

Preserve the completed-Flow Meta message ID before the existing Edit Fields node discards it:

```text
inbound_message_id = {{ $json.messages?.[0]?.id || '' }}
```

Use a deterministic SHA-256 digest so unsupported characters in raw Meta IDs cannot violate the header whitelist:

```text
wa-flow:<64 lowercase SHA-256 hex characters>
```

Reuse the same key on every retry. Never generate a new UUID for a retry.

### Implemented errors

```json
HTTP 400: {"success":false,"message":"A valid Idempotency-Key header is required"}
HTTP 401: {"success":false,"message":"Invalid service credential"}
HTTP 409: {"success":false,"message":"Idempotency key was already used for a different request"}
HTTP 409: {"success":false,"message":"Property is not available for the selected stay"}
HTTP 409: {"success":false,"message":"Duplicate enquiry submission"}
HTTP 500: {"success":false,"message":"Unable to create enquiry"}
```

Other HTTP 400 responses cover missing fields, dates/counts, phone, email, and availability input validation. HTTP 422 and 429 are not emitted by this application route. Infrastructure could independently return 429, but it is not part of the current controller contract.

## 8. Secure identity-document handoff

n8n sends the returned handoff URL to the guest. The URL opens `WEBSITE_APPLICATION_URL` with `enquiry` and `upload_token` query parameters. The website extracts those values and submits:

```http
POST https://api.kezoistays.com/api/applications/enquiries/{id}/identity-document
Authorization: Bearer <upload_token>
Content-Type: multipart/form-data
```

Multipart fields:

- `identity_document`: exactly one JPG, PNG, or PDF; maximum 5 MB.
- `document_type`: `AADHAAR_CARD`, `PASSPORT`, or `DRIVING_LICENCE`.

The signed token lasts 24 hours and contains the purpose, enquiry ID, and guest ID. The backend verifies that the token authorizes the URL enquiry. Success sets document status to `PENDING` for staff review.

Responses: 200 uploaded, 400 invalid document/type, 401 expired/invalid token, 403 wrong enquiry, 409 already uploaded/not found, 413 too large, 500 failure.

## 9. Meta encrypted Flow data exchange

Meta—not n8n—calls:

```http
POST https://api.kezoistays.com/api/meta/flows/booking
```

Health after deployment:

```http
GET https://api.kezoistays.com/api/meta/flows/health
```

Backend secrets:

- `META_APP_SECRET`
- `META_FLOW_PRIVATE_KEY`
- Optional `META_FLOW_PRIVATE_KEY_PASSPHRASE`

Only the corresponding public key is registered with Meta. The backend verifies `X-Hub-Signature-256`, decrypts the AES key using RSA-OAEP/SHA-256, decrypts Flow data using AES-GCM, and returns a flipped-IV AES-GCM encrypted response.

The current published Flow ID is `1149040077692619`, version 7.3, with screens:

1. `BOOKING_DETAILS`
2. `PROPERTY_SELECTION`
3. `GUEST_DETAILS`
4. `BOOKING_REVIEW`

Required draft upgrade:

- Replace the `BOOKING_DETAILS` footer `navigate` action with `data_exchange`.
- Send `check_in`, `check_out`, and `guests`.
- Add `properties`, `quote_generated_at`, `no_properties_available`, and `error_message` to `PROPERTY_SELECTION` data.
- Bind the radio-group data source to `${data.properties}`.
- Each property option ID must be the backend property ID string.
- Display the returned quotation in property options/review.
- Keep final `complete` payload fields: `request_type`, `check_in`, `check_out`, `guests`, `property`, `guest_name`, `guest_email`, `special_requests`.

Do not modify or republish the existing Flow without owner approval and a successful encrypted production endpoint test.

## 10. Exact n8n workflow changes

### `Edit Fields` — modify

Keep existing fields and add:

```text
inbound_message_id = {{ $json.messages?.[0]?.id || '' }}
```

Existing verified fields:

```text
guest_phone = {{ $json.messages?.[0]?.from || '' }}
flow_response = {{ JSON.stringify($json.messages?.[0]?.interactive?.nfm_reply?.response_json ?? {}) }}
```

### `Kezoi | Process Booking Submission` — keep

It currently parses:

```text
booking_data = {{ JSON.parse($json.flow_response || '{}') }}
```

### `Kezoi | Validate Booking` — keep

It confirms `booking_data` is non-empty. Additional required-field checks may be added before enabling the writer.

### `Kezoi | Create Booking API` — rename and modify

Rename to `Kezoi | Create Enquiry API`. Remove the old nested `guest_phone`/`booking_data` parameters.

- Method: `POST`
- URL: `https://api.kezoistays.com/api/integrations/enquiries`
- Authentication: n8n Header Auth credential
- Headers: `Accept: application/json`, `Content-Type: application/json`, `Idempotency-Key: <derived stable key>`
- Body: exact JSON from section 7
- Keep disabled until deployment and the controlled live test pass

Retry only network errors, HTTP 429 from infrastructure, and HTTP 5xx, with bounded exponential backoff and the unchanged idempotency key. Do not retry 400/401/403/409 blindly.

On HTTP 201 or replayed HTTP 200, send `identity_document.handoff_url` as an identity-upload request. Do not call it a confirmation.

### Existing quote node

Keep selected-property quote validation where useful, but remove fixed test dates and hard-coded values. Do not duplicate the availability call after Meta already returned current property options unless revalidation is required.

### Nodes that remain disabled

- `Kezoi | Send Booking Confirmation`
- `Kezoi | Fetch My Bookings`
- Automatic payment nodes
- Any node that calls internal `POST /api/bookings`

### Existing event workflow corrections

- Remove erroneous switch literal `BOOKING_REQUEST_RECEIVED 6.`; keep `BOOKING_REQUEST_RECEIVED`.
- Validate webhook HMAC before routing.
- Deduplicate `eventId` atomically; current lookup-then-insert handling is race-prone.
- Do not infer confirmation from enquiry receipt, staff approval, or payment follow-up.

## 11. Signed backend events to n8n

The backend calls the secret `N8N_WHATSAPP_WEBHOOK_URL` with JSON and:

```text
X-Kezoi-Timestamp: <Unix seconds>
X-Kezoi-Delivery-Id: <UUID>
X-Kezoi-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + raw_body)
```

The JSON includes `eventVersion: "1.0"`, `eventId`, `occurredAt`, `event`, and available booking/enquiry fields. Retries reuse the same timestamp, body, signature, and delivery ID. The backend tries up to three times and retries HTTP 429/5xx/network failures.

n8n must verify the signature against the untouched raw body, enforce a timestamp window, compare signatures safely, and reject repeated delivery IDs atomically.

Supported code-level events include:

```text
BOOKING_REQUEST_RECEIVED
BOOKING_APPROVED
BOOKING_REJECTED
PAYMENT_LINK_CREATED
PAYMENT_SUCCESS
PAYMENT_FAILED
BOOKING_CONFIRMED
CHECKIN_REMINDER
CHECKOUT_REMINDER
TEST_MESSAGE
```

Payment events are not enabled for the current manual-payment lifecycle.

## 12. Credentials and ownership

Backend production secrets:

```text
N8N_SERVICE_TOKEN
N8N_WHATSAPP_WEBHOOK_URL
N8N_WEBHOOK_SIGNING_SECRET
WEBSITE_APPLICATION_URL
JWT_SECRET
META_APP_SECRET
META_FLOW_PRIVATE_KEY
META_FLOW_PRIVATE_KEY_PASSPHRASE (only if needed)
```

n8n team provides:

- Production inbound webhook URL.
- Confirmation of raw-body signature-verification support.
- Meta WhatsApp Cloud API credentials under their control.
- Sanitized workflow export after configuration.

Backend owner provides through secure secret channels:

- Production API base URL.
- Dedicated n8n service token.
- Matching webhook signing secret.
- Approved website application URL.

Secrets must not be sent in ordinary chat, committed to Git, or embedded in exported workflows.

## 13. Production deployment checklist

The repository has no committed Render, Railway, Docker, GitHub Actions, PM2, or equivalent deployment configuration. The operator who currently deploys `api.kezoistays.com` must perform this release.

1. Take a recoverable production PostgreSQL backup.
2. Configure all required secrets.
3. Apply `migrations/005_gst_pricing.sql`.
4. Apply `migrations/006_whatsapp_integration.sql`.
5. Deploy the updated backend code.
6. Verify `GET /api/meta/flows/health`.
7. Verify unauthenticated integration calls return 401, not 404.
8. Verify authenticated aggregate availability against live properties.
9. Create one clearly identified controlled test enquiry with a stable idempotency key.
10. Replay the identical request and confirm `replayed: true` without a duplicate row.
11. Reuse the key with a changed body and confirm HTTP 409.
12. Test the website document upload using a non-customer test document.
13. Verify staff approval still requires document status `VERIFIED`.
14. Verify a signed `BOOKING_REQUEST_RECEIVED` event reaches n8n once.
15. Keep payment and automatic confirmation disabled.
16. Enable `Kezoi | Create Enquiry API` only after the controlled test succeeds.

## 14. Current go-live boundary

Available immediately:

- Live property list.
- Live selected-property quote.
- Live unavailable-date calendar.
- Offline n8n node configuration in disabled state.

Deployed but still awaiting integration/configuration tests:

- Enquiry creation write and idempotent replay.
- Secure identity-upload website handoff.
- Meta encrypted data exchange and registered RSA public key.
- Signed backend events and n8n signature verification.

Do not give n8n direct database or internal dashboard access. The deployed restricted APIs provide the live data it needs while preserving the approved booking lifecycle.
