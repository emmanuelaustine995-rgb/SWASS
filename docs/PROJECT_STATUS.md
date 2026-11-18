# SWASS project status

## Included in this project archive
- NestJS API with PostgreSQL migrations 001–009.
- Staff authentication and role-based access control.
- Product inventory, stock movements and low-stock filtering.
- POS frontend with searchable products, cart, discounts, receipt issuance and browser printing.
- Owner/manager dashboard with sales, gross-profit estimates, expenses, inventory valuation and cashier performance.
- M-Pesa Daraja STK Push code for wallet top-ups and monthly/yearly subscription payments, pending callback reconciliation in a public HTTPS deployment and real sandbox verification.
- Public receipt verification endpoint and verification page. It exposes only store name, receipt number, amount, status and issue date.
- OTP-based receipt recovery endpoints and a mobile-friendly recovery page. Production SMS delivery requires configured Twilio credentials.
- Device-native receipt sharing through Web Share API, with clipboard fallback.

## Not yet complete or production-verified
- Actual QR image generation/printing (the receipt currently prints a verification URL).
- Offline sale queue in the browser and automatic retry/synchronization.
- WhatsApp Business API and email delivery.
- Real M-Pesa sandbox end-to-end test and production Daraja credentials.
- Browser automation, full database integration tests and production security review.
- Super-admin analytics and tenant administration.

## Required setup
1. Install dependencies with `npm install`.
2. Configure `DATABASE_URL`, `JWT_SECRET` and `SWASS_ID_SECRET` in private environment variables.
3. Apply migrations 001–009 in order.
4. Set exact `CORS_ORIGINS` for the hosted frontend.
5. For production OTP recovery, configure Twilio credentials. Keep all secrets out of source control.
6. For M-Pesa, configure Daraja sandbox credentials and a public HTTPS callback URL before attempting payment tests.

Development-only OTP requests may return a test code in the response. This behavior is disabled when `NODE_ENV=production`.

## Hosting preparation (November 2026)
- Added a Render Blueprint for a free-preview NestJS API and static frontend (`render.yaml`).
- Added an idempotent Node migration runner (`scripts/migrate.js`) so Render can apply database migrations at API startup without shell access.
- Added free-preview deployment instructions for Render + Neon in `docs/DEPLOYMENT.md`.
- The frontend config currently points to the planned default `https://swass-api.onrender.com` hostname. Update it if Render assigns a different hostname.
- No live deployment has been created. It still requires the project to be present in a GitHub repository connected to Render, a Neon database connection string, and the user's Render/Neon account setup.
- Full TypeScript build remains unverified because dependency installation timed out in this environment. Frontend and migration-runner JavaScript syntax checks passed; HTML parsing and Render YAML parsing passed.
