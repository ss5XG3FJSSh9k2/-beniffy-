# Regression Suite Sections

Ordered section files run by `backend/tests/regression.js`.

- `01-core-ledger-orders.js` — Sections 1-22: Payment split math, points, redemptions, cancel, no-show, multi-store, release, COD, fraud, partner leads
- `02-redo-round-and-commission.js` — Sections 23-32: REDO ROUND, feedback, PIN handoff, R4-R7, Round S commission model refactor
- `03-round-t-p1-bills-partners.js` — Round T (bill upload for SKU integrity) & Round P1 (partner data model & auth)
- `04-round-p2-p3-redemptions.js` — Round P2 (redemption approvals & health dashboard) & Round P3 (customer signup partner selection)
- `05-round-p4-postgres.js` — Round P4a/P4b (partner app backend & frontend) & Postgres schema verification
- `06-round-cr-lp.js` — Round CR (customer rewards from partner packages) & Round LP (launch polish bundle)
- `07-round-bf1-to-bf6.js` — Round BF1 through BF6b: pickup slots, KYC visibility, BF3, PL, BF4, BF5a-e, BF6a-b
- `08-round-bf7-to-bf11.js` — Round BF7b through BF11a: shops list, analytics, bill photos, role-scoped login, partner UX
- `09-round-bf12-to-bf16.js` — Round BF12 through BF16: KYC, blacklist, support appeals, rate limits, spec bug fixes
- `10-round-bf17-master.js` — Round BF17: Master Bug Spec Regression Tests
- `11-round-bf18-to-bf21.js` — Round BF18 through BF21-C, TESTER-18, BF-TXN-ALIGN, BF-GR-UI
- `12-bf-cpn-sec-auth.js` — BF-CPN-b, BF-SEC-1, Auth Boundary, BF-SEC-2c, BF-LOGIN-BLANK, BF-ADMIN-FULLWIDTH, BF-KYC-IMG
- `13-bug-report-partner-save.js` — BUG REPORT FIXES (2026-10-07), BF-PARTNER-REGION-GROUP, BF-PARTNER-PROFILE-SAVE, BF-REGION-COUNTS
- `14-bf40-to-bf47-catalog-sync.js` — Sections 40-47: encoding, COD Razorpay IDs, idle rerender, field limits, dev tools gate, seeded phones, shop sync, stockist visibility
- `15-sec48-to-sec54-wholesaler-signup.js` — Sections 48-54: wholesaler sync, phone UI, signup validation, account release
- `16-sec55-to-sec57-handover-refunds.js` — Sections 55-57: pickup slot labels, pilot pay-at-handover, cancelled orders money integrity & refunds
- `17-sec58-to-sec64-orders-feedback.js` — Sections 58-64: order mode, dev tools gating, customer orders, carts sheet, feedback & rating ownership
- `18-ticket65-66-stockist-security.js` — Ticket 65 (seed invariants), Ticket 66 (payout alerts), BF-STOCKIST-SECURITY, BF-SUPPORT-SETTINGS
- `19-sanitization-admin-edits.js` — HTML entity sanitization, Admin user edits allowlist & audit logging, role-based order enrichment
- `20-sec58-online-payments.js` — Section 58: Online Payment & Integrations (Test Mode)
- `21-sec59-messaging-setup.js` — Section 59: Messaging Connector & Notifications + Round BF-SETUP
- `22-bf-reset-and-setup-progress.js` — ROUND BF-RESET (database reset gating & audit logging) + Setup Progress Endpoint
