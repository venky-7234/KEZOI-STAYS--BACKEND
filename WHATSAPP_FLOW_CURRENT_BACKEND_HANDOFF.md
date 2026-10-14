# Kezoi WhatsApp Flow — Current Backend Handoff

Prepared from the current backend source and sanitized local environment configuration on 14 October 2026.

This document can be shared with the Meta WhatsApp Flow or n8n developer. It contains no credential values, private keys, database passwords, access tokens, or signed upload URLs.

## 1. Production backend

Production API base:

```text
https://api.kezoistays.com
```

Meta Flow Data Exchange endpoint:

```http
POST https://api.kezoistays.com/api/meta/flows/booking
```

Meta Flow health endpoint:

```http
GET https://api.kezoistays.com/api/meta/flows/health
```

Current Meta status reported by the owner:

```text
All five endpoint checks are green.
Meta reports: "Endpoint is active."
Do not repeat HTTP 432 troubleshooting unless the error returns.
```

Local backend port: `5000`.

Backend stack:

- Node.js and Express 5
- PostgreSQL using the `pg` driver
- CommonJS modules
- Node's built-in test runner

## 2. Current Meta Flow configuration

The existing repository handoff identifies:

```text
Meta Flow ID: 1149040077692619
Flow JSON version: 7.3
```

These values should be reconfirmed in Meta Flow Manager before changing the Flow.

Current published screen IDs:

1. `BOOKING_DETAILS`
2. `PROPERTY_SELECTION`
3. `GUEST_DETAILS`
4. `BOOKING_REVIEW`

The current completion payload uses these fields:

```json
{
  "request_type": "<value>",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",
  "guests": "<count>",
  "property": "<property-id-or-current-static-alias>",
  "guest_name": "<name>",
  "guest_email": "<email>",
  "special_requests": "<optional text>"
}
```

The current compatibility mapping is:

```text
kezoi_manikonda_3bhk -> database property ID 1
```

The future dynamic Flow should return the real backend property ID and remove this mapping.

## 3. Meta encryption implementation

The backend implements:

- `X-Hub-Signature-256` verification using HMAC-SHA256
- Signature verification against the original raw HTTP body
- RSA-OAEP decryption using SHA-256
- AES-GCM Flow-request decryption
- Flipped-IV AES-GCM response encryption
- Meta `ping` handling
- Private-key validity checks
- Public-key SHA-256 fingerprint generation

Backend environment variables:

```text
META_APP_SECRET
META_FLOW_PRIVATE_KEY
META_FLOW_PRIVATE_KEY_PASSPHRASE  # optional
```

Sanitized local configuration status:

```text
META_APP_SECRET=CONFIGURED
META_FLOW_PRIVATE_KEY=CONFIGURED
META_FLOW_PRIVATE_KEY_PASSPHRASE=NOT SET
```

The private key and app secret must never be placed in chat, documentation, Flow JSON, source control, or an n8n export. Only the corresponding public key should be registered with Meta.

## 4. What the Meta endpoint currently supports

### Health-check action

Decrypted request:

```json
{
  "action": "ping"
}
```

Encrypted response content:

```json
{
  "data": {
    "status": "active"
  }
}
```

### Initial property lookup

The only currently implemented booking exchange is:

```text
action = data_exchange
screen = BOOKING_DETAILS
```

Decrypted request:

```json
{
  "action": "data_exchange",
  "screen": "BOOKING_DETAILS",
  "data": {
    "check_in": "2026-11-01",
    "check_out": "2026-11-03",
    "guests": "2"
  }
}
```

The controller maps `guests` to adults and currently supplies zero children, infants, and pets.

Successful response content:

```json
{
  "screen": "PROPERTY_SELECTION",
  "data": {
    "check_in": "2026-11-01",
    "check_out": "2026-11-03",
    "guests": "2",
    "properties": [
      {
        "id": "<database-property-id>",
        "title": "<property-name>",
        "description": "<bedrooms> bedrooms | <bathrooms> bathrooms | INR <total>"
      }
    ],
    "quote_generated_at": "<ISO timestamp>",
    "no_properties_available": false
  }
}
```

Validation error:

```json
{
  "screen": "BOOKING_DETAILS",
  "data": {
    "error_message": "<validation error>"
  }
}
```

Unsupported action or screen:

```json
{
  "screen": "<current-screen-or-BOOKING_DETAILS>",
  "data": {
    "error_message": "Unsupported Flow action or screen"
  }
}
```

## 5. Premium Meta backend implementation

The backend now implements the complete proposed Data Exchange journey:

- Dynamic property content and an ordered, active marketing gallery
- Meta `ImageCarousel` JPEG/PNG base64 preparation with a safe payload budget
- Property-detail and per-property unavailable-date exchanges
- Adult, child, infant, and pet selection with live capacity validation
- Backend-owned quotation and GST calculation
- Guest-information validation and normalized WhatsApp numbers
- Review-screen availability and price refresh
- Transactional, idempotent pending-enquiry creation
- Expiring identity-document continuation without creating a payment or booking
- Screen-local validation errors for every proposed screen

The exact decrypted request/response contracts are in `WHATSAPP_FLOW_DATA_EXCHANGE_CONTRACTS.md`. The currently published four-screen Flow was not changed; its draft JSON must be extended and validated separately before these new screens become visible to guests.

## 6. Public property API

```http
GET https://api.kezoistays.com/api/applications/properties
```

Authentication: none currently. Responses set `Cache-Control: no-store`.

Response contract:

```json
{
  "success": true,
  "total": 1,
  "prices_refreshed_at": "<ISO timestamp>",
  "properties": [
    {
      "id": 1,
      "property_code": "TG-0001",
      "property_name": "<database value>",
      "property_type": "<database value>",
      "area": "<database value>",
      "city": "<database value>",
      "bedrooms": "<database value>",
      "bathrooms": "<database value>",
      "max_guests": "<database value>",
      "base_price": "<database value>",
      "included_guests": "<database value>",
      "extra_guest_price": "<database value>",
      "currency": "INR",
      "gst_enabled": true,
      "gst_rate": "18.00",
      "price_includes_gst": false,
      "updated_at": "<timestamp>"
    }
  ]
}
```

Only `ACTIVE` properties are returned. A previous production verification found property ID `1` with property code `TG-0001`.

### Property-data gaps

The public property endpoint does not currently return:

- Full description
- Complete address/location
- Amenities
- Cover image
- Public gallery
- Minimum-stay rules
- Maximum-stay rules
- Check-in/check-out policies

These must be added to the property data model/API or mapped from another authoritative website source.

## 7. Existing photo implementation

Authenticated operations photo routes exist:

```http
POST   /api/operations/photos
GET    /api/operations/photos/asset/:assetId
GET    /api/operations/photos/property/:propertyId
PATCH  /api/operations/photos/:id
DELETE /api/operations/photos/:id
```

Access is restricted to `SUPER_ADMIN` and `OPERATIONS`.

Photo records contain:

```json
{
  "asset_id": "<asset-id>",
  "property_id": "<property-id>",
  "image_url": "<stored URL>",
  "latitude": "<optional>",
  "longitude": "<optional>",
  "captured_at": "<timestamp>",
  "notes": "<optional>",
  "uploaded_by": "<staff-user-id>"
}
```

Property-photo results also include `asset_name`, `category`, `room_location`, and `uploaded_by_name`.

These are asset/operations photos. They are not currently exposed as a public, ordered marketing gallery and are not connected to Meta Flow. No S3, Cloudinary, or other dedicated image-storage configuration was found in the local `.env`.

A public gallery likely needs cover-image selection, display order, public/active status, captions, and Meta-compatible image data. Meta's actual `ImageCarousel` encoding and size requirements must be verified before implementation; normal image URLs must not be assumed to work.

## 8. Unavailable-date API

```http
GET https://api.kezoistays.com/api/applications/properties/{property_id}/unavailable-dates
```

Authentication: none currently.

It combines staff-created property blocks with bookings in these states:

```text
HOLD
CONFIRMED
CHECKED_IN
```

Response contract:

```json
{
  "success": true,
  "property_id": "1",
  "unavailable_dates": [
    {
      "source": "BOOKING",
      "start_date": "2026-11-01",
      "end_date": "2026-11-03",
      "availability_status": "BOOKED",
      "booking_status": "CONFIRMED",
      "payment_status": "PAID",
      "block_type": null,
      "reason": null
    }
  ],
  "blocked_dates": [
    "2026-11-01",
    "2026-11-02"
  ]
}
```

Date ranges are checkout-exclusive: the start date and dates before the end date are blocked, while the end date itself is not placed in `blocked_dates`.

## 9. Aggregate availability and quotation API

```http
POST https://api.kezoistays.com/api/integrations/availability
Authorization: Bearer <N8N_SERVICE_TOKEN>
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

- Dates use `YYYY-MM-DD`.
- Checkout must be after check-in.
- Adults must be at least one.
- All guest and pet counts must be non-negative whole numbers.
- Capacity uses adults + children + infants.
- Priced guests use adults + children.
- Only active properties are returned.
- Properties exceeding `max_guests` are excluded.
- `HOLD`, `CONFIRMED`, and `CHECKED_IN` conflicts are excluded.
- Property blocks are excluded.
- A successful call creates no hold.

Response contract:

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
      "id": 1,
      "property_code": "TG-0001",
      "property_name": "<database value>",
      "bedrooms": "<database value>",
      "bathrooms": "<database value>",
      "max_guests": "<database value>",
      "available": true,
      "quote": {
        "nights": 2,
        "base_amount": "<calculated>",
        "extra_guests": 0,
        "extra_guest_amount": 0,
        "taxable_amount": "<calculated>",
        "gst_rate": 18,
        "cgst_amount": "<calculated>",
        "sgst_amount": "<calculated>",
        "gst_amount": "<calculated>",
        "total_amount": "<calculated>",
        "currency": "INR",
        "price_includes_gst": false
      }
    }
  ]
}
```

## 10. Selected-property quotation API

GET form:

```http
GET /api/applications/properties/{property_id}/quote
  ?check_in=YYYY-MM-DD
  &check_out=YYYY-MM-DD
  &adults=2
  &children=0
  &infants=0
  &pets=0
```

POST form:

```http
POST /api/applications/quote
Content-Type: application/json
```

Example request:

```json
{
  "property_id": 1,
  "check_in": "2026-11-01",
  "check_out": "2026-11-03",
  "adults": 2,
  "children": 0,
  "infants": 0,
  "pets": 0,
  "whatsapp_number": "+91XXXXXXXXXX",
  "country_code": "IN"
}
```

The phone number is optional and is used to locate an active mobile discount.

Response contract:

```json
{
  "success": true,
  "priced_at": "<ISO timestamp>",
  "property": {
    "id": 1,
    "property_code": "TG-0001",
    "property_name": "<database value>",
    "area": "<database value>",
    "city": "<database value>",
    "status": "ACTIVE",
    "max_guests": "<database value>",
    "base_price": "<database value>",
    "included_guests": "<database value>",
    "extra_guest_price": "<database value>",
    "currency": "INR",
    "gst_enabled": true,
    "gst_rate": "18.00",
    "price_includes_gst": false,
    "updated_at": "<timestamp>"
  },
  "guests": {
    "adults": 2,
    "children": 0,
    "infants": 0,
    "pets": 0,
    "nights": 2,
    "pricedGuests": 2,
    "totalOccupants": 2
  },
  "quote": {
    "nights": 2,
    "base_price_per_night": "<database price>",
    "included_guests": "<database value>",
    "extra_guests": 0,
    "extra_guest_price_per_night": "<database value>",
    "base_amount": "<calculated>",
    "extra_guest_amount": "<calculated>",
    "original_amount": "<calculated>",
    "actual_price": "<calculated>",
    "discount_percentage": 0,
    "discount_amount": 0,
    "discount_for_you": 0,
    "taxable_amount": "<calculated>",
    "gst_rate": 18,
    "cgst_rate": 9,
    "cgst_amount": "<calculated>",
    "sgst_rate": 9,
    "sgst_amount": "<calculated>",
    "igst_rate": 0,
    "igst_amount": 0,
    "gst_amount": "<calculated>",
    "currency": "INR",
    "price_includes_gst": false,
    "final_amount": "<calculated>",
    "total_amount": "<calculated>",
    "mobile_discount_applied": false,
    "mobile_discount_offer_id": null,
    "discount_reason": null,
    "discount_valid_until": null
  }
}
```

## 11. Pricing rules

Current backend calculation:

```text
nights = check_out - check_in
base amount = property.base_price * nights
priced guests = adults + children
extra guests = max(0, priced guests - property.included_guests)
extra guest amount = extra guests * property.extra_guest_price * nights
original amount = base amount + extra guest amount
discount amount = original amount * active mobile discount percentage
taxable amount = original amount - discount amount
GST = taxable amount * property.gst_rate
final amount = taxable amount + GST
```

Database defaults introduced by migrations:

```text
included_guests: 6
extra_guest_price: 0
currency: INR
gst_enabled: true
gst_rate: 18%
price_includes_gst: false
```

GST-inclusive property pricing is currently rejected as unsupported. No separate cleaning fee, service fee, security deposit, weekend rate, or seasonal pricing was found in the quotation service. No minimum-stay or maximum-stay validation was found; any otherwise valid stay of one night or longer currently passes.

## 12. Create pending WhatsApp enquiry

```http
POST https://api.kezoistays.com/api/integrations/enquiries
Authorization: Bearer <N8N_SERVICE_TOKEN>
Idempotency-Key: <stable-key>
Content-Type: application/json
```

Required fields:

```text
property_id
check_in
check_out
guest_name
guest_email
whatsapp_number
```

Optional fields:

```text
country_code
adults
guests
children
infants
pets
special_requests
```

Example request:

```json
{
  "property_id": 1,
  "check_in": "2026-11-01",
  "check_out": "2026-11-03",
  "adults": 2,
  "children": 0,
  "infants": 0,
  "pets": 0,
  "guest_name": "Test Guest",
  "guest_email": "test@example.com",
  "whatsapp_number": "+91XXXXXXXXXX",
  "country_code": "IN",
  "special_requests": "Optional request"
}
```

The idempotency key must match:

```regex
^[A-Za-z0-9:._-]{16,200}$
```

Before writing, the backend validates the stay, email, and phone; opens a transaction; checks idempotency; acquires a property-specific advisory transaction lock; rechecks availability; recalculates the quote; creates or reuses the guest; and creates one enquiry.

Created enquiries use:

```text
source: WHATSAPP
status: NEW
document_verification_status: PENDING
```

Success response:

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
    "handoff_url": "<website-url>?enquiry=<id>&upload_token=<signed-token>"
  }
}
```

An identical replay returns the original enquiry with `replayed: true`. This API creates an enquiry, not a confirmed booking or payment.

## 13. Identity-document requirement

```http
POST /api/applications/enquiries/{enquiry_id}/identity-document
Authorization: Bearer <upload-token>
Content-Type: multipart/form-data
```

Multipart fields:

- `identity_document`
- `document_type`

Supported document types:

- `AADHAAR_CARD`
- `PASSPORT`
- `DRIVING_LICENCE`

Supported files are JPG, PNG, and PDF, with a maximum size of 5 MB. The upload token lasts 24 hours.

The handoff URL currently falls back to `https://www.kezoistays.com` when `WEBSITE_APPLICATION_URL` is not configured.

## 14. Payment status

The repository has authenticated internal payment-management routes:

```http
POST  /api/payments
GET   /api/payments
GET   /api/payments/:id
PATCH /api/payments/:id/status
```

Supported statuses:

```text
PENDING
PAID
FAILED
REFUNDED
PARTIALLY_REFUNDED
```

These are staff-authenticated internal routes, not the guest-facing WhatsApp payment integration. The payment creation route defaults to `PAID` when `payment_status` is omitted, so it must not be called by the Flow without a real, verified gateway result.

Until payment integration exists:

- WhatsApp must create only a pending enquiry.
- “Continue to Payment” must not claim payment was completed.
- Payment screenshots must not be treated as verified payments.
- No confirmed reservation should be created automatically.

## 15. n8n authentication and configuration

Integration routes require:

```http
Authorization: Bearer <N8N_SERVICE_TOKEN>
```

The backend assigns these service scopes:

```text
availability:read
enquiries:create
```

Sanitized local `.env` status:

```text
N8N_SERVICE_TOKEN=NOT SET
N8N_WHATSAPP_WEBHOOK_URL=NOT SET
N8N_WEBHOOK_SIGNING_SECRET=NOT SET
WEBSITE_APPLICATION_URL=NOT SET
```

These must be provisioned securely in the actual deployment environment. Values must not be sent through ordinary chat or placed in exported workflow JSON.

## 16. Other environment configuration

Configured locally, with values intentionally redacted:

```text
DB_HOST=CONFIGURED
DB_PORT=CONFIGURED
DB_NAME=CONFIGURED
DB_USER=CONFIGURED
DB_PASSWORD=CONFIGURED
JWT_SECRET=CONFIGURED
INITIAL_ADMIN_PASSWORD=CONFIGURED
RESEND_API_KEY=CONFIGURED
CHECK_MAIL_API_KEY=CONFIGURED
META_APP_SECRET=CONFIGURED
META_FLOW_PRIVATE_KEY=CONFIGURED
```

Safe non-secret values:

```text
PORT=5000
MAIL_FROM=Kezoi Stays <contact@kezoistays.com>
EMAIL_FROM=Kezoi Stays <contact@kezoistays.com>
```

Not explicitly configured locally:

```text
DEFAULT_GST_RATE
DEFAULT_CURRENCY
```

The code falls back to GST rate `18` and currency `INR`.

## 17. Test status

The complete local test suite was run on 14 October 2026:

```text
29 tests passed
0 failed
```

Covered:

- Date and guest-count validation
- Current Flow `guests` mapping
- Enquiry lifecycle protections
- Identity-verification requirements
- GST, discount, and extra-guest calculations
- GST-disabled property calculation
- Meta signature verification
- Meta request decryption and encrypted response generation

Also covered:

- Complete eight-screen backend journey
- Real backend responses passed through RSA-OAEP/AES-GCM request and response envelopes
- Blocked-date and changed-capacity rejection
- Stable non-PII Flow-token idempotency
- Secure-continuation configuration failure before database writes
- WebP-to-JPEG conversion within the three-image data-channel budget

Not currently covered:

- Database-backed property/gallery retrieval
- Database-backed availability queries
- Database enquiry creation and idempotency
- Real Meta encrypted round trips
- Meta client rendering of `ImageCarousel`
- n8n webhook integration
- Identity upload end to end
- Production payment integration

## 18. Required remaining work

1. **Implemented locally:** dynamic property details, ordered gallery, image conversion, calendar exchange, property selection, guest validation, live quote/GST, guest details, review refresh, idempotent pending enquiry, safe identity-document continuation, and encrypted tests for every requesting screen.
2. **Deployment pending:** run `npm run migrate:whatsapp-flow-content`, deploy the backend, and populate each active property's public content and gallery in the intended environment.
3. **Configuration pending:** set and verify `WEBSITE_APPLICATION_URL` and the required service configuration in the deployment environment without exposing secrets.
4. **Meta verification pending:** confirm the active Flow ID, Flow JSON version, Data API version, endpoint binding, and client-side `ImageCarousel`/calendar rendering.
5. **Owner approval pending:** update and publish the Flow JSON only after explicit approval. The existing published Flow remains unchanged.
6. **Payment gateway unsupported:** the safe continuation is currently identity-document upload. It deliberately does not claim payment, call the internal payment API, or confirm a booking.

## 19. Required target journey

```text
Explore Properties
-> Photo Gallery
-> Property Details
-> Reserve
-> Live Calendar
-> Select Guests
-> Live Quote
-> Guest Details
-> Booking Review
-> Continue to Payment
```

The website backend must remain the single source of truth. Property information, photographs, availability, capacity, prices, fees, GST, and final amounts must not be duplicated or calculated independently in Flow JSON or n8n.
## 20. Security and release constraints

- Do not share `.env` values, credentials, private keys, passwords, access tokens, or signed upload URLs.
- Do not give n8n direct PostgreSQL or staff-dashboard access.
- Do not create a separate WhatsApp property database.
- Do not duplicate pricing or availability calculations in n8n.
- Do not alter or republish the existing Meta Flow without owner approval.
- Do not create a confirmed reservation before payment/approval requirements are met.
- Clearly label every handoff item as implemented, tested, pending, or unsupported.
