# Kezoi Stays — n8n Technical Handoff

Prepared: 2026-10-10  
Production API base: `https://api.kezoistays.com`

## Current integration boundary

The backend is online. n8n may safely use the existing public read-only property and quote APIs described below. Do not call the internal booking/payment writers from the WhatsApp workflow yet. There is no approved My Bookings API or Meta WhatsApp Flow encrypted data-exchange endpoint.

The supported business sequence remains: request/enquiry → internal review/approval → payment → reservation confirmation. The existing application submission route creates an enquiry, but it requires a multipart identity document; the exact WhatsApp request-creation path still needs a product decision.

## Node 1 — list active properties

- n8n node: HTTP Request
- Method: `GET`
- URL: `https://api.kezoistays.com/api/applications/properties`
- Authentication: None
- Header: `Accept: application/json`
- Expected HTTP status: 200
- Read: `{{$json.properties}}`

After GST migration `005_gst_pricing.sql` is deployed, each property also supplies `currency`, `gst_enabled`, `gst_rate`, and `price_includes_gst`. It still does not supply description, amenities, images, or a Kezoi booking URL.

On non-200, retry only transient 5xx/network failures with bounded exponential backoff. Do not retry 4xx responses.

## Node 2 — validate a selected property and calculate quote

- n8n node: HTTP Request
- Method: `GET`
- URL expression: `https://api.kezoistays.com/api/applications/properties/{{$json.property_id}}/quote`
- Authentication: None
- Query parameters:
  - `check_in`: `YYYY-MM-DD`
  - `check_out`: `YYYY-MM-DD`
  - `adults`: integer, minimum 1
  - `children`: non-negative integer
  - `infants`: non-negative integer (optional; default 0)
  - `pets`: non-negative integer (optional; default 0)
- Header: `Accept: application/json`
- Expected 200 response keys: `property`, `guests`, `quote`. After GST migration, `quote.total_amount` is the GST-inclusive amount payable and the quote includes `taxable_amount`, `gst_rate`, `cgst_rate`, `cgst_amount`, `sgst_rate`, `sgst_amount`, `igst_rate`, `igst_amount`, `gst_amount`, `currency`, and `price_includes_gst`.

TG-0001 is configured for GST-exclusive pricing at 18%. Discounts reduce the taxable amount before GST, and extra-guest charges are taxable. n8n must display the backend values and must not add or recalculate GST.

Do not treat quote success as a hold. Availability can change and must be revalidated by the eventual write path.

Handle statuses as follows:

- 400: show the backend validation message and return to date/guest entry.
- 404: selected property no longer exists; refresh property choices.
- 409: property inactive or unavailable; refresh choices and ask the guest to select again.
- 500/network: generic temporary error; bounded retry, then human/fallback path.

## Optional node — unavailable calendar for one property

- Method: `GET`
- URL: `https://api.kezoistays.com/api/applications/properties/{{$json.property_id}}/unavailable-dates`
- Authentication: None
- Expected 200 keys: `unavailable_dates`, `blocked_dates`

This is useful for a calendar UI but is not a substitute for quote/write-time revalidation. Unknown property IDs are not currently distinguished from properties with no blocked dates.

## Existing outbound events from backend to n8n

The backend posts JSON to the secret `N8N_WHATSAPP_WEBHOOK_URL`. Possible event names are:

`BOOKING_REQUEST_RECEIVED`, `BOOKING_APPROVED`, `BOOKING_REJECTED`, `PAYMENT_LINK_CREATED`, `PAYMENT_SUCCESS`, `PAYMENT_FAILED`, `BOOKING_CONFIRMED`, `CHECKIN_REMINDER`, `CHECKOUT_REMINDER`, `TEST_MESSAGE`.

Possible payload fields are `event`, `phone`, `name`, `bookingReference`, `propertyId`, `propertyName`, `checkIn`, `checkOut`, `guestsCount`, `amount`, `paymentLink`, `paymentStatus`, `status`, `message`, and `rejectionReason`; null/undefined fields are omitted.

Current security limitation: there is no signature or Authorization header. Until webhook signing is implemented, use an unguessable n8n production webhook URL, store it only in backend secrets, restrict execution visibility, and validate event names and field types in n8n. Do not consider the webhook URL alone a durable authentication design.

## Do not configure yet

- Do not use `POST /api/bookings`: it is an internal JWT route, lacks idempotency and concurrency protection, and currently creates `CONFIRMED`/`PENDING` records.
- Do not use internal staff login credentials as n8n service credentials.
- Do not query bookings by phone number. Phone possession is not currently verified.
- Do not call `/api/test/whatsapp` from production workflows; it is an unauthenticated diagnostic route.
- Do not call internal payment status endpoints from Meta/n8n; Cashfree webhook verification is not implemented here.

## Pending backend contracts

No URL or response shape is assigned until implementation is approved:

1. Aggregate availability search for check-in, check-out and total guests, returning only eligible dynamic property options.
2. Public/service property details with description, amenities, gallery, currency and Kezoi URL.
3. Verified guest session/OTP plus guest-owned My Bookings.
4. Idempotent booking-request/enquiry creation that preserves internal approval and payment order.
5. Prefilled website redirect contract, if redirect is selected instead of API creation.
6. Guest cancellation/modification, if policy permits.
7. Meta WhatsApp Flow encrypted data exchange for Flow `1149040077692619`, screen `BOOKING_DETAILS`.

## Meta Flow handoff

An ordinary n8n HTTP call to the quote API cannot serve as Meta's encrypted Flow data exchange. Backend work is required first: private-key secret configuration, corresponding Meta public-key registration, envelope decryption, action/screen validation, shared availability lookup, dynamic option mapping, encrypted response generation, and error/health handling.

The Flow JSON will need a data-exchange action after dates/guest count and a dynamic property selector populated from the decrypted backend response. Coordinate the exact payload/navigation schema with the backend implementer. Do not publish or alter the current Flow without owner approval.

## Credentials

Currently needed in n8n:

- The production inbound webhook credential/URL used by backend outbound events.
- Meta WhatsApp Cloud API credentials managed by the automation team.

Not yet available:

- A dedicated Kezoi backend service credential for n8n.
- A backend-to-n8n webhook signing secret.
- A Meta Flow data-exchange endpoint and key registration confirmation.
- A guest verification/session credential contract.

Store all secrets in n8n Credentials, never Set/Code node literals or exported workflow JSON. Use separate staging and production credentials.

## Copy-ready workflow summary

1. Receive dates and guest counts from the WhatsApp experience.
2. Today, call the property list and then quote each candidate/selected property; an aggregate availability endpoint is still pending.
3. Present only a property that returned quote HTTP 200 and whose capacity supports the submitted occupancy.
4. On selection, do not create a confirmed booking. Route to the existing website/application path only after the frontend supplies a supported prefill URL, or wait for the approved enquiry-creation API.
5. After staff approval, handle the backend's `BOOKING_APPROVED` event and only then start the separately approved Cashfree payment process.
6. Treat payment and final confirmation as separate states. Do not infer confirmation from a request, quote, or payment-link event.

Backend owner actions required before the full workflow can go live: approve lifecycle mapping, implement aggregate availability and idempotent request creation, add n8n service auth, implement verified My Bookings, complete property content, implement the Meta encrypted endpoint, and add Cashfree verification/transition guards.
