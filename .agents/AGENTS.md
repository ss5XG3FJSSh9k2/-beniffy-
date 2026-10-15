## How to work (applies to every ticket)
1. Think before coding. If a spec is ambiguous, state your reading in one line and go. Ask only if a wrong guess cannot be undone.
2. Already in the codebase? Before writing anything new: (a) search for an existing helper, component, route or constant that does it; (b) if one exists, reuse it; (c) if it almost fits, make the smallest change to it; (d) only then add new code.
3. Simplicity first. The least code that solves the stated problem. No new library, no abstraction for a single use, no config nobody asked for.
4. Surgical changes. Touch only lines the spec names. No drive-by refactors, renames or reformatting. If you see another bug, report it, do not fix it.
5. Goal-driven. Turn each spec item into a check you can run. Write the failing test first when the spec describes a bug.
6. Money and ledger code: append-only ledger, idempotent operations, no float rounding surprises. Never edit a ledger row.
7. Never trust the client for anything that decides money, status, role or ownership. The server derives it from the token and the database.
8. Honest reporting. Say NOT DONE for anything you did not do. Cite file:line. Show command output for every gate.
9. No emojis, no window.confirm, every user-facing string through t(English, Hindi, Bengali), and never mix Hindi and Bengali in one string.

# FASTNET LOYALTY — AGENT CONSTITUTION
These rules are law. They were each earned by a real failure in this project. Violating one is not a style choice — it is a defect.

## 1. THE REPO IS THE ONLY TRUTH
- First act of EVERY session: `git fetch origin && git reset --hard origin/master`. Confirm and report the hash. Never work in a stale or second folder.
- Work that is not committed AND pushed to master does not exist. Every report ends with the commit hash and the words "pushed to master".
- Never claim a change without `git diff --stat` proving real lines changed in the files you name.

## 2. HONESTY OUTRANKS COMPLETENESS
- Every requested item is reported exactly DONE or NOT DONE. A half-done item reported as done has cost this project more time than any bug.
- Never write victory audits ("everything fully operational") in place of implementation. Audits are not work.
- When citing implementation, cite file:line. If you cannot produce the citation, the item is NOT DONE.

## 3. SCOPE IS A FENCE
- Implement ONLY what the prompt lists. No refactors, no "improvements", no drive-by edits. If you notice something worth fixing, FLAG it in the report; do not touch it.
- Never use the browser subagent unless the prompt explicitly asks. Verification is external (user clicks + independent code review).

## 4. THE GATE BATTERY — run before every commit, paste raw outputs
- `npx eslint src/App.jsx` → 0 errors (kills phantom identifiers; a function called but never defined shipped four dead buttons once)
- `node frontend/scripts/check-hook-deps.js` → all hook dependencies declared before use (kills TDZ runtime crashes)
- `node tests/smoke.test.js` → browser smoke test passes for Customer, Stockist, Admin, Partner. Open the app and each role’s home screen; the console shows no uncaught errors. A green build and regression suite are not enough.
- `node backend/tests/regression.js` → all pass; the count only ever grows. Every bug fixed adds a test.
- `npx vite build` → clean
- `grep -c "window.confirm" frontend/src/App.jsx` → 0 (browsers silently suppress native dialogs; use the global triggerConfirmModal system)
- `grep -c "অর্ডার" frontend/src/App.jsx` → ≥ 25 (Bengali must never silently vanish) and `grep -rc "â€"` in src → 0 (no encoding corruption; all writes UTF-8)
- `grep -c "SHIPPED" frontend/src/App.jsx` → 0 (dead enum; frontend and backend status vocabularies must always match — when an enum changes, grep every sender)

## 5. CODE LAW
- Every user-facing string goes through t(English, Hindi, Bengali). No emojis — Lucide icons only.
- No magic numbers: business rules live in backend/config.js as named constants.
- Money and points are append-only ledgers. Balances are computed, never stored-and-mutated.
- Every money-state operation (release, refund) is idempotent: repeat call = no-op, never double-move.
- Ownership is enforced server-side (a stockist edits only their own products/orders); the UI hiding a button is not security.
- Never render a number you invented: no fallback margins, rates, or amounts. Missing data → omit the line, never fabricate.
- Never ship a control that promises what the backend doesn't do. A button with no working backend path is a lie in pixel form.

## 6. REGULATORY LINES — absolute, no exceptions, flag-and-refuse if a prompt seems to cross them
- Points are EARNED from commission on completed orders only. Paid money NEVER converts into points under any flow (that would make them a regulated prepaid instrument).
- Points credit only on DELIVERED, any payment mode. Cancellation reverses/never-credits.
- Customer funds live with the payment gateway (HELD) — never in a platform account. Refunds are admin-triggered (REFUND_DUE → REFUNDED), amount = paid minus platform commission, and that deduction must remain disclosed at checkout.
- Points: non-transferable, non-cashable. Redeemable against the operator's own services AND, by owner decision, as a coupon discount on a single-shop prepaid order at checkout (BF-CPN). Never convertible to cash, never transferable, never loaded with paid money. Legal review pending before go-live.

## 7. REPORT FORMAT — exactly this, every round
1) synced-from hash  2) each item: DONE/NOT DONE (+ file:line for DONE)  3) raw gate outputs  4) suite count  5) `git diff --stat` paste  6) commit hash + "pushed to master, servers restarted, DB reset"

## 8. STANDING BUSINESS RULES (current, do not re-decide)
- Cancel window: 1 minute. Cancel allowed only while timer alive AND status ∈ {CONFIRMING, PENDING, ACCEPTED, PREPARING}. Ready-for-Pickup kills cancel even with time left.
- Stockist cancel: only before accepting (CONFIRMING/PENDING). After accept, committed.
- Orders reach the stockist queue immediately. Multi-store carts are pickup-only, one sub-order per store.
- No-show: 30-min grace → one reschedule → 20-min grace → auto-cancel (refund minus commission).
- Points reveal to the customer happens in the Delivered popup, not at checkout.
- Coupons: Applies to a single-shop, prepaid order only. Max discount is the order subtotal. Excludes delivery fee. Fully refunded (points returned) on cancellation.

## 9. COMMIT BEFORE RESET, PUSH WHEN DONE
- **Commit before any reset:** Never run `git reset --hard` over uncommitted changes. If `git status` is not clean, commit first: `git add -A && git commit -m "wip: <ticket> — <what works so far>"`. A `wip:` commit is always acceptable.
- **Commit as you go:** Do not reach the end of a long ticket before the first commit. Commit whenever a discrete piece works.
- **Push when the gates pass:** When a ticket is complete and the gate battery passes, push before starting the next ticket. Unpushed work is invisible to the tester and dies with the machine.
- **Check before you reset:** Make this the actual first action of every task, before the fetch: `git status --short`. Output is not empty → commit it before resetting. Output is empty → reset is safe.
- **Recovering work:** Always check `git reflog | head -30` and `git fsck --lost-found` before re-implementing anything that previously worked.
- Every ticket report must end with: `Commit: <hash> pushed to master`. If work is not pushed, state why. Do not report a ticket as DONE while its code exists only in an uncommitted working tree.
- If work vanishes without a reset, report the output of `git status`, `git log --oneline -5`, and `git reflog | head -20` before rebuilding.

## 10. PRESERVE SAVED DEV DATABASE
- **NEVER reset, delete or overwrite `backend/data/dev-db.json`**. That file is Saheel's own test data.
- Run all checks with `npm run dev:seed`, the regression suite (`SEED_MODE=test`), or Playwright, which use in-memory data (`POSTGRES_MODE=mem`).
- Never call `POST /api/admin/reset-db` against a running `npm run dev` server (which persists to `backend/data/dev-db.json`).
- If a task truly needs the saved data reset, **STOP AND ASK FIRST**.
