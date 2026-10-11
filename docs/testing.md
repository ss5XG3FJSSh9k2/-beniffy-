# How to run for testing

There are three launch modes. Each one sets its own environment (`SEED_MODE`, `EMAIL_MOCK`, `SMS_MOCK`, `R2_MOCK`), so don't set these variables by hand.

| Command | Data | Login codes |
| :--- | :--- | :--- |
| `npm run dev:seed` | In-memory preset data (see the accounts below). Everything you create is lost when the server stops, and the preset comes back on the next launch. | Fixed demo OTP `123456` for every account. |
| `npm run dev` | Your own data, saved to `backend/data/dev-db.json` and loaded again on the next launch (continue where you left off). | Random OTPs. The mock SMS/email service prints each message, including the code, in the backend console. |
| `npm run dev:fresh` | Deletes `backend/data/dev-db.json` and starts empty, so you create the administrator yourself. Data is saved during the session; run `dev:fresh` again for the next empty start. | Demo OTP `123456` for every account (set by `DEMO_OTP=true` in `scripts/start-dev.js`; remove that line to get random codes). |

Only `npm run dev:seed` and the regression suite run in test mode. Test mode is what enables the test-only admin routes (`/api/admin/reset-db`, `/api/admin/override-table`). In `npm run dev` and `npm run dev:fresh` those routes don't exist, and "Clear rate limits" needs an admin login. The demo OTP is on in test mode and wherever `DEMO_OTP=true` is set; the server refuses to start in production with it set.

## Preset accounts (`npm run dev:seed`)

| Role | Phone | OTP / password |
| :--- | :--- | :--- |
| Admin | `9999999999` | OTP `123456` |
| Customer | `9876543210` (Amit Sen) | OTP `123456` |
| Customer | `8765432109` (Radha Roy) | OTP `123456` |
| Stockist | `7654321098` (Madan Grocers) | OTP `123456` |
| Partner | `9876500000` / `adhya@partners.example` | password `partner123` |

## Regression suite

```bash
node backend/tests/regression.js
```

> [!NOTE]
> On Windows PowerShell, do not create files with `>`; use an editor or `Set-Content -Encoding utf8`. Redirection operators (`>`, `>>`) in Windows PowerShell output UTF-16, which causes migration and encoding issues.

