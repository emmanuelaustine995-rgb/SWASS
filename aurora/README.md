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

The API blueprint runs every existing SWASS database migration before startup. It uses the same SWASS API code and table structure, but only against a new, empty AURORA PostgreSQL database (`DATABASE_URL`). It generates separate JWT and business-ID secrets and sets the AURORA frontend/API public URLs. This is code/integration reuse, not a shared production database.

## Credentials and safety

Render does not transfer secret values between services automatically. To activate the existing SWASS provider accounts on AURORA, the following values must be added securely to the AURORA API service's environment settings:

- TalkSasa primary SMS/OTP: `TALKSASA_API_TOKEN`, `TALKSASA_SENDER_ID`, `TALKSASA_API_URL`
- Africa's Talking SMS fallback: `AT_USERNAME`, `AT_API_KEY`, optional `AT_SENDER_ID`
- Twilio SMS fallback: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` (or `TWILIO_FROM_NUMBER`)
- Brevo email verification and receipt PDF: `BREVO_API_KEY`, `BREVO_FROM_EMAIL`
- WhatsApp Cloud PDF delivery: `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION=v22.0`
- Optional FlareSend alternative: `WHATSAPP_PROVIDER=flaresend`, `FLARESEND_API_KEY`
- Tuma M-Pesa STK push and payment callbacks: `TUMA_API_KEY`, `TUMA_BUSINESS_EMAIL`, `MPESA_CALLBACK_TOKEN`

The blueprint declares these environment-variable names and supplies non-secret defaults where appropriate. Secret values are not accessible to GitHub and are not copied automatically from SWASS. Do not put them in GitHub, frontend JavaScript, screenshots, or chat messages. Provider delivery remains unverified until the values are present on the AURORA service and live test messages/payments succeed. Keep the existing SWASS service and its secrets unchanged.


## Remaining acceptance work

- Configure a new empty PostgreSQL database and deploy both AURORA services.
- Complete browser/API integration tests on the deployed URLs, including OTP registration, subscription payment, receipt issue, PDF delivery, receipt recovery, profile edits and staff permissions.
- Verify the AURORA receipt-recovery and email-verification links resolve to AURORA pages.
- Do not repoint or replace live SWASS until AURORA passes these tests.
