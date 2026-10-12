# Enquiry approval workflow

## Behaviour

- `PATCH /api/enquiries/:id` supports ordinary tracking transitions only. It returns `409 APPROVAL_REQUIRED` for `QUALIFIED` and `409 BOOKING_CONVERSION_REQUIRED` for `CONVERTED`.
- `LOST` and `CANCELLED` require `ADMIN` or `SUPER_ADMIN`. They return `409 ACTIVE_BOOKING_EXISTS` when a linked booking is active.
- `PATCH /api/enquiries/:id/document-status` remains `SUPER_ADMIN` only. It records the reviewer and review time and never approves an enquiry.
- `PATCH /api/enquiries/:id/approve` remains `SUPER_ADMIN` only. It requires an uploaded, `VERIFIED` document and performs an atomic conditional transition to `QUALIFIED`.
- Repeating approval returns `already_approved: true` and sends no notification.
- Website and `TG-0001` applications can be converted only after document verification and approval. Booking creation remains the only path to `CONVERTED`.

## Frontend integration

Use the existing dropdown, but route special actions separately:

- `NEW`, `CONTACTED`, `QUOTED`, `FOLLOW_UP`: `PATCH /api/enquiries/:id` with `{ "status": "..." }`.
- `QUALIFIED`: first call `PATCH /api/enquiries/:id/document-status` with `{ "status": "VERIFIED" }` after an actual review, then call `PATCH /api/enquiries/:id/approve`.
- `CONVERTED`: create the booking through `POST /api/bookings` with `enquiry_id`; do not patch the enquiry directly.
- `LOST`, `CANCELLED`: call the generic patch as an admin and display conflicts from linked active bookings.

Error responses include a stable `code` field. Handle `APPROVAL_REQUIRED`, `DOCUMENT_VERIFICATION_REQUIRED`, `BOOKING_CONVERSION_REQUIRED`, `ACTIVE_BOOKING_EXISTS`, `STATUS_PERMISSION_REQUIRED`, and `INVALID_STATUS_TRANSITION` distinctly.

### Examples

```http
PATCH /api/enquiries/15/document-status
Authorization: Bearer <super-admin-token>
Content-Type: application/json

{"status":"VERIFIED"}
```

```http
PATCH /api/enquiries/15/approve
Authorization: Bearer <super-admin-token>
Content-Type: application/json

{}
```

An incomplete review returns:

```json
{
  "success": false,
  "code": "DOCUMENT_VERIFICATION_REQUIRED",
  "message": "Application cannot be approved until its identity document is uploaded and verified"
}
```

## Read-only production audit

Run from the backend container after deploying code, or execute the SQL directly:

```bash
npm run audit:enquiry-workflow
```

```sql
SELECT id, status, document_verification_status
FROM enquiries
WHERE status = 'QUALIFIED'
  AND document_verification_status IS DISTINCT FROM 'VERIFIED'
ORDER BY id;
```

This reports IDs and workflow state only. It does not expose documents or contact details and does not modify data. Enquiry 15 must be manually reviewed and reconciled through the authorized endpoints.

## Hostinger VPS deployment

Do not deploy until the exposed Resend credential and admin credential have been rotated. Obtain explicit authorization before pushing or deploying.

```bash
ssh <vps-user>@<vps-host>
cd /opt/kezoi/BACKEND-KEZOISTAYS
mkdir -p /opt/kezoi/backups
docker exec kezoi-postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "/opt/kezoi/backups/kezoistays-before-enquiry-workflow-$(date +%Y%m%d-%H%M%S).dump"
git pull --ff-only
docker compose config --services
docker compose run --rm --no-deps kezoi-backend npm run migrate:enquiry-review-audit
docker compose up -d --no-deps --build kezoi-backend
docker ps --filter name=kezoi-backend
docker logs --tail 100 kezoi-backend
curl --fail --silent --show-error https://api.kezoistays.com/
curl --fail --silent --show-error https://api.kezoistays.com/api/db-test
```

`kezoi-backend` in the `docker compose` commands must be the Compose service name. If `docker compose config --services` reports a different service name, substitute that exact name. The container name alone is not sufficient for Compose commands.

## Verification checklist

1. Confirm the migration completed and the three review-audit columns exist.
2. Run `npm run audit:enquiry-workflow`; do not automatically rewrite results.
3. Verify authentication and `SUPER_ADMIN` authorization on document review and approval.
4. Confirm generic `QUALIFIED` and `CONVERTED` patches return `409` with the expected code.
5. Review a test document, approve once, and confirm one WhatsApp event and one email attempt.
6. Repeat approval and confirm no additional notification is sent.
7. Create a booking for the approved test enquiry and confirm it becomes `CONVERTED` in the same transaction.
8. Verify existing booking, payment, GST, availability and Cashfree endpoints.
9. Confirm no unrelated container was restarted.
