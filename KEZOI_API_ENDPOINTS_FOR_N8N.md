# Kezoi Stays — API Endpoints for n8n and Meta WhatsApp

Verified: 10 October 2026  
Production base URL: `https://api.kezoistays.com`

This is the single API document to share with the n8n/Meta automation developer. It does not contain secrets.

## Current readiness

| API | Called by | Deployed | Tested | May be enabled now? |
|---|---|---:|---|---:|
| `POST /api/integrations/availability` | n8n | Yes | Production authenticated database read passed | Yes |
| `POST /api/integrations/enquiries` | n8n | Yes | Authentication passed; production write/idempotency pending | No |
| `GET /api/applications/properties` | Website/n8n fallback | Yes | Production HTTP 200 | Yes |
| `GET /api/applications/properties/:id/quote` | Website/n8n fallback | Yes | Production HTTP 200 | Yes |
| `GET /api/applications/properties/:id/unavailable-dates` | Website/calendar/n8n fallback | Yes | Production HTTP 200 | Yes |
| `POST /api/applications/enquiries/:id/identity-document` | Secure Kezoi website | Yes | End-to-end website upload pending | No |
| `POST /api/meta/flows/booking` | Meta directly | Yes | Crypto unit test passed; Meta configuration/round trip pending | No |
| `GET /api/meta/flows/health` | Monitoring/operator | Yes | Production HTTP 200 | Yes for monitoring |

## Authentication

The two `/api/integrations/*` endpoints require a dedicated production service credential:

```http
Authorization: Bearer <N8N_SERVICE_TOKEN>
```

Store the token in n8n Credentials as Header Auth. Never place it in a Set node, Code node, exported workflow, Meta Flow JSON, browser code, or ordinary chat.

n8n must not receive PostgreSQL credentials, `.env`, staff credentials, `JWT_SECRET`, `META_APP_SECRET`, or the Meta private key.

## 1. Live aggregate availability and quotation

Called by: n8n  
Status: deployed and verified against the production database.

```http
POST https://api.kezoistays.com/api/integrations/availability
Authorization: Bearer <N8N_SERVICE_TOKEN>
Accept: application/json
Content-Type: application/json
```

Request:

```json
{
  "check_in": "2026-11-12",
  "check_out": "2026-11-14",
  "adults": 2,
  "children": 0,
  "infants": 0,
  "pets": 0
}
```

Rules:

- Dates use `YYYY-MM-DD` and checkout must be after check-in.
- Adults must be at least 1.
- Guest and pet counts must be non-negative whole numbers.
- Capacity uses adults + children + infants.
- Pricing uses adults + children for extra-guest charges.
- Conflicts include active `HOLD`, `CONFIRMED`, and `CHECKED_IN` bookings plus property blocks.
- A successful response creates no hold.

Successful response shape:

```json
{
  "success": true,
  "quoted_at": "<ISO timestamp>",
  "hold_created": false,
  "stay": {
    "check_in": "2026-11-12",
    "check_out": "2026-11-14",
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
      "id": "1",
      "property_code": "TG-0001",
      "property_name": "Kezoi Stays Manikonda",
      "available": true,
      "quote": {
        "nights": 2,
        "base_amount": 19998,
        "extra_guests": 0,
        "extra_guest_amount": 0,
        "taxable_amount": 19998,
        "gst_rate": 18,
        "cgst_amount": 1799.82,
        "sgst_amount": 1799.82,
        "gst_amount": 3599.64,
        "total_amount": 23597.64,
        "currency": "INR",
        "price_includes_gst": false
      }
    }
  ]
}
```

The monetary values above were observed during the verified production availability test for TG-0001 and the specified two-night request.

Errors:

- `400`: invalid input
- `401`: invalid/missing service credential
- `500`: availability search failure

Retry network and 5xx failures with bounded exponential backoff. Do not retry 400 or 401 automatically.

## 2. Create WhatsApp enquiry

Called by: n8n after the completed `BOOKING_REVIEW` Flow response  
Status: deployed and protected; keep disabled until the controlled write/idempotency test and website handoff validation pass.

```http
POST https://api.kezoistays.com/api/integrations/enquiries
Authorization: Bearer <N8N_SERVICE_TOKEN>
Idempotency-Key: wa-flow:<stable-sha256-hex>
Accept: application/json
Content-Type: application/json
```

Required fields:

- `property_id`
- `check_in`
- `check_out`
- `guest_name`
- `guest_email`
- `whatsapp_number`

Optional fields:

- `country_code` (defaults to `IN`)
- `adults`
- `guests` (used when `adults` is absent)
- `children` (defaults to 0)
- `infants` (defaults to 0)
- `pets` (defaults to 0)
- `special_requests`

Copy-ready n8n body for the existing Flow:

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

Code-derived success shape for HTTP 201:

```json
{
  "success": true,
  "replayed": false,
  "enquiry": {
    "reference": "APP-<database-id>",
    "id": "<database-id>",
    "status": "NEW",
    "document_status": "PENDING"
  },
  "identity_document": {
    "required": true,
    "expires_in_seconds": 86400,
    "handoff_url": "<secure website upload URL>"
  }
}
```

This response shape is extracted from the deployed code but has not yet been captured from a production write test.

Idempotency key rules:

```regex
^[A-Za-z0-9:._-]{16,200}$
```

- Preserve `messages[0].id` from the completed Meta Flow webhook.
- Derive `wa-flow:` followed by the lowercase SHA-256 hex digest.
- Reuse the same key for every retry of the same completed submission.
- Same key + identical body returns HTTP 200 with `replayed:true`.
- Same key + changed body returns HTTP 409.

Errors:

- `400`: validation or invalid/missing idempotency key
- `401`: invalid/missing service credential
- `409`: unavailable property, duplicate submission, or key/body conflict
- `500`: enquiry creation failure

The endpoint creates a `NEW` enquiry only. It does not confirm a booking, create an order, or send a payment link.

## 3. List live properties

Called by: website or n8n fallback  
Status: deployed and verified.

```http
GET https://api.kezoistays.com/api/applications/properties
Accept: application/json
```

Authentication: none currently.

The response contains `properties[]` with property ID, code, name, type, area, city, rooms, capacity, base price, included guests, extra-guest price, and update time.

## 4. Quote one selected property

Called by: website or n8n fallback/revalidation  
Status: deployed and verified.

```http
GET https://api.kezoistays.com/api/applications/properties/{property_id}/quote
  ?check_in=YYYY-MM-DD
  &check_out=YYYY-MM-DD
  &adults=2
  &children=0
  &infants=0
  &pets=0
```

Example:

```text
https://api.kezoistays.com/api/applications/properties/1/quote?check_in=2026-11-12&check_out=2026-11-14&adults=2&children=0&infants=0&pets=0
```

A successful quote does not create a hold.

## 5. Unavailable dates

Called by: website calendar or n8n fallback  
Status: deployed and verified.

```http
GET https://api.kezoistays.com/api/applications/properties/{property_id}/unavailable-dates
Accept: application/json
```

Example:

```text
https://api.kezoistays.com/api/applications/properties/1/unavailable-dates
```

Do not use this endpoint instead of server-side availability revalidation.

## 6. Secure identity-document upload

Called by: secure Kezoi website only; never n8n  
Status: deployed; end-to-end website test pending.

```http
POST https://api.kezoistays.com/api/applications/enquiries/{enquiry_id}/identity-document
Authorization: Bearer <short-lived upload token>
Content-Type: multipart/form-data
```

Multipart fields:

- `identity_document`: one JPG, PNG, or PDF; maximum 5 MB
- `document_type`: `AADHAAR_CARD`, `PASSPORT`, or `DRIVING_LICENCE`

Responses:

- `200`: uploaded for staff review
- `400`: invalid/missing document or type
- `401`: invalid/expired upload token
- `403`: token does not authorize the URL enquiry
- `409`: document already uploaded or enquiry not found
- `413`: file exceeds 5 MB
- `500`: upload failure

n8n only forwards `identity_document.handoff_url` to the guest. It must not upload or store the document.

## 7. Meta encrypted Flow exchange

Called by: Meta directly; never a normal n8n HTTP node  
Status: deployed but not configured; Meta round-trip testing pending.

```http
POST https://api.kezoistays.com/api/meta/flows/booking
Content-Type: application/json
X-Hub-Signature-256: sha256=<Meta request signature>
```

Meta Flow ID:

```text
1149040077692619
```

The endpoint performs Meta signature validation, RSA-OAEP/SHA-256 AES-key decryption, AES-GCM request decryption, and encrypted flipped-IV responses.

The four preserved screen IDs are:

```text
BOOKING_DETAILS
PROPERTY_SELECTION
GUEST_DETAILS
BOOKING_REVIEW
```

Meta configuration and public-key registration must be completed before use. Do not send the RSA private key to n8n or Meta.

## 8. Meta adapter health

Called by: monitoring/operator  
Status: deployed and verified.

```http
GET https://api.kezoistays.com/api/meta/flows/health
```

Current verified production response:

```json
{
  "success": true,
  "service": "meta-flow-data-exchange",
  "configured": false
}
```

`configured:false` means the route is deployed but the Meta app secret/private key are not yet installed.

## Backend events sent to n8n

The backend will POST JSON to the secret `N8N_WHATSAPP_WEBHOOK_URL` after that URL is configured and event delivery is approved.

Headers:

```text
X-Kezoi-Timestamp: <Unix seconds>
X-Kezoi-Delivery-Id: <UUID>
X-Kezoi-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + raw_body)
```

Initial relevant events:

```text
BOOKING_REQUEST_RECEIVED
BOOKING_APPROVED
BOOKING_REJECTED
BOOKING_CONFIRMED
```

n8n must verify the signature against the raw request body, enforce a timestamp window, and reject duplicate delivery IDs.

## Existing n8n workflow changes

1. Add to `Edit Fields` before the original message is discarded:

   ```text
   inbound_message_id = {{ $json.messages?.[0]?.id || '' }}
   ```

2. Keep `Kezoi | Process Booking Submission` parsing `flow_response` into `booking_data`.
3. Rename disabled `Kezoi | Create Booking API` to `Kezoi | Create Enquiry API`.
4. Configure it with the endpoint, headers, body, and idempotency rules from section 2.
5. Keep it disabled until the controlled production write/replay test and website handoff validation pass.
6. Keep `Kezoi | Send Booking Confirmation`, My Bookings, and automatic payment nodes disabled.

## Prohibited endpoints and access

n8n must not use:

```text
POST /api/bookings
/api/test/whatsapp
internal payment endpoints
phone-only booking lookup
staff dashboard/internal JWT APIs
direct PostgreSQL access
identity-document filesystem/storage access
```

## Approved lifecycle

```text
WhatsApp enquiry
→ live availability and GST-inclusive quotation
→ property selection
→ one NEW enquiry
→ secure website ID-proof upload
→ staff verification and approval
→ manual payment follow-up
→ authorized booking confirmation
```

No email OTP, automatic payment request, payment link, or immediate booking confirmation is part of this integration.
