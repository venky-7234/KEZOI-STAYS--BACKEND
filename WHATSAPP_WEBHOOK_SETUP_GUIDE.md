# KEZOI STAYS — Direct Meta WhatsApp Cloud API Setup Guide

This guide documents the setup and configuration required for connecting the KEZOI STAYS backend directly to the **Meta WhatsApp Cloud API** (bypassing n8n), implemented in Step 2.

> [!IMPORTANT]
> Do not register this webhook in Meta Business Manager or deploy until internal review and testing are approved.

---

## 1. Webhook Endpoints

Once deployed behind HTTPS (e.g., `https://api.kezoistays.com`), the direct WhatsApp endpoints are:

- **Verification URL (GET):**
  ```http
  GET https://api.kezoistays.com/api/whatsapp/webhook
  ```
- **Inbound Event Receiver (POST):**
  ```http
  POST https://api.kezoistays.com/api/whatsapp/webhook
  ```

---

## 2. Required Environment Variables

Add the following environment variables to your secure server environment (e.g. `.env` in production):

| Variable | Description | Example / Format | Sensitivity |
|---|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Secret string configured by you and entered in Meta App Dashboard during webhook registration. | `kz_wh_verify_9f8a3d...` | Secret |
| `META_APP_SECRET` | Meta App Secret from App Dashboard > Basic Settings. Used to verify `X-Hub-Signature-256` HMAC-SHA256 signatures. | `3a7b9c...` (32 hex characters) | Secret |
| `WHATSAPP_CLOUD_API_ACCESS_TOKEN` | Permanent System User access token with `whatsapp_business_messaging` and `whatsapp_business_management` permissions. | `EAAB...` | Secret |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Phone Number ID from App Dashboard > WhatsApp > API Setup. | `10987654321` (numeric string) | Identifier |
| `WHATSAPP_GRAPH_API_VERSION` | Meta Graph API version format `vXX.X`. Defaults to `v21.0` if omitted. | `v21.0` | Configuration |

> [!WARNING]
> Never place real access tokens, app secrets, or verify tokens in git repositories, documentation, or client-facing responses.

---

## 3. Registering the Webhook in Meta App Dashboard (Future Step)

When authorized to register the webhook with Meta:

1. Go to [developers.facebook.com](https://developers.facebook.com) > **Your App** > **WhatsApp** > **Configuration**.
2. Under **Webhook**, click **Edit**.
3. In **Callback URL**, enter:
   ```text
   https://api.kezoistays.com/api/whatsapp/webhook
   ```
4. In **Verify Token**, enter the exact string configured in `WHATSAPP_VERIFY_TOKEN`.
5. Click **Verify and Save**. Meta will make a `GET` request:
   ```http
   GET /api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=<token>
   ```
   The backend will timing-safe verify the token and return the challenge with HTTP 200.
6. Under **Webhook fields**, click **Manage** and subscribe to:
   - `messages` (delivers incoming guest messages, Flow completions, and interactive button/list replies).

---

## 4. Architecture & Security Guarantees

1. **Raw Body Signature Validation:**
   - Express captures the exact raw body bytes in `req.rawBody` before parsing.
   - Every `POST` is verified using HMAC-SHA256 against `META_APP_SECRET` via `crypto.timingSafeEqual`.
   - Tampered payloads, invalid signatures, or missing headers are rejected with HTTP 432.
2. **Durable Ingestion & Transactional Acknowledgment (Step 4B):**
   - Webhook events are normalized and filtered strictly against privacy allowlists.
   - All events are persisted inside a PostgreSQL transaction in `whatsapp_inbound_events` via `ON CONFLICT (idempotency_key) DO NOTHING`.
   - `HTTP 200 EVENT_RECEIVED` is returned to Meta **only after** the transaction successfully commits.
   - If persistence fails, `HTTP 500` is returned without leaking credentials, prompting Meta to retry delivery automatically.
3. **Database-Backed Deduplication:**
   - Message and status updates are deduplicated via a unique database index on `idempotency_key`. Duplicate deliveries commit cleanly with 0 inserts and return HTTP 200 without creating duplicate inbox records.
4. **Zero-PII Logging & Data Minimization:**
   - Phone numbers are masked (`***3210`) in display fields and hashed with SHA-256 for privacy-safe index lookups.
   - Guest message text, media file bytes, and unapproved JSON fields are **not** persisted.
   - Any thrown error is scrubbed using `sanitizeErrorMessage` to prevent leaking tokens or app secrets in application logs.
5. **Separate Direct Client:**
   - The direct client `src/services/whatsappCloudApi.service.js` is isolated and does not alter the existing `whatsapp.service.js` n8n-based notifications until cutover is explicitly initiated.

---

## 5. Webhook Durable Storage & Operator Migration Instructions

Step 4B implemented durable PostgreSQL persistence for all verified inbound events via `whatsapp_inbound_events`.

### Migration Execution (For Operator)
When authorized to apply migration `009_whatsapp_webhook_inbox.sql` to the target database:

```bash
npm run migrate:whatsapp-webhook-inbox
```
Or run the SQL file directly using `psql`:
```bash
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f migrations/009_whatsapp_webhook_inbox.sql
```

> [!NOTE]
> In accordance with safety rules, migrations have **not** been automatically executed against shared or production environments during Step 4B development. All behavior has been validated with isolated mock unit tests.

### Next Stage (Step 5)
Inbound Flow completion events are currently persisted with status `'PENDING'`. Automatic enquiry creation, availability re-checks, and booking notifications will be wired in Step 5 using the concurrency-safe claim worker (`claimNextPendingEvent`).
