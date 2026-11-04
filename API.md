# SWASS API quick reference

All routes except `GET /health` and `POST /api/v1/auth/login` require an access token:

```http
Authorization: Bearer <accessToken>
```

## Login

`POST /api/v1/auth/login`

```json
{"phone":"0712345678","password":"your-password"}
```

## Products and stock

- `GET /api/v1/products` — list products for the signed-in user's store.
- `GET /api/v1/products?q=soap` — search name, SKU or barcode.
- `GET /api/v1/products?lowStock=true` — list items at or below their reorder level.
- `POST /api/v1/products` — manager/owner creates a product.
- `PATCH /api/v1/products/:id` — manager/owner updates product details. Stock quantity is deliberately excluded.
- `POST /api/v1/products/:id/stock-adjustments` — manager/owner makes an audited stock change.

Create-product example:

```json
{
  "name":"Cooking Oil 1L",
  "sku":"OIL-1L",
  "barcode":"616100000001",
  "priceKes":250,
  "costKes":190,
  "stockQty":12,
  "reorderLevel":4,
  "requiresBuyerId":false
}
```

Stock-adjustment example:

```json
{"changeQty":-2,"note":"Damaged stock"}
```

A positive `changeQty` adds stock; a negative value removes stock. Every adjustment is recorded in `stock_movements` with the acting user and optional note. Cashiers can view products but cannot create, edit or adjust stock.

## Receipts

- `POST /api/v1/receipts` — create one sale.
- `POST /api/v1/receipts/sync` — sync 1–100 offline sales. Each result is reported independently.

Receipt pricing is taken from the database. Do not send or trust a client-side price as the source of truth.

## Owner / manager dashboard

All dashboard routes require a bearer token with `owner` or `manager` role. Results are restricted to the authenticated user's tenant and store.

- `GET /api/v1/dashboard/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` — sales, transaction count, discount total, estimated cost of goods and gross profit, recorded expenses, estimated operating result, inventory valuation, low-stock count, daily sales, cashier performance and latest subscription/wallet information. The `to` date is exclusive.
- `GET /api/v1/dashboard/expenses?limit=50` — latest recorded expenses (limit 1–200).
- `POST /api/v1/dashboard/expenses` — record `{ "amountKes": 1500, "category": "Transport", "note": "Optional note" }`.

Apply migration `008_dashboard_expenses_cost_snapshot.sql`. New receipt items preserve the product's cost at the time of sale. Historical receipt items are assigned a zero cost by the migration and therefore cannot provide reliable historical gross-profit reporting without a separate backfill.

## M-Pesa Daraja STK Push

Owner/manager endpoints (Bearer JWT required):

- `POST /api/v1/mpesa/stk-push` with `{ "purpose":"wallet_topup", "amountKes":500, "phone":"0712345678" }`.
- `POST /api/v1/mpesa/stk-push` with `{ "purpose":"subscription", "plan":"monthly", "phone":"0712345678" }` or `yearly`.
- `GET /api/v1/mpesa/payments/:id` returns only a payment belonging to the signed-in tenant.

The API returns `pending` after Daraja accepts the STK request. It does not treat the prompt request as proof of payment. A matching successful callback must contain the expected amount, phone and M-Pesa receipt number before a wallet is credited or a subscription is extended. Duplicate callbacks are safe and cannot credit twice. Subscription auto-renew is left disabled; renewal requires a new explicit STK payment.

Public callback: configure `MPESA_CALLBACK_URL` as the complete HTTPS URL ending in `/api/v1/mpesa/callback/<MPESA_CALLBACK_TOKEN>`. Protect the token as a secret. Configure Daraja credentials in the server environment only; never put them in frontend files or commit a real `.env` file.

## Receipt verification and recovery

- `GET /api/v1/receipts/verify/:token` checks a receipt QR token and returns limited public receipt details only (store, receipt number, amount, status and issue time). It never returns buyer details.
- `POST /api/v1/receipt-recovery/request` accepts `{ "phone": "07..." }`. It returns the same generic message whether or not receipts match. Codes expire after five minutes; requests are limited to three per phone and ten per IP per fifteen minutes.
- `POST /api/v1/receipt-recovery/verify` accepts `{ "phone": "07...", "code": "123456" }`. A successful check returns a ten-minute recovery token.
- `GET /api/v1/receipt-recovery/receipts` requires `X-Recovery-Token` and returns at most 50 recent receipts associated with the verified phone. Buyer identity details are not returned.

Configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` for production OTP delivery. Without an SMS provider, production must not be used for receipt recovery. The development-only response includes a test code; production responses never do. The frontend recovery screen is `recover.html`, and receipt verification is `verify.html?token=...`.
