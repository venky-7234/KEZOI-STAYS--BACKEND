# Kezoi premium WhatsApp Flow — developer handover

Prepared: 14 October 2026. This is the primary handover index. It contains every confirmed non-secret value available in the repository and identifies values that must be retrieved from Meta or the production secret store. Do not substitute guessed values.

## 1. Confirmed production identifiers

| Item | Exact value |
|---|---|
| API base URL | `https://api.kezoistays.com` |
| Flow Data Exchange URL | `https://api.kezoistays.com/api/meta/flows/booking` |
| Flow health URL | `https://api.kezoistays.com/api/meta/flows/health` |
| Meta Flow ID reported by owner | `1149040077692619` |
| Reported Flow JSON version | `7.3` |
| Backend currency | `INR` |
| Default GST rate | `18` |
| Backend local port | `5000` |
| Existing property content import key | `TG-0001` |
| Existing property database ID previously verified | `1` |

The Meta Data API version is **not present in the repository and is not confirmed**. Retrieve it from Flow Manager or query Flow ID `1149040077692619` for `data_api_version`. Do not infer it from Flow JSON version `7.3`.

## 2. Published Flow versus proposed journey

The reported currently published screen IDs are exactly:

1. `BOOKING_DETAILS`
2. `PROPERTY_SELECTION`
3. `GUEST_DETAILS`
4. `BOOKING_REVIEW`

The backend supports this proposed eight-exchange journey:

| Request screen | Successful response screen |
|---|---|
| `BOOKING_DETAILS` | `PROPERTY_SELECTION` |
| `PROPERTY_SELECTION` | `PROPERTY_DETAILS` |
| `PROPERTY_DETAILS` | `CALENDAR` |
| `CALENDAR` | `GUEST_SELECTION` |
| `GUEST_SELECTION` | `LIVE_QUOTE` |
| `LIVE_QUOTE` | `GUEST_DETAILS` |
| `GUEST_DETAILS` | `BOOKING_REVIEW` |
| `BOOKING_REVIEW` | `ENQUIRY_CREATED` |

The published Flow has not been edited. `PROPERTY_DETAILS`, `CALENDAR`, `GUEST_SELECTION`, `LIVE_QUOTE`, and `ENQUIRY_CREATED` require a draft Flow update and Meta validation before the premium journey is visible to users.

There is currently **no Flow JSON export in this repository**. The developer must obtain the complete current JSON export for Flow ID `1149040077692619` before editing. Preserve the published Flow and work on a draft or clone until owner approval.

## 3. Exact Data Exchange protocol

HTTP request:

```http
POST /api/meta/flows/booking
Content-Type: application/json
X-Hub-Signature-256: sha256=<HMAC-SHA256 of the exact raw request body>
```

Encrypted request envelope:

```json
{
  "encrypted_aes_key": "<base64>",
  "encrypted_flow_data": "<base64 ciphertext followed by 16-byte GCM tag>",
  "initial_vector": "<base64>"
}
```

Crypto parameters implemented by the backend:

- RSA-OAEP with SHA-256 decrypts `encrypted_aes_key`.
- AES-GCM decrypts `encrypted_flow_data`.
- The response uses AES-GCM with every IV byte bitwise flipped.
- A successful response is `HTTP 200`, `text/plain`, containing base64 ciphertext.
- A signature failure is `HTTP 432`, `text/plain`, body `Invalid signature`.
- An unhandled decrypt/processing failure is `HTTP 500`, `text/plain`, body `Unable to process encrypted Flow request`.

Health endpoint:

```http
GET /api/meta/flows/health
```

Required healthy fields:

```json
{
  "success": true,
  "service": "meta-flow-data-exchange",
  "configured": true,
  "appSecretConfigured": true,
  "privateKeyConfigured": true,
  "privateKeyValid": true,
  "publicKeyFingerprint": "<64 lowercase hexadecimal characters>"
}
```

The complete decrypted request and response bodies for every screen are in `WHATSAPP_FLOW_DATA_EXCHANGE_CONTRACTS.md`. Those field names and response screen IDs are the backend contract and must be used exactly.

## 4. Exact shared field rules

| Field | Type sent by Flow | Rule |
|---|---|---|
| `flow_token` | string, top-level Meta field | Required on final submission; hashed into the idempotency key |
| `property_id` | string | Real PostgreSQL property ID, e.g. `"1"` |
| `check_in` | `YYYY-MM-DD` string | Inclusive arrival date |
| `check_out` | `YYYY-MM-DD` string | Exclusive departure date; must be after check-in |
| `guests` | whole-number string or number | Existing `BOOKING_DETAILS` compatibility field; mapped to adults |
| `adults` | whole-number string or number | Minimum `1` |
| `children` | whole-number string or number | Minimum `0` |
| `infants` | whole-number string or number | Minimum `0` |
| `pets` | whole-number string or number | Minimum `0` |
| `guest_name` | non-empty string | Required before review/finalization |
| `guest_email` | string | Must pass backend email-format validation |
| `whatsapp_number` | string | Validated and normalized by `libphonenumber-js` |
| `country_code` | string | Defaults to `IN` |
| `special_requests` | string | Optional |

Capacity is `adults + children + infants`. Priced guests are `adults + children`. Pets are recorded but are not included in the current capacity or extra-guest calculation.

A screen validation error stays on the same screen:

```json
{
  "screen": "<requesting screen ID>",
  "data": { "error_message": "<backend message>" }
}
```

## 5. Backend source of truth

The Flow or n8n must not calculate or hardcode property data, images, availability, capacity, prices, discounts, GST, or totals.

Authoritative implementation:

- Flow orchestration: `src/services/metaFlowBooking.service.js`
- Availability and base quotation: `src/services/availability.service.js`
- Encryption/signature handling: `src/services/metaFlowCrypto.service.js`
- HTTP controller: `src/controllers/metaFlow.controller.js`
- Ordered marketing gallery admin: `src/controllers/assetPhoto.controller.js`
- Image download/conversion: `src/services/metaImage.service.js`
- Property content migration: `migrations/008_whatsapp_flow_property_content.sql`
- Idempotency migration: `migrations/006_whatsapp_integration.sql`

Unavailable dates combine `property_blocks` with bookings whose `booking_status` is one of:

```text
HOLD
CONFIRMED
CHECKED_IN
```

Checkout is exclusive and remains selectable.

## 6. ImageCarousel contract

The response field is exactly:

```json
{
  "gallery": [
    { "src": "<raw JPEG/PNG base64 without a data URI prefix>", "alt-text": "<accessibility text>" }
  ]
}
```

Rules implemented:

- Maximum three returned images.
- Order: `is_cover DESC`, then `display_order`, then database `id`.
- Only `is_active = TRUE` images are returned.
- Runtime URLs are not returned to Meta.
- URL imports allow HTTPS only and the default approved host is `vioraelite.s3.eu-north-1.amazonaws.com`.
- URL-derived WebP/JPEG/PNG images are converted to JPEG.
- Safe derived-image budget is `240 KB` per image.

Admin endpoints require a staff JWT and role `SUPER_ADMIN` or `OPERATIONS`:

```http
POST  /api/operations/photos/marketing
GET   /api/operations/photos/marketing/property/{propertyId}
PATCH /api/operations/photos/marketing/{photoId}
```

Admin create body:

```json
{
  "property_id": 1,
  "image_url": "https://vioraelite.s3.eu-north-1.amazonaws.com/<exact-object-key>",
  "alt_text": "Living room with seating and access to the private balcony",
  "caption": "Living room",
  "display_order": 0,
  "is_cover": true,
  "is_active": true
}
```

`meta_image_base64` can be supplied instead of `image_url`, but it must decode to JPEG or PNG and remain within the 240 KB budget.

## 7. Exact TG-0001 content import

The prepared source file is `imports/tg0001-flow-content.json`. It contains:

- `property_code`: `TG-0001`
- `property_name`: `Kezoi Stays Manikonda`
- Public location: `Kezoi Stays, Flat 1002, 10th Floor, E-Block, Manikonda, Gandipet Mandal, Ranga Reddy District, Telangana 500089, India`
- 44 public amenities
- Seven ordered S3/WebP gallery sources
- Gallery item `display_order = 0` as the cover

The Flow returns only the first three active ordered gallery records. Use the JSON file for the exact description, amenity list, URLs, captions, ordering, and alt text; do not recopy them manually.

## 8. Exact pricing behavior

```text
nights = check_out - check_in
base_amount = base_price × nights
priced_guests = adults + children
extra_guests = max(0, priced_guests - included_guests)
extra_guest_amount = extra_guests × extra_guest_price × nights
original_amount = base_amount + extra_guest_amount
taxable_amount = original_amount - discount_amount
GST = taxable_amount × property GST rate
total_amount = taxable_amount + GST
```

All property price inputs and GST settings are read from PostgreSQL for every live quote. The Flow backend currently applies no mobile discount before guest phone details are supplied. It does not support GST-inclusive property pricing.

## 9. Exact finalization behavior

On `BOOKING_REVIEW`, the backend:

1. requires the Meta `flow_token`;
2. derives `meta-flow:<64-character SHA-256>` as the idempotency key;
3. validates name, email, and WhatsApp number;
4. starts a database transaction;
5. checks for an existing idempotent enquiry;
6. takes a property advisory transaction lock;
7. rechecks capacity and availability;
8. recalculates price and GST;
9. creates or reuses the guest;
10. creates one `WHATSAPP` enquiry with status `NEW` and document status `PENDING`;
11. returns an expiring identity-document handoff URL.

Exact success response:

```json
{
  "screen": "ENQUIRY_CREATED",
  "data": {
    "enquiry_reference": "APP-<database ID>",
    "enquiry_status": "NEW",
    "payment_status": "NOT_STARTED",
    "continuation_type": "IDENTITY_DOCUMENT_UPLOAD",
    "continuation_url": "<WEBSITE_APPLICATION_URL>?enquiry=<ID>&upload_token=<signed JWT>",
    "replayed": false,
    "message": "Enquiry created. No booking or payment has been confirmed."
  }
}
```

The upload JWT expires after exactly `24h`. The continuation is not a payment confirmation. No booking, hold, or payment record is created.

Identity upload endpoint:

```http
POST /api/applications/enquiries/{enquiry_id}/identity-document
Authorization: Bearer <upload_token from encrypted Flow response>
Content-Type: multipart/form-data
```

Multipart fields are `identity_document` and `document_type`. Allowed document types are `AADHAAR_CARD`, `PASSPORT`, and `DRIVING_LICENCE`. Allowed files are JPG, PNG, and PDF, maximum 5 MB.

## 10. Required deployment configuration

Set these in the backend deployment secret/environment store:

```text
PORT=5000
DEFAULT_CURRENCY=INR
DEFAULT_GST_RATE=18
PROPERTY_IMAGE_HOSTS=vioraelite.s3.eu-north-1.amazonaws.com
WEBSITE_APPLICATION_URL=https://<exact secure website upload page>
META_APP_SECRET=<secret>
META_FLOW_PRIVATE_KEY=<PEM private key, with real newlines or escaped \n>
META_FLOW_PRIVATE_KEY_PASSPHRASE=<secret only when the key is encrypted>
JWT_SECRET=<secret>
DB_HOST=<secret/config>
DB_PORT=5432
DB_NAME=<secret/config>
DB_USER=<secret>
DB_PASSWORD=<secret>
```

`WEBSITE_APPLICATION_URL` is not configured in the inspected local environment; code currently falls back to `https://www.kezoistays.com`. The deployment owner must supply the exact upload-page URL before production smoke testing.

Never place these values in this handover, chat, Flow JSON, n8n workflow JSON, screenshots, or source control:

- `META_APP_SECRET`
- `META_FLOW_PRIVATE_KEY`
- private-key passphrase
- `JWT_SECRET`
- database password
- n8n service token
- staff passwords or JWTs
- generated `upload_token` URLs

Transfer them using the deployment platform's secret manager or another approved secure channel.

## 11. Exact deployment commands

Run from the backend repository root in the intended environment:

```powershell
npm ci
npm run migrate:whatsapp-integration
npm run migrate:whatsapp-flow-content
npm run import:property-flow-content -- imports/tg0001-flow-content.json
npm test
npm run check
npm start
```

Before running the import, confirm that property code `TG-0001` exists in that environment. The import replaces the marketing gallery for that property inside one transaction.

Post-deployment checks:

```http
GET https://api.kezoistays.com/
GET https://api.kezoistays.com/api/meta/flows/health
```

Expected root message: `Kezoi Stays backend is running`.

Expected Flow health:

```text
configured=true
appSecretConfigured=true
privateKeyConfigured=true
privateKeyValid=true
publicKeyFingerprint=<matches the public key registered with Meta>
```

Then execute one encrypted test journey through all eight request screens against the deployed endpoint. Do not send plaintext screen payloads to the HTTP endpoint.

## 12. Current verification results

Local verification on 14 October 2026:

```text
29 tests passed
0 tests failed
npm run check passed
additional syntax checks passed
git diff --check passed
```

Coverage includes all eight screen transitions, live validation, quote/GST, idempotent pending enquiry creation, Meta signature verification, request/response encryption, and gallery conversion.

Not yet performed:

- production migration or import;
- production deployment;
- encrypted production smoke journey;
- Meta Flow JSON validation;
- Meta client rendering test;
- owner-approved Flow publication;
- payment-gateway integration.

## 13. Inputs the next developer must obtain

1. Complete current JSON export for Flow `1149040077692619`.
2. Confirmed Meta `data_api_version`.
3. Confirmation that Flow JSON version is still `7.3`.
4. Exact production `WEBSITE_APPLICATION_URL` upload page.
5. Secure deployment and secret-store access.
6. Confirmation that the registered public key fingerprint matches `/api/meta/flows/health`.
7. Owner approval to modify and publish the Flow.
8. A payment-gateway specification if “Continue to Payment” must become a real payment action.

## 14. Files to hand over

```text
WHATSAPP_FLOW_DEVELOPER_HANDOVER.md
WHATSAPP_FLOW_DATA_EXCHANGE_CONTRACTS.md
WHATSAPP_FLOW_CURRENT_BACKEND_HANDOFF.md
imports/tg0001-flow-content.json
migrations/006_whatsapp_integration.sql
migrations/008_whatsapp_flow_property_content.sql
scripts/migrate-whatsapp-integration.js
scripts/migrate-whatsapp-flow-content.js
scripts/import-property-flow-content.js
src/controllers/metaFlow.controller.js
src/controllers/assetPhoto.controller.js
src/services/metaFlowCrypto.service.js
src/services/metaFlowBooking.service.js
src/services/metaImage.service.js
src/services/availability.service.js
test/metaFlowBooking.test.js
test/metaFlowCrypto.test.js
test/metaImage.test.js
```

Treat `WHATSAPP_FLOW_DATA_EXCHANGE_CONTRACTS.md` as the exact UI/backend binding contract and this document as the deployment and ownership checklist.
