# Kezoi Stays Backend API Audit

Audit date: 2026-10-10 (Asia/Calcutta)  
Repository commit inspected: `dd8451ec9f037028bc23d1a19c24451c496a01ef`  
Production base URL tested: `https://api.kezoistays.com`

This is a read-only audit. No production records, booking statuses, payment logic, or application code were changed. Missing endpoint names and response shapes are deliberately not invented.

## Executive conclusion

The deployed Express/PostgreSQL backend is reachable and already supports the public website application process, internal property/booking/payment administration, property-specific quote and availability validation, and outbound event delivery to n8n.

It is not yet ready for the requested WhatsApp booking experience. It has no single public/service endpoint that lists all available properties for dates and occupancy, no guest-owned "My Bookings" authentication, no service credential dedicated to n8n, no public property-details representation with descriptions/amenities/images/booking URLs, and no Meta WhatsApp Flow encrypted data-exchange endpoint.

The existing public website path preserves the intended first stage: it creates an `enquiries` record with status `NEW`, then a super-admin can approve it to `QUALIFIED`. It does not create a booking. However, the internal `POST /api/bookings` implementation creates a booking directly as `CONFIRMED` with payment status `PENDING`. This conflicts with the stated approval-then-payment-then-confirmation terminology and must be resolved by the product/backend owner before exposing booking creation to n8n. This audit does not change it.

## Section A — Backend status

### Architecture and deployment

- Node.js CommonJS application using Express 5.2.1.
- PostgreSQL through `pg` and a shared connection pool configured by environment variables.
- Routes are mounted directly in `server.js`; controllers contain validation, SQL, and response construction. There is no separate repository/service layer for booking or availability logic.
- Security middleware: Helmet, permissive reflected-origin CORS (`origin: true`, credentials enabled), JSON/form parsing, Morgan logging, JWT bearer authentication, and role checks on selected routes.
- nginx terminates HTTPS in production. `api.kezoistays.com` resolved to an A record and returned valid HTTPS responses during this audit.
- No OpenAPI/Swagger definition, automated test suite, request rate limiter, API version namespace, or deployment manifest is present in this repository.
- Database connection configuration has no explicit SSL option. Whether TLS is used between the app and PostgreSQL depends on its network/deployment environment and was not established by the repository.

### API-root investigation

`GET https://api.kezoistays.com/` returned 200 with `{"success":true,"message":"Kezoi Stays backend is running"}`. `GET https://api.kezoistays.com/api` returned the expected application 404: `Route not found: GET /api`. Therefore the reported `/api` browser error is not evidence of DNS, TLS, nginx, or backend failure; `/api` simply has no GET handler.

### Database structure relevant to booking

The live database metadata was inspected through `information_schema` and `pg_indexes` without reading customer rows.

- `properties`: identity/code/name/type/address/area/city, bedrooms, bathrooms, maximum and included guests, base and extra-guest prices, status, and `airbnb_url`. It has no description, amenities, currency, canonical booking/microsite URL, or listing-image fields.
- `property_blocks`: property, half-open start/end dates, type, reason, creator.
- `guests`: identity/contact/profile fields, email and WhatsApp verification timestamps, referral fields, status and aggregate booking/spend fields.
- `enquiries`: guest/property, requested dates and guest counts (including infants/pets), quote components, status, document metadata/review status, and discount fields.
- `bookings`: guest/property/enquiry, dates, adult/child counts, amounts, source, booking status, payment status, requests and creator. The live table contains both legacy and current amount/source/night columns.
- `payments`: booking/guest, amount, gateway identifiers/signature, status and paid timestamp.
- `users`: internal users with password hash, role and status.
- Relevant indexes exist on booking property/dates, booking guest/status, property-block property/dates, guest contact fields and payment booking ID. There is no PostgreSQL exclusion constraint or other database-level no-overlap guarantee.
- The repository migrations are incremental feature migrations, not a complete schema baseline. Rebuilding the database from this repository alone is not currently reproducible.

### Existing booking/application flow

1. The public application endpoints list active properties and calculate a quote.
2. `POST /api/applications/submit` revalidates contacts, dates, capacity, conflicts and pricing, upserts the guest, stores identity-document metadata, and creates an enquiry with status `NEW`.
3. The application appears through protected enquiry/dashboard routes.
4. A super-admin can verify/reject the document and approve an application; approval sets the enquiry to `QUALIFIED` and emits `BOOKING_APPROVED` to n8n.
5. An authenticated internal caller can convert/create a booking and optionally mark the enquiry `CONVERTED`.
6. Payments are internal bearer-protected records; the repository has generic gateway fields but no Cashfree API client, order creation, webhook signature verification, or Cashfree credential configuration.

### Availability and pricing logic

- Date overlap is consistently expressed as existing start `< requested checkout` and existing end `> requested check-in`, correctly allowing same-day turnover.
- Blocking booking statuses are `HOLD`, `CONFIRMED`, and `CHECKED_IN`; property blocks also make dates unavailable.
- Public quote/application logic checks active property status and total occupants (`adults + children + infants`) against `max_guests`. Pricing charges adults + children beyond `included_guests`; infants are capacity-only and pets are not priced.
- Internal booking creation checks adults + children against capacity, but has no infants field. This is a semantic difference from public application validation.
- Public quote and application submission recalculate prices server-side. Internal booking creation also calculates from property prices, taxes and authorized discount input.
- The conflict check and insert occur in a transaction but there is no property row lock, advisory lock, serializable isolation, or exclusion constraint. Concurrent requests can both pass the check and create overlapping active bookings. This is a critical integrity gap for any automated booking writer.
- Enquiries do not block availability; only bookings in the three active statuses and property blocks do.

### Booking statuses, cancellation and modification

- Accepted booking status values in the controller: `HOLD`, `CONFIRMED`, `CHECKED_IN`, `CHECKED_OUT`, `CANCELLED`, `NO_SHOW`.
- Accepted payment record statuses: `PENDING`, `PAID`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED`; aggregate booking payment status may also become `PARTIALLY_PAID`.
- Internal staff can set a booking to `CANCELLED` through the generic status endpoint. There is no guest cancellation endpoint, cancellation policy enforcement, refund orchestration, cancellation reason field update, or ownership check suitable for WhatsApp.
- There is no endpoint to modify booking dates, property, or guest count.
- Status transitions are not state-machine constrained and the status endpoint is available to any authenticated internal user; role middleware is not applied there.

### Authentication and security

- Existing protected APIs use JWT bearer tokens issued by `POST /api/auth/login`; tokens expire after seven days and represent an internal user role.
- No API key, OAuth client credentials, HMAC request signature, mTLS identity, or dedicated n8n service account/token scope exists.
- The public application contact-validation endpoint is not an ownership authentication mechanism. OTP confirmation returns 410, and the application code records `whatsapp_verified_at = NOW()` after format validation rather than proof that the caller controls the number.
- Consequently, a phone number alone must not be used for booking lookup. There is currently no safe guest "My Bookings" API.
- The outbound n8n webhook uses JSON over HTTPS but sends no authorization or signature header. The configured webhook URL is a secret environment value, but possession of the URL is its only protection.
- `POST /api/test/whatsapp` is unauthenticated and can trigger the configured n8n webhook for a caller-supplied phone number. This should be disabled in production or protected before broader integration.
- Error responses in multiple controllers include raw `error.message`; production responses should avoid leaking database/provider details.
- CORS reflects arbitrary origins while allowing credentials. Restrict it to known site/dashboard origins.
- No application rate limiting is present, including on login, contact validation, public quote, application submission, or WhatsApp test routes.

### Property content

- Existing public property output includes ID, code, name, type, area/city, bedroom/bathroom count, capacity, prices and update time.
- `airbnb_url` exists in the property table and protected property representation, but is omitted from the public application property list and quote selection.
- No description, amenities, currency, official booking URL or microsite URL exists in the audited property model.
- `asset_photos.image_url` exists for internal operations assets, but those records describe inventory assets, require `SUPER_ADMIN`/`OPERATIONS`, and are not a public property gallery. They should not be repurposed as listing images without a data-model decision.

## Section B — API endpoint table

All exact URLs below exist in the audited code. “Pending” rows intentionally have no URL because none has been approved or implemented.

| API | Method and exact production URL | Authentication | Status | Deployment/test status |
|---|---|---|---|---|
| Health | `GET https://api.kezoistays.com/` | None | Existing | Deployed; 200 verified |
| API root | `GET https://api.kezoistays.com/api` | None | No route | Deployed 404 verified; expected |
| Public property list | `GET https://api.kezoistays.com/api/applications/properties` | None | Existing | Deployed; 200 verified |
| Public unavailable dates | `GET https://api.kezoistays.com/api/applications/properties/:id/unavailable-dates` | None | Existing | Deployed; 200 verified for ID 1 |
| Public property quote/availability | `GET https://api.kezoistays.com/api/applications/properties/:id/quote` | None | Existing | Deployed; invalid-date, capacity and not-found cases verified |
| Public quote/availability | `POST https://api.kezoistays.com/api/applications/quote` | None | Existing | Code-inspected; not invoked to avoid unnecessary provider/discount coupling |
| Contact validation | `POST https://api.kezoistays.com/api/applications/verification/request` | None | Existing | Code-inspected; not invoked because it calls a paid/external provider |
| Application/enquiry submission | `POST https://api.kezoistays.com/api/applications/submit` | None; multipart form | Existing | Code-inspected; not invoked because it writes guest/enquiry/document data |
| Protected property list | `GET https://api.kezoistays.com/api/properties` | Internal JWT | Existing | Code-inspected |
| Protected property details | `GET https://api.kezoistays.com/api/properties/:id` | Internal JWT | Existing | Deployed; unauthenticated 401 verified |
| Protected property availability | `GET https://api.kezoistays.com/api/properties/:id/availability` | Internal JWT | Existing | Deployed; unauthenticated 401 verified |
| Internal booking list | `GET https://api.kezoistays.com/api/bookings` | Internal JWT | Existing | Code-inspected |
| Internal booking details | `GET https://api.kezoistays.com/api/bookings/:id` | Internal JWT | Existing | Deployed; missing/invalid bearer 401 verified |
| Internal booking creation | `POST https://api.kezoistays.com/api/bookings` | Internal JWT | Existing, not suitable for n8n yet | Code-inspected; not invoked because it writes and currently inserts `CONFIRMED` |
| Internal booking status | `PATCH https://api.kezoistays.com/api/bookings/:id/status` | Internal JWT | Existing | Code-inspected; not invoked |
| Internal payment APIs | `/api/payments`, `/api/payments/:id`, `/api/payments/:id/status` | Internal JWT | Existing generic records | Code-inspected; no Cashfree integration verified |
| Aggregate available-property search | No implemented URL | N/A | Pending | Required for WhatsApp dynamic choices |
| Public/service property details with gallery and booking URL | No implemented URL | N/A | Pending | Required; source fields are incomplete |
| Guest-owned My Bookings | No implemented URL | N/A | Pending | Requires real OTP/session ownership proof |
| n8n booking-request creation | No approved URL | N/A | Pending decision | Must preserve enquiry/approval/payment flow |
| Booking redirect with prefilled stay | No implemented contract | N/A | Pending | Website route/query contract not present in this backend repo |
| Guest cancellation/modification | No implemented URL | N/A | Pending/not supported | Policy and authorization decisions required |
| Meta Flow encrypted data exchange | No implemented URL | N/A | Pending | Required for Flow ID `1149040077692619` |

## Existing endpoint contracts relevant to n8n

### List active properties

`GET /api/applications/properties` requires no headers beyond `Accept: application/json`.

```bash
curl -H "Accept: application/json" \
  https://api.kezoistays.com/api/applications/properties
```

Success: 200 with `success`, `total`, `prices_refreshed_at`, and `properties[]`. Property fields are `id`, `property_code`, `property_name`, `property_type`, `area`, `city`, `bedrooms`, `bathrooms`, `max_guests`, `base_price`, `included_guests`, `extra_guest_price`, `updated_at`. Failure: 500 with `success: false` and an error message.

### Quote and validate one selected property

`GET /api/applications/properties/:id/quote` accepts query parameters `check_in`, `check_out`, `adults`, `children`, `infants`, `pets`, and optional `mobile_number`/`whatsapp_number`/`phone` plus a country code. Dates must be `YYYY-MM-DD`; at least one adult is required.

```bash
curl --get https://api.kezoistays.com/api/applications/properties/1/quote \
  --data-urlencode "check_in=2026-12-10" \
  --data-urlencode "check_out=2026-12-12" \
  --data-urlencode "adults=2" \
  --data-urlencode "children=0"
```

Success: 200 with `property`, parsed `guests`, and a server-calculated `quote`. Errors: 400 invalid dates/count/capacity, 404 property absent, 409 inactive or unavailable, 500 server failure. A 200 response means the selected property was available at calculation time; it is not a hold and does not prevent a later conflict.

### Unavailable dates for one property

`GET /api/applications/properties/:id/unavailable-dates` requires no authentication and returns 200 with `property_id`, `unavailable_dates[]`, and flattened `blocked_dates[]`. It does not explicitly return 404 for an unknown property; an unknown ID can yield an empty 200 response.

### Internal JWT login

`POST /api/auth/login` accepts JSON `{"email":"...","password":"..."}` and returns a seven-day bearer token plus internal user details on 200. Errors include 400 missing credentials, 401 invalid credentials and 403 inactive account. This is intended for internal users; do not place a staff password in an n8n workflow as the long-term service-auth solution.

### Internal booking creation warning

`POST /api/bookings` accepts `guest_id`, `property_id`, optional `enquiry_id`, `check_in`, `check_out`, `adults`, `children`, `taxes`, `discount_amount`, `discount_reason`, `source`, and `special_requests`. It rechecks property state, capacity, booking/block conflicts, and calculates price. It returns 201 with a booking, 400 validation errors, 403 unauthorized discount, 404 guest/property missing, 409 conflicts/inactive property, or 500.

Do not connect n8n to this writer yet: it is an internal endpoint, has no idempotency key, can race under concurrency, and inserts `CONFIRMED`/`PENDING`, which does not unambiguously represent the requested approval-first/payment-before-confirmation flow.

## Required changes, in priority order

1. Obtain product-owner confirmation of the authoritative lifecycle mapping between enquiry approval, `HOLD`, `CONFIRMED`, and payment success. Preserve existing status values; change behavior only after approval.
2. Add database-enforced or lock-based conflict serialization for active bookings before any automated writer is enabled.
3. Create a read-only aggregate availability service that reuses the exact overlap, block, active-property, capacity and pricing rules and returns only eligible properties.
4. Decide and populate authoritative property description, amenities, currency, listing images and Kezoi booking/microsite URLs. Do not map operations asset photos implicitly.
5. Add dedicated n8n service authentication with least-privilege scopes, rotation and rate limiting. A random high-entropy API key stored hashed at rest or signed short-lived service JWTs are both viable; the owner must choose before an exact contract is implemented.
6. Add genuine guest ownership verification (WhatsApp OTP or a signed, short-lived session established from a verified Meta identity and challenge) before My Bookings. Never authorize by request phone alone.
7. Add idempotency for n8n writes and bind any created enquiry/booking to the verified guest identity.
8. Add the Meta Flow encrypted adapter: Meta public-key registration, private-key secret management, request signature/shape validation, request decryption, action/screen routing, encrypted responses, and health monitoring. The existing REST quote route cannot be used directly as a Flow data-exchange endpoint.
9. Protect/remove `/api/test/whatsapp`, sign outbound n8n events, restrict CORS, redact internal errors, add rate limits and audit logs.
10. Add complete schema migrations, automated integration tests and an OpenAPI document after contracts are approved.

## Section D — Meta WhatsApp Flow integration status

No compatible endpoint exists. The repository contains no Meta Flow ID, screen ID, key material, decryption/encryption implementation, Flow request validation, dynamic option response, or Flow JSON. The only WhatsApp-related HTTP route is an unauthenticated outbound n8n test trigger; it is unrelated to Meta Flow data exchange.

Pending implementation must use Flow ID `1149040077692619` and coordinate changes to screen `BOOKING_DETAILS` with the automation developer. The data-exchange URL cannot be named until a route is approved and implemented. Required deployment secrets include the Meta/Flow private key and its passphrase if used; the matching public key must be registered in Meta. The private key must be stored only in the production secret manager/environment, never in Git or n8n workflow JSON.

The Flow adapter should decrypt the incoming envelope, validate version/action/screen and request freshness, call the shared availability service, map properties into Flow-compatible options, return encrypted navigation/data, and return encrypted validation-safe errors. A separate unauthenticated health route may report only readiness, never keys or customer data.

## Section E — required credentials and configuration

Existing environment names observed (values were not read into the report):

- `PORT`
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `JWT_SECRET`
- `INITIAL_ADMIN_PASSWORD`
- `RESEND_API_KEY`, `MAIL_FROM`, `EMAIL_FROM`
- `CHECK_MAIL_API_KEY`
- `N8N_WHATSAPP_WEBHOOK_URL`

Missing/pending configuration categories:

- Dedicated n8n inbound service credential and its server-side hash/public verification material.
- Outbound n8n webhook signing secret, configured independently in the backend and n8n Credentials.
- Meta WhatsApp Flow private key secret, optional passphrase, registered public key identifier/configuration, and approved data-exchange URL.
- Meta Cloud API access values are expected in n8n, not this backend, unless the architecture changes.
- Cashfree app ID/secret, environment, webhook secret/public-key verification settings and API version are absent. Obtain them from the Cashfree merchant dashboard only when Cashfree implementation is authorized.

Secrets must be stored in the host secret store and n8n Credentials, not node parameters, source control, reports, or execution logs. Rotate any credential exposed in workflow exports.

## Section F — verification results

Read-only production checks completed on 2026-10-10:

- DNS: `api.kezoistays.com` resolved successfully.
- TLS/health: `/` returned 200 through nginx with HSTS.
- API root: `/api` returned the expected JSON 404.
- Public inventory: `/api/applications/properties` returned 200 and one active property.
- Invalid reversed dates: quote returned 400.
- Guest capacity: 11 adults for the current max-10 property returned 400.
- Invalid property: quote for a non-existent ID returned 404.
- Property details/availability without JWT: both returned 401.
- Booking lookup without a token and with an invalid token: returned 401.
- Unavailable dates: returned 200 for the deployed property.
- Live PostgreSQL metadata connection succeeded; relevant columns and indexes matched the running controllers.
- Local `npm run check` completed successfully against the inspected source; no automated behavioral suite exists.

Not tested because doing so would mutate production or require credentials: successful application submission, booking creation, status/cancellation, payments, authenticated booking/property reads, n8n webhook delivery, email validation provider, and any Cashfree/Meta exchange.

## Section G — pending decisions and requirements

- Approve the lifecycle/status mapping before changing booking creation.
- Choose whether WhatsApp creates an enquiry/application or only redirects to the existing website. Direct confirmed booking creation is not approved by the stated flow.
- Decide whether identity-document upload remains mandatory for WhatsApp-created requests; the existing application submit route requires multipart upload.
- Select a guest verification design and service-to-service auth design.
- Supply authoritative property content/gallery/booking URLs and currency semantics.
- Supply the frontend booking route/query-string contract if redirect is selected.
- Supply Meta app/business access and Flow private/public key setup authority; do not publish or modify the Flow without approval.
- Supply Cashfree integration requirements separately; current code does not implement Cashfree.
- Confirm hosting process/service configuration; only nginx behavior is externally visible from this audit.

## Testing instructions for a future implementation

Run syntax validation with `npm run check`, then add isolated integration tests against a non-production database covering: adjacent dates; each overlap shape; property blocks; inactive properties; exact/over capacity; malformed/impossible dates; concurrent duplicate/conflicting writes; idempotency replay; authenticated and unauthorized guest lookups; cross-guest access denial; service-key absence/invalidity/rotation; cancellation and modification rules if approved; and payment/status transition guards.

For Meta Flow, use Meta's test tooling and fixtures to validate key registration, encrypted ping/data exchange, `BOOKING_DETAILS` navigation, empty availability, invalid inputs, tampered ciphertext, wrong key, replay/timeout behavior, and encrypted error responses. Test locally/staging first and label production deployment separately.
