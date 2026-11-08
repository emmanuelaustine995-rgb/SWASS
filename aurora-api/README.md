# AURORA API (isolated)

Deploy as a separate Render web service with root directory `aurora-api`, build command `npm install`, start command `npm start`. Set `AURORA_DATABASE_URL` to a **new, empty PostgreSQL database** and `AURORA_JWT_SECRET` to a random secret of at least 32 characters. Set `AURORA_CORS_ORIGINS` to the new AURORA static-site origin. The Render blueprint also declares the existing TalkSasa, Brevo, WhatsApp Cloud, FlareSend and Tuma environment-variable names so their values can be copied securely from the current service into the new service. Render does not transfer secret values automatically; copy them in the dashboard without pasting them into GitHub.

Run schema setup once using `npm run migrate` with the same database URL. This creates only `aurora_*` tables and never copies or truncates SWASS data.

Implemented: health check, owner registration, phone/password login, tenant-isolated business profile read/update, multi-item receipt persistence and receipt listing. All monetary totals are recalculated by the API from item quantities and unit prices.

Not yet production-complete: OTP/email verification, password recovery, receipt recovery verification, PDF attachment delivery, WhatsApp/email provider integration, tax configuration, logo upload and audited payment settlement. Existing SWASS integration environment variables should be copied securely to this new service only after reviewing provider compatibility; do not copy any secret into source code or the browser.
