# Kezoi Stays — n8n Create Enquiry API Contract

Verified from the local backend source and the supplied sanitized n8n/Meta Flow JSON on 10 October 2026.

## Readiness

- Local implementation: present.
- Local syntax checks: passed.
- Local unit tests: 8 passed, 0 failed.
- Database-backed enquiry API test: not run. The owner chose a production-only integration and does not require a separate test database; any production write verification must therefore use an explicitly identified test enquiry and be cleaned up through the normal administrative process.
- Production deployment: **not deployed**. Safe checks against `https://api.kezoistays.com` returned HTTP 404 for the integration availability/enquiry routes and Meta Flow health route.
- n8n action: keep the repurposed node disabled until the production migration/deployment and a controlled live test pass.

The production-only decision does not authorize direct database access. n8n receives live data through HTTPS APIs. Before the write endpoint can be enabled, migration `006_whatsapp_integration.sql` and the updated backend must be deployed to production with a database backup and rollback plan. The node remains disabled until a controlled production test succeeds.

## Endpoint and authentication

```http
POST /api/integrations/enquiries
Authorization: Bearer <N8N_SERVICE_TOKEN>
Idempotency-Key: <stable-key>
Accept: application/json
Content-Type: application/json
```

Both integration routes are protected by `serviceAuth.middleware.js`. The token is read from the backend-only `N8N_SERVICE_TOKEN` environment variable and compared using a timing-safe comparison. Provision independent random tokens for staging and production through the deployment secret store, and save them as n8n Header Auth credentials. Never put the token in workflow JSON, a Code/Set node, browser code, or the Meta Flow JSON.

## Exact request contract

The controller requires these JSON properties:

| Property | Type accepted by current code | Required | Rules |
|---|---|---:|---|
| `property_id` | numeric ID or numeric string | Yes | Must identify a property returned by the availability lookup. Used by PostgreSQL advisory locking. |
| `check_in` | string | Yes | Exact `YYYY-MM-DD` format. |
| `check_out` | string | Yes | Exact `YYYY-MM-DD`; must be later than `check_in`. |
| `guest_name` | string | Yes | Must be non-empty after trimming. |
| `guest_email` | string | Yes | Trimmed, lower-cased, and checked by the controller's email pattern. |
| `whatsapp_number` | string | Yes | Validated and normalized by the existing phone validator. |
| `country_code` | string | No | Defaults to `IN` for phone validation. |
| `adults` | integer or integer-like value | No* | Defaults to `guests`, then to 1. Must be at least 1. |
| `guests` | integer or integer-like value | No* | Compatibility input used only when `adults` is absent. |
| `children` | integer or integer-like value | No | Defaults to 0; must be non-negative. |
| `infants` | integer or integer-like value | No | Defaults to 0; must be non-negative. Included in capacity, not extra-guest pricing. |
| `pets` | integer or integer-like value | No | Defaults to 0; must be non-negative. |
| `special_requests` | string | No | Stored as `guest_message`; blank/falsy becomes `null`. |

`adults + children + infants` is used for capacity. `adults + children` is used for extra-guest pricing.

Copy-ready body for the current four-screen Flow:

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

The currently published Flow sends `property: "kezoi_manikonda_3bhk"`, but the API requires a database property ID. Until the Flow is upgraded to use dynamic property IDs, n8n must map that exact alias to property ID `1`. Do not pass the alias directly to PostgreSQL. After the dynamic Flow is approved, `${data.properties}` options must use `String(property.id)` so the completed `property` value can be passed directly as `property_id`.

## Exact successful response shape

For a new enquiry the controller returns HTTP 201:

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
    "handoff_url": "<WEBSITE_APPLICATION_URL>?enquiry=<database-enquiry-id>&upload_token=<signed-JWT>"
  }
}
```

The ID's JSON type follows the PostgreSQL driver/schema type. This response is derived exactly from `buildEnquiryResponse`; it is not an observed database-backed response. A successful replay returns HTTP 200 with the same structure and `replayed: true`.

The secure ID-upload URL is returned immediately after the transaction commits. The JWT is valid for 24 hours and contains `purpose`, `enquiry_id`, and `guest_id`. n8n should send `identity_document.handoff_url` to the guest without parsing or logging its token.

## Idempotency

The header is mandatory and must match:

```regex
^[A-Za-z0-9:._-]{16,200}$
```

The database migration creates a unique partial index on `enquiries.integration_idempotency_key`.

- Same key and same request hash: HTTP 200, original enquiry returned with `replayed: true`.
- Same key and a different request hash: HTTP 409.
- Concurrent submissions are protected by the unique key plus a property-scoped PostgreSQL transaction advisory lock.

A raw Meta message ID is suitable only if it is stable for the completed Flow message **and** matches the whitelist above. To avoid unsupported characters, produce a SHA-256 hex digest of the inbound message ID and send:

```text
wa-flow:<64-lowercase-hex-characters>
```

Store the original inbound ID in the workflow execution data, reuse the same derived key for every retry, and never generate a fresh UUID per retry.

## Implemented error responses

### HTTP 400

```json
{"success":false,"message":"A valid Idempotency-Key header is required"}
```

Other implemented 400 messages include missing required fields, invalid dates/counts, invalid phone, invalid email, and validation errors returned by availability parsing.

### HTTP 401

```json
{"success":false,"message":"Invalid service credential"}
```

### HTTP 409

```json
{"success":false,"message":"Idempotency key was already used for a different request"}
```

Other implemented 409 messages:

```json
{"success":false,"message":"Property is not available for the selected stay"}
```

```json
{"success":false,"message":"Duplicate enquiry submission"}
```

### HTTP 500

```json
{"success":false,"message":"Unable to create enquiry"}
```

HTTP 422 and HTTP 429 are **not implemented by this route**. n8n must not configure special handling for them unless validation/rate-limiting middleware is added and tested later. Infrastructure in front of Express could still generate its own 429 response, but that is not part of the current application contract.

## Existing n8n node changes

Rename the disabled `Kezoi | Create Booking API` node to `Kezoi | Create Enquiry API` and keep it disabled until staging approval.

- Method: `POST`
- URL: staging base URL plus `/api/integrations/enquiries`; production will be `https://api.kezoistays.com/api/integrations/enquiries` only after deployment.
- Authentication: n8n Header Auth credential containing `Authorization: Bearer <token>`.
- Headers: `Accept: application/json`, `Content-Type: application/json`, and the stable `Idempotency-Key`.
- Body: JSON body shown above, not the old `guest_phone` + nested `booking_data` body.
- Retry only network errors and 5xx responses, with a small bounded exponential backoff and the unchanged idempotency key.
- Do not retry 400/401/409 blindly. A 409 availability conflict returns the guest to availability/property selection; a key/request mismatch is an automation defect.
- On 201 or replayed 200, send the handoff URL as an identity-upload request, not as a booking confirmation.

## Exact current Flow-to-API mapping

| API field | Current source |
|---|---|
| `property_id` | `booking_data.property`; currently map `kezoi_manikonda_3bhk` to `1` |
| `check_in` | `booking_data.check_in` |
| `check_out` | `booking_data.check_out` |
| `guests` | `booking_data.guests` |
| `guest_name` | `booking_data.guest_name` |
| `guest_email` | `booking_data.guest_email` |
| `special_requests` | `booking_data.special_requests` |
| `whatsapp_number` | `guest_phone`, currently extracted from `messages[0].from` |
| idempotency source | Meta inbound completed-Flow `messages[0].id`; the existing `Edit Fields` node does not currently preserve it and must be updated |

Add a field to `Edit Fields` before the original payload is discarded:

```text
inbound_message_id = {{ $json.messages?.[0]?.id || '' }}
```

Then derive the whitelisted key deterministically. The exact Code-node implementation depends on the crypto facilities enabled in the installed n8n version; its output must be `wa-flow:` followed by the SHA-256 lowercase hex digest.

## Secure website upload

The website submits:

```http
POST /api/applications/enquiries/:id/identity-document
Authorization: Bearer <upload_token from handoff URL>
Content-Type: multipart/form-data
```

Multipart fields:

- `identity_document`: required; one JPG, PNG, or PDF; maximum 5 MB.
- `document_type`: required; accepted canonical values are `AADHAAR_CARD`, `PASSPORT`, and `DRIVING_LICENCE`. Existing aliases include `AADHAAR`, `AADHAR`, `AADHAR_CARD`, `DRIVING_LICENSE`, `DRIVER_LICENCE`, and `DRIVER_LICENSE`.

The upload token must authorize the URL enquiry ID and database guest ID. A successful upload sets document verification back to `PENDING`; staff must still verify and approve it. No OTP, payment link, or automatic confirmation is introduced.
