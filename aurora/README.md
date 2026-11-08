# E-RECEIPT / AURORA — fresh frontend foundation

This is a separate, isolated frontend prototype on the `aurora-fresh-build` branch. It does not replace the current SWASS frontend or modify production data.

- Login branding: E-RECEIPT
- Product/workspace name: AURORA (italic footer)
- Main navigation: Dashboard, Receipt, Profile
- Receipt flow: multi-item cart, automatic subtotal/total, payment selection and printable receipt preview
- Data: no live database is connected; this prototype uses in-memory state only and starts empty on refresh.

Before production:
1. Create a new empty database and tenant/auth schema; do not migrate SWASS business/customer/product/receipt rows.
2. Add secure login/registration and server-side tenant isolation.
3. Reconnect existing WhatsApp, email and SMS providers by reusing their current server-side environment variables; never expose credentials in frontend code.
4. Add durable receipt storage, receipt lookup/recovery, PDF rendering and delivery of the same canonical receipt to WhatsApp/email.
5. Add business profile/logo uploads and verified checkout/tax rules.
6. Configure a separate Render Static Site for this branch with publish directory `aurora`. Do not repoint or replace the current live SWASS service until acceptance testing is complete.

This frontend is a UI prototype, not a production-ready payment or messaging implementation.
