# Kezoi Stays — Verified Backend/n8n Integration Handoff

Prepared: 2026-10-10. Base URL after deployment: `https://api.kezoistays.com`.

## Status legend

- **Implemented + unit tested:** source exists and isolated tests pass.
- **Implemented, DB untested:** requires migrations and `.env.test`.
- **Existing + deployed:** previously verified against production.
- **Pending deployment:** not available at the production URL yet.
- **Blocked by approval:** no implementation performed.

## A. Backend audit and compatibility

Existing deployed public APIs remain `GET /api/applications/properties`, `GET /api/applications/properties/:id/quote`, and `GET /api/applications/properties/:id/unavailable-dates`. The supplied Flow 7.3 is published, static, and uses `check_in`, `check_out`, `guests`, `property`, `guest_name`, `guest_email`, and `special_requests`. Its property alias `kezoi_manikonda_3bhk` represents backend property ID `1`; n8n must map it to `1` until an approved dynamic Flow version is published.

The supplied n8n workflow has 28 nodes. Its booking writer, confirmation, My Bookings, staff notification, and event-template nodes are disabled. They must remain disabled until the applicable contracts are deployed and tested.

## B. Implemented backend changes

1. `POST /api/integrations/availability`: aggregate live availability, capacity validation and GST-aware quotes. **Implemented, DB untested; pending deployment.**
2. `POST /api/integrations/enquiries`: service-authenticated, idempotent `NEW` WhatsApp enquiry with availability revalidation and a secure document-upload handoff. **Implemented, DB untested; pending deployment.**
3. `POST /api/applications/enquiries/:id/identity-document`: one-enquiry, expiring JWT-authorized multipart upload. **Implemented, DB untested; pending deployment.**
4. Approval now requires an uploaded document already marked `VERIFIED`; approval no longer manufactures verification. **Implemented, DB untested; pending deployment.**
5. Signed outbound n8n events with event version, stable delivery ID across retries, timestamp, HMAC-SHA256, and three bounded attempts. **Implemented + syntax checked; delivery untested.**
6. `POST /api/meta/flows/booking`: signature validation, RSA-OAEP/SHA-256 request-key decryption, AES-GCM request decryption and flipped-IV encrypted response. **Implemented + crypto unit tested; Meta/staging untested.**
7. `GET /api/meta/flows/health`: reports adapter readiness without returning secrets. **Implemented; pending deployment.**
8. GST migration/calculation: INR, 18% exclusive, discount before GST, taxable extra guests, CGST 9% and SGST 9%. **Implemented + unit tested; migration pending.**

Migrations must run in order: `005_gst_pricing.sql`, then `006_whatsapp_integration.sql`. Eight isolated tests pass; syntax and diff checks pass. No DB migration was executed.

## C. n8n API contracts

### Aggregate availability

```http
POST /api/integrations/availability
Authorization: Bearer <N8N_SERVICE_TOKEN>
Content-Type: application/json
```

```json
{"check_in":"2026-11-01","check_out":"2026-11-03","adults":2,"children":0,"infants":0,"pets":0}
```

200 returns `success`, `quoted_at`, `hold_created:false`, normalized `stay`, and `properties[]`. Each property includes actual property fields and `quote` with `base_amount`, `extra_guest_amount`, `taxable_amount`, GST breakdown, `total_amount`, `currency`, and `price_includes_gst:false`. Errors: 400 invalid input, 401 invalid service token, 500 internal failure. A 200 creates no hold.

### Create WhatsApp enquiry

```http
POST /api/integrations/enquiries
Authorization: Bearer <N8N_SERVICE_TOKEN>
Idempotency-Key: wa-flow:<stable-token-or-message-id>:<submission-id>
Content-Type: application/json
```

```json
{
  "property_id": 1,
  "check_in": "2026-11-01",
  "check_out": "2026-11-03",
  "guests": 2,
  "children": 0,
  "infants": 0,
  "pets": 0,
  "guest_name": "Test Guest",
  "guest_email": "guest@example.invalid",
  "whatsapp_number": "+919999999999",
  "special_requests": ""
}
```

201 is a new enquiry; 200 is an identical idempotent replay. Response contains `enquiry.reference` (`APP-<id>`), `status:NEW`, `document_status:PENDING`, and an expiring `identity_document.handoff_url`. Errors: 400 validation/missing key, 401 service auth, 409 unavailable/idempotency conflict/duplicate, 500 failure. n8n must never log the handoff URL or upload token.

### Identity document upload

```http
POST /api/applications/enquiries/:id/identity-document
Authorization: Bearer <upload token from handoff URL>
Content-Type: multipart/form-data
```

Fields: `document_type` (`AADHAAR_CARD`, `PASSPORT`, or `DRIVING_LICENCE`) and `identity_document` (JPG, PNG, PDF; maximum 5 MB). Returns 200/PENDING, 400 invalid document, 401/403 token failure, 409 already uploaded, or 413 too large.

## D. Meta Flow data exchange

Proposed endpoint after deployment: `POST https://api.kezoistays.com/api/meta/flows/booking`. Health: `GET /api/meta/flows/health`. Required secrets: `META_APP_SECRET`, `META_FLOW_PRIVATE_KEY`, and optional `META_FLOW_PRIVATE_KEY_PASSPHRASE`. Register only the corresponding public key in Meta.

The current published JSON cannot call the endpoint. An owner-approved next Flow version must replace the `BOOKING_DETAILS` footer `navigate` action with `data_exchange`, sending `check_in`, `check_out`, and `guests`. `PROPERTY_SELECTION.data` must add `properties` as an array of `{id,title,description}`, `quote_generated_at` string, `no_properties_available` boolean, and `error_message` string; its radio-group `data-source` must become `${data.properties}`. The backend response navigates to `PROPERTY_SELECTION`. Property IDs returned are real backend IDs, so the completion payload's `property` becomes directly usable.

Do not modify or republish Flow `1149040077692619` until Meta endpoint staging tests and owner approval are complete.

## E. Signed booking events

Headers:

```text
X-Kezoi-Timestamp: Unix seconds
X-Kezoi-Delivery-Id: UUID
X-Kezoi-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + raw_body)
```

Body adds `eventVersion:"1.0"`, `eventId` (same UUID), and `occurredAt`, while preserving `event`, `phone`, `name`, `bookingReference`, `propertyId`, `propertyName`, `checkIn`, `checkOut`, `guestsCount`, and applicable optional fields. Retries reuse the exact body, timestamp, signature and delivery ID. n8n must verify against the raw body, enforce a timestamp window, and atomically reject repeated delivery IDs.

## F. Exact n8n changes

1. **Kezoi | Get Property Quote:** keep for selected-property revalidation but replace fixed property `1` and fixed dates with Flow expressions.
2. **HTTP Request** property-list test node: no longer needed in the live branch after dynamic Flow deployment; do not delete until staging acceptance.
3. **Kezoi | Create Booking API:** keep disabled. Clone/reconfigure only after deployment as `POST /api/integrations/enquiries`; add Header Auth credential and stable `Idempotency-Key`; send the JSON contract above.
4. **Kezoi | Send Booking Confirmation:** keep disabled.
5. **Kezoi | Fetch My Bookings:** keep disabled; it has no URL and contains the incorrect key `guest_phone ` with trailing space.
6. **Kezoi | Receive Booking Events:** change authentication processing to verify HMAC on the raw body before `Kezoi | Validate Booking Event`.
7. **Kezoi | Route Booking Events:** remove the erroneous literal `BOOKING_REQUEST_RECEIVED 6.` rule; retain `BOOKING_REQUEST_RECEIVED`.
8. **Kezoi | Check Duplicate Event / Record Booking Event:** enforce an atomic unique `event_id`; update PROCESSING to COMPLETED/FAILED and permit controlled recovery. Current lookup-then-insert is race-prone.
9. Preserve the same idempotency key for 429/5xx retries. Never retry 400/401/403/409 blindly.
10. Send the secure identity handoff URL to the guest after enquiry creation, without persistent execution logging.

## G. My Bookings decision required

No My Bookings backend was implemented. Email OTP is not approved and phone-only lookup is prohibited.

Owner choices: (1) signed WhatsApp-session challenge bound to Meta `wa_id`—lowest guest friction but requires verified webhook identity and session issuance; (2) booking-reference plus a second secret delivered through an independently verified channel—moderate friction; (3) staff-mediated lookup—highest manual effort but simplest initial security. Approve one before implementation.

## H. Pending checklist

- Backend: populate `.env.test`, run both migrations on the test DB, execute DB integration/concurrency tests, configure secrets, stage, then deploy.
- Meta administrator: register public key, configure endpoint, test encrypted health/data exchange, review and publish the revised Flow only after approval.
- n8n team: install service/signing credentials, make node changes above, add atomic replay handling, and run staging scenarios.
- Frontend: consume `enquiry` and `upload_token` query parameters and submit multipart upload to the documented endpoint without logging the token.
- Owner: choose My Bookings verification and authorize final Flow publication/deployment.
- Payment remains manual; no automated payment or confirmation was added.
