# SWASS free preview deployment

This blueprint prepares a **test/preview deployment**, not a production payment or retail system. It creates:

- `swass-api`: NestJS API on a free Render web service.
- `swass-web`: static POS/dashboard frontend on a free Render static site.
- PostgreSQL: use a separate Neon database and paste its pooled or direct connection string into Render as `DATABASE_URL`.

## Important free-tier limitations

- Render free web services sleep after 15 minutes without traffic and can take about a minute to wake up.
- Render free Postgres expires after 30 days, so this project uses Neon for the database instead.
- Free hosting is suitable for a demo and testing, not for live shops, reliable checkout, sensitive customer records, or real payments. Upgrade to supported paid services and complete a security review before production.
- Do not store real customer National IDs or process real payments on this preview deployment.

## Deployment steps

1. Put the complete contents of this project in a GitHub repository. The repository root must contain `render.yaml`, `package.json`, `src/`, `migrations/`, and `frontend/`.
2. Create a free Neon PostgreSQL project and copy its connection string. Keep it private. Prefer the pooled connection string for a hosted application; include SSL as supplied by Neon.
3. Sign in to Render and choose **New → Blueprint**. Connect the GitHub repository and select its `render.yaml` file.
4. Render creates the API and static frontend. In the `swass-api` service, add `DATABASE_URL` using the Neon connection string. Keep the generated `JWT_SECRET` and `SWASS_ID_SECRET` private.
5. Confirm the API deploy succeeds. The startup command runs the idempotent Node migration runner before starting NestJS. Check `https://YOUR-API.onrender.com/health`; it must return HTTP 200 and a connected database status.
6. Confirm the static site URL in Render. If Render assigned a different API hostname than `https://swass-api.onrender.com`, edit `frontend/config.js` in GitHub to the exact API URL and redeploy the static site.
7. In the API service, set `CORS_ORIGINS` to the exact static site origin, with no trailing slash, then redeploy the API.
8. Test with disposable demo data only. Create a store/owner using a separately reviewed onboarding process; do not use guessed credentials.

## Optional provider setup

### Safaricom Daraja

Leave M-Pesa disabled until you have a public HTTPS API URL and valid Daraja sandbox credentials. Set `MPESA_ENV=sandbox`, consumer key, consumer secret, shortcode, passkey, callback token and the full callback URL. The callback URL must exactly match the API hostname and callback token. Never put secrets in frontend files or GitHub.

### Twilio OTP SMS

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` in Render's private environment settings. Test with an authorized destination number. Do not expose OTPs in production logs or responses.

## Environment variables

Required: `DATABASE_URL`, `JWT_SECRET` (at least 32 characters), `SWASS_ID_SECRET` (at least 32 characters), and exact `CORS_ORIGINS`.

Optional: `CASHIER_MAX_DISCOUNT_PCT`, `MPESA_ENV`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_URL`, `MPESA_CALLBACK_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM`.

## Before production

Complete dependency-backed TypeScript builds, database/API integration tests, browser checkout tests, OTP and Daraja sandbox tests, backup/restore drills, security review, rate limiting and monitoring. Add a proper tenant/store owner onboarding workflow and verify all authorization boundaries. Never use free preview hosting for live payment processing or as the only copy of business records.
