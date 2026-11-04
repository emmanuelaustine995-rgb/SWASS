# swass-api

Phase 1 of SWASS: database, login with roles, and receipt creation.

## Status

| Part | State |
| --- | --- |
| `migrations/*.sql` and `scripts/migrate.sh` | Migration scripts included; apply to a fresh PostgreSQL database |
| `test/db_rules.sql` (database rule checks) | Included; requires PostgreSQL to execute |
| `src/` NestJS API (health check, login, role guard, product/inventory management, receipt creation and offline sync) | Implemented; dependency-backed build/runtime verification still required |
| `test/api.test.mjs` | Includes receipt and inventory integration coverage; run against a disposable PostgreSQL database and running API |

## Health check

Once the API is running, `GET /health` checks both the API process and its PostgreSQL connection. It returns HTTP 200 when the database is reachable and HTTP 503 otherwise.

## Run it

Copy `.env.example` to `.env`, replace the example values with private local credentials, and load those values into your shell (or use a dotenv loader locally). Never commit `.env`. For production, configure the same values in your hosting provider's secret settings; see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/swass
export JWT_SECRET=$(openssl rand -hex 32)
export SWASS_ID_SECRET=$(openssl rand -hex 32)   # keep this secret and backed up: IDs cannot be re-matched without it
./scripts/migrate.sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f test/db_rules.sql   # runs in a rolled-back transaction
export CORS_ORIGINS=https://your-frontend.example.com # comma-separated trusted browser origins
npm run build
npm run start:dev          # terminal 1
npm run test:api           # terminal 2, use a throwaway database
```

## Receipt creation rules (`POST /api/v1/receipts`)

One database transaction that:

1. returns the stored receipt if `clientUuid` was already saved (no double charge on retry);
2. requires an active subscription (3 days of grace after expiry);
3. requires the wallet to cover the KSh 2 fee within the overdraft limit;
4. prices items from the database, never from the client;
5. requires buyer name, phone and National ID for items flagged `requires_buyer_id`;
6. limits cashier discounts (default 5%, `CASHIER_MAX_DISCOUNT_PCT`);
7. deducts stock, charges the fee, and awards loyalty points (1 point per KSh 100, adjustable).

Any failure rolls everything back.


## Current implementation boundaries

The current API phase includes tenant/store/user foundations, role-based product creation and editing, searchable inventory and low-stock filtering, audited stock adjustments, role-based receipt issuance, customer capture with keyed National ID hashes, subscription and prepaid-wallet enforcement, inventory deductions, loyalty ledger entries, and bounded offline receipt sync. It includes the M-Pesa STK Push/callback code, Twilio-based OTP receipt recovery, limited public receipt verification, and device-native receipt sharing. These integrations still require provider credentials and end-to-end testing; WhatsApp Business API delivery, email delivery, thermal-printer-specific workflows, and the super-admin analytics UI are not yet implemented. Product and receipt API routes are documented in [`docs/API.md`](docs/API.md).

### Security notes

- Use a unique random `JWT_SECRET` and `SWASS_ID_SECRET`, each at least 32 characters; keep them outside source control.
- Configure `CORS_ORIGINS` to the exact trusted frontend origins. Do not use wildcard origins with authenticated endpoints.
- `request_hash` is an HMAC of the normalized sale request; it does not store raw National ID values.
- A customer's existing National ID binding cannot be silently replaced by a different ID supplied with the same phone number.
- Apply migrations to a backup or disposable database first. Never run integration tests against production data.

## POS frontend (first working screen)

A mobile-friendly cashier screen is included in [`frontend/`](frontend/): staff login, searchable products, low-stock filter, cart quantity controls, discounts, cash/M-Pesa/card selection, buyer details for products requiring identification, receipt issuance and browser printing. The screen talks to the existing API; it does not bypass server-side pricing, billing, stock, role or buyer checks.

### Configure and run the frontend

1. Edit `frontend/config.js` and set `window.SWASS_API_URL` to the API base URL (for local testing, `http://localhost:3000`).
2. Serve the `frontend/` directory from a static web server. For example, from the project root run `python3 -m http.server 8080 --directory frontend`.
3. Open `http://localhost:8080` in a browser. The API must be running separately.
4. Set `CORS_ORIGINS` on the API to the exact frontend origin, e.g. `http://localhost:8080`, then restart the API.

The access token is held only in page memory and is cleared when the page is reloaded or the user logs out. This screen currently requires a live API connection to complete a sale. It does not yet provide offline sale queuing, QR-code image rendering, SMS/WhatsApp/email delivery, M-Pesa STK Push, or receipt lookup/history. The receipt token shown on the printout is a reference token, not a rendered QR code or a public verification endpoint.


## Owner and manager dashboard

Open `http://localhost:8080/dashboard.html` after serving the frontend. Owners and managers can view sales, transaction counts, estimated gross profit, expenses, stock value, low-stock counts, cashier performance and subscription wallet information. The dashboard can record business expenses. API routes are `GET /api/v1/dashboard/summary`, `GET /api/v1/dashboard/expenses` and `POST /api/v1/dashboard/expenses`; all are tenant/store scoped and restricted to owner/manager roles.

Apply migration `008_dashboard_expenses_cost_snapshot.sql` before using these dashboard features. New receipt items save the product cost at the time of sale. Existing receipt rows receive a zero cost default, so historical profit figures before this migration may be understated. Estimated operating result is not audited accounting profit and excludes costs that have not been entered.

### M-Pesa Daraja setup (sandbox first)

1. Create a Daraja app and obtain the Consumer Key, Consumer Secret, shortcode and passkey.
2. Deploy the API to a public HTTPS address so Safaricom can reach its callback. A localhost callback will not work without a secure public tunnel.
3. Set the `MPESA_*` variables shown in `.env.example` on the API host. Set `MPESA_CALLBACK_URL` to the full callback route including the same long random token as `MPESA_CALLBACK_TOKEN`.
4. Keep `MPESA_ENV=sandbox` until sandbox testing is complete. Do not share or commit Daraja credentials.
5. Apply migrations and start the API. Sign in to the owner dashboard, choose wallet top-up or subscription, enter the phone number and request an STK Push.
6. Payment stays pending until Safaricom calls the callback and the server verifies the amount, phone and receipt number. The STK acceptance response alone never marks a payment successful.

The current integration supports one-off STK Push for wallet top-ups and monthly/yearly subscription payments. It does not perform silent recurring charges, automatic M-Pesa renewals, reversals or C2B till/paybill reconciliation. Subscription auto-renew is therefore disabled until an explicit payment is made.

### QR verification, receipt recovery and sharing

The receipt printout now includes a public verification URL based on its random QR token. Open `verify.html?token=...` to check that the receipt exists and has not been voided or returned. The verification response intentionally contains no customer personal information. The POS also offers a share action using the device share sheet (or clipboard fallback).

Customers can use `recover.html` to request a one-time code to the phone number recorded against their receipts. Codes expire after five minutes, are limited to five attempts, and the verified recovery token expires after ten minutes. Production SMS requires Twilio credentials in private environment variables (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`). Development mode may return a test OTP in the response; production never does. Apply migrations 001–009 before testing. Do not expose the development OTP behavior in production.

## Free preview deployment

A Render Blueprint is included in [`render.yaml`](../render.yaml). It provisions a free API service and static frontend. Use Neon for PostgreSQL; Render's free PostgreSQL database expires after 30 days. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the setup sequence and limitations. This is a preview environment only, not production hosting.
