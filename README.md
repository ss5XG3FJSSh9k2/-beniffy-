# Beniffy

A modern loyalty and fulfillment system built for rural ISPs (Internet Service Providers) and local merchants (stockists). Subscribers earn points through local grocery/merchant purchases, which they can redeem for bill discounts or speed boosts with the ISP.

## Features
- **Trilingual Localization:** Support for English, Hindi (हिंदी), and Bengali (বাংলা) out of the box.
- **Translucent UI:** Sleek, modern dark-themed aesthetics utilizing Noto Sans and Plus Jakarta Sans.
- **Split Settlement:** Automatic calculations dividing payouts between local shopkeepers and the platform.
- **Fulfillment Workflows:** Integrated store pickup and home delivery pipelines with post-checkout lock protection.
- **Simulation Suite:** Offline synchronization simulation and WhatsApp message mockup overlay.

## Installation & Setup

1. **Install Dependencies:**
   Run from the project root:
   ```bash
   npm install
   ```

2. **Start Development Servers:**
   Launch both the Express backend and Vite frontend concurrently:
   ```bash
   npm run dev
   ```
   - **Frontend:** http://localhost:5173/
   - **Backend API:** http://localhost:3001/

## Running the Regression Suite

Run the automated integration tests from the root directory:
```bash
node backend/tests/regression.js
```

## Demo Credentials

These preset accounts exist when you start with `npm run dev:seed`, where every account logs in with the demo OTP `123456`.

| Role | Username / Phone | Password / OTP | Notes |
| :--- | :--- | :--- | :--- |
| **Customer** | `9876543210` | OTP `123456` | Standard rural subscriber |
| **Stockist** | `7654321098` | OTP `123456` | Local merchant (Madan Grocers) |
| **Admin** | `9999999999` | OTP `123456` | System operator portal (OTP login required) |
| **Partner** | `adhya@partners.example` | password `partner123` | ISP partner portal |

## How to run for testing
- `npm run dev:seed`: in-memory preset data with the demo OTP; data resets on every launch.
- `npm run dev`: continue where you left off (data is saved to `backend/data/dev-db.json`). OTPs are random and printed in the backend console.
- `npm run dev:fresh`: delete the saved data and start from the beginning.

See [docs/testing.md](docs/testing.md) for details.

## Configuration

- `VITE_RECAPTCHA_SITE_KEY` (frontend build): your reCAPTCHA v3 site key. When it isn't set, no CAPTCHA script is loaded. That's fine for local development, but production needs it together with the backend's `CAPTCHA_SECRET`.
