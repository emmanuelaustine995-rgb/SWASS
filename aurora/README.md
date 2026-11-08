# E-RECEIPT / AURORA

AURORA is an isolated frontend using the existing SWASS NestJS API codebase as its backend. It is deployed as separate Render services and must use a new, empty PostgreSQL database. It does not replace the live SWASS frontend or database.

- Login branding: E-RECEIPT
- Workspace name: AURORA
- Main navigation: Dashboard, Receipt, Profile
- Receipt flow: multi-item cart, server-calculated totals, receipt persistence, saved receipt search and printable preview
- Backend: reuses the SWASS API modules for phone/password login, TalkSasa signup OTP, business profile, products, receipts, PDF generation, receipt email via Brevo, WhatsApp PDF delivery, Tuma subscription/wallet payments, receipt recovery, customers, staff and dashboard reporting.
- Tenant isolation: the API scopes business records to the signed-in tenant and store.
- Data: AURORA must start on a separate empty database. No SWASS customer, receipt, product, or tenant records are copied.

## Render deployment

Use the repository's `render-aurora.yaml` blueprint. It creates:
- `e-receipt-aurora-api`, built from the repository root with the full NestJS API.
- `e-receipt-aurora-web`, a static site published from `aurora/`.

The API blueprint runs the existing database migration runner before startup. It generates separate JWT and business-ID secrets and sets the AURORA frontend/API public URLs.

## Credentials and safety

Render does not transfer secret values between services automatically. To activate existing providers, the private values must be copied securely into the AURORA API service's Render environment settings:
- `TALKSASA_API_TOKEN`
- `BREVO_API_KEY` and `BREVO_FROM_EMAIL`
- `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`
- `TUMA_API_KEY`

Do not put these values in GitHub, frontend JavaScript, screenshots, or chat messages. The code and environment-variable names are prepared, but provider delivery cannot be confirmed until the values are present and tested.

## Remaining acceptance work

- Configure a new empty PostgreSQL database and deploy both AURORA services.
- Complete browser/API integration tests on the deployed URLs, including OTP registration, subscription payment, receipt issue, PDF delivery, receipt recovery, profile edits and staff permissions.
- Verify the AURORA receipt-recovery and email-verification links resolve to AURORA pages.
- Do not repoint or replace live SWASS until AURORA passes these tests.
