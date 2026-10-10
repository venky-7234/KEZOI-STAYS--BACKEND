# Kezoi Stays — Information Required from the n8n/WhatsApp Developer

Prepared: 2026-10-10  
Production API base: `https://api.kezoistays.com`  
Meta WhatsApp Flow ID: `1149040077692619`

## Purpose

We are completing the backend integration for the existing Kezoi Stays WhatsApp booking automation. Please provide the files and answers below so the backend endpoints, encrypted Meta Flow exchange, n8n authentication, idempotency, events, and staging tests can be completed without rebuilding working automation unnecessarily.

The prepared booking, payment, and confirmation nodes must remain disabled until replacement contracts are implemented, tested, deployed, and approved.

## 1. Current Meta Flow

Attach the complete current JSON export for Flow `1149040077692619`, including:

```text
BOOKING_DETAILS
PROPERTY_SELECTION
GUEST_DETAILS
BOOKING_REVIEW
```

Do not modify or republish the Flow as part of this request.

Confirm:

```text
Flow JSON version:
Data API version:
Current status (DRAFT/PUBLISHED):
Current data-exchange endpoint, if any:
Public encryption key already registered? Yes/No
Who can update the endpoint URL?
Who can register or replace the public key?
Who is authorized to republish the Flow?
```

For every screen, document its input keys, component field names, output keys, navigation actions, validation behavior, existing `data_exchange` actions, final payload, and `flow_token` handling.

Confirm the exact field names for:

```text
check_in
check_out
adults
children
infants
pets
property_id
property_name
full_name
email
phone
whatsapp_number
guest_message
```

## 2. Sanitized Flow submission example

Provide one complete example of the payload received by n8n after Flow submission. Use fake values only.

Identify:

```text
Receiving workflow name:
Receiving node name:
Payload source (Meta webhook/another workflow/other):
Field containing wa_id:
Field containing the guest phone number:
Field containing the Flow ID:
Field containing the Flow token:
Field containing the Meta message ID:
```

## 3. Sanitized n8n workflow export

Export the relevant workflow as JSON with credentials removed or anonymized. Include the existing nodes for:

- Welcome Menu
- Book a Stay
- My Bookings
- Contact Staff
- Flow response processing
- Booking validation
- Prepared booking API call
- Prepared booking confirmation
- Retry and error handling

Do not include access tokens, passwords, credential values, webhook secrets, private keys, or customer data.

For every backend-related HTTP Request node, provide:

```text
Node name:
Method and URL:
Authentication selection:
Headers:
Query parameters:
JSON/form body:
n8n expressions:
Expected success response:
Error-output behavior:
Retry behavior:
```

## 4. Webhook and Meta configuration

Provide staging details through the approved secure credential-sharing method:

```text
Test webhook URL:
Production webhook configured? Yes/No
Expected HTTP method and Content-Type:
Expected success status/body:
Workflow name and receiving node:
```

If a webhook URL functions as a credential, do not place it in ordinary chat, email, screenshots, or documentation.

Confirm that the Meta administrator can:

- Register the backend's public RSA key
- Configure the backend HTTPS data-exchange endpoint
- Run Meta's endpoint health check
- Coordinate required Flow JSON changes
- Test in staging
- Publish only after project-owner approval

The backend team will retain the private key. Only its public key will be supplied to Meta.

Never send the Meta app secret, Flow private key, key passphrase, permanent access token, or system-user token in this document.

## 5. WhatsApp identity and signature validation

Confirm which trusted values n8n receives directly from Meta:

```text
wa_id:
Sender phone number:
Phone-number ID:
WhatsApp Business Account ID:
Flow token:
Message ID:
```

Confirm whether the incoming Meta webhook currently validates `X-Hub-Signature-256` against the raw request body using the Meta app secret.

A phone number entered into a form is not sufficient identity proof for My Bookings.

## 6. Temporary lifecycle without online payments

Kezoi currently has no Cashfree or other online payment integration. The approved temporary lifecycle is:

```text
WhatsApp form
→ live availability and quotation
→ property selection
→ NEW enquiry
→ secure website handoff for mandatory identity-document upload
→ document verification and internal staff review
→ QUALIFIED approval
→ manual payment follow-up by the Kezoi team
```

n8n must not:

- Generate a payment link
- Update `payment_status`
- Call internal payment APIs
- Call `POST /api/bookings`
- Create an immediately confirmed booking
- Send confirmation before staff completes the approved manual process

After approval, tell the guest that the Kezoi team will contact them with payment instructions. Please confirm the workflow will follow this lifecycle.

## 7. Idempotency

Confirm that n8n can generate and persist one stable idempotency key per enquiry submission.

Recommended format:

```text
wa-flow:{flow_token}:{submission_id}
```

The same key must be reused for every retry. Identify where it will be created and retained. Do not generate a new key for each retry.

## 8. Dedicated Kezoi service credential

Confirm that n8n can store a dedicated credential in n8n Credentials and send:

```http
Authorization: Bearer <dedicated-service-token>
```

The token must not appear in Set nodes, Code nodes, exported workflow JSON, screenshots, or execution logs. Do not use a staff email/password.

Confirm:

```text
Who installs the staging credential?
Who installs the production credential?
Who rotates the credentials?
Can sensitive headers be hidden from execution data? Yes/No
```

## 9. Signed backend events

Confirm that n8n can validate:

```http
X-Kezoi-Timestamp: <unix timestamp>
X-Kezoi-Delivery-Id: <unique delivery identifier>
X-Kezoi-Signature: sha256=<hex digest>
```

Proposed signature input:

```text
timestamp + "." + raw_request_body
```

Proposed algorithm: `HMAC-SHA256`.

n8n should reject invalid signatures, missing or expired timestamps, and repeated delivery IDs. The exact contract will be finalized after implementation and verification.

## 10. Website document handoff

Confirm the preferred guest experience:

- Open the secure Kezoi website from the Flow
- Send the secure link in WhatsApp after Flow submission
- Display the link on the final Flow screen

The website handoff is mandatory for identity-document collection. The secure link/token must not be logged unnecessarily, shared, or reused after expiry.

## 11. My Bookings

My Bookings will use email OTP and a short-lived guest session. It must never use unauthenticated phone-number lookup.

Confirm that n8n can support:

```text
Request email OTP
→ collect OTP
→ verify OTP
→ retain the short-lived guest token securely
→ call the guest-owned bookings endpoint
→ discard the token after expiry
```

Do not retain OTP values or guest session tokens in long-term execution logs.

## 12. Error and retry behavior

Handle responses as follows:

```text
400 — invalid input; return to the relevant form screen
401/403 — credential/configuration failure; do not retry repeatedly
404 — property or enquiry no longer exists
409 — unavailable property or duplicate/conflicting request
422 — validation or identity failure
429 — wait according to Retry-After, then retry
500/502/503 — bounded exponential retry, then staff fallback
```

Every write retry must preserve its original idempotency key.

## 13. Staging tests

Please prepare:

- A staging n8n workflow
- Fake guest contact information
- Test WhatsApp sender and recipient
- Test Flow-token samples
- Sanitized encrypted-request fixtures, if available
- Expected dynamic property options
- No-availability test
- Invalid-date test
- Over-capacity test
- Duplicate-submission test
- Backend-unavailable fallback
- Staff-handoff fallback

Do not use production customer, booking, enquiry, document, or payment records.

## 14. Ownership and access

Identify the responsible person for:

```text
Meta app administration:
WhatsApp Business Account administration:
WhatsApp phone-number configuration:
Meta Flow editing:
Meta public-key registration:
n8n staging administration:
n8n production administration:
Production webhook credential management:
Workflow deployment approval:
Flow publication approval:
```

## Immediate deliverables

Please return:

1. Complete Meta Flow JSON export.
2. Sanitized n8n workflow JSON export.
3. Sanitized final Flow-submission example.
4. Exact Flow field names and navigation contract.
5. Flow JSON version and Data API version.
6. Current DRAFT/PUBLISHED status.
7. Data-exchange endpoint and public-key status.
8. Staging webhook availability and expected response.
9. Confirmation that booking/payment/confirmation nodes remain disabled.
10. Confirmation that service credentials can be stored securely.
11. Confirmation that retries preserve the idempotency key.
12. Meta webhook signature-validation status.
13. Preferred identity-document handoff experience.
14. Completed ownership/access list.

## Security reminder

Do not include any private key, key passphrase, Meta app secret, access token, n8n credential, service token, production webhook secret, database credential, real customer information, or real booking/payment data in the returned files.

Use the organization's approved secret-sharing method for credentials that must be installed by an authorized administrator.
