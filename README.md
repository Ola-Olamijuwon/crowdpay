# CrowdPay
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)


[![CI](https://github.com/Savitura/crowdpay/actions/workflows/ci.yml/badge.svg)](https://github.com/Savitura/crowdpay/actions/workflows/ci.yml)

**Blockchain-powered crowdfunding for the internet.**

CrowdPay lets creators, startups, and communities raise funds globally. Each campaign gets its own Stellar multisig wallet. Contributions are tracked on-chain, milestone payouts are governed by Soroban smart contracts, and contributors can deposit fiat via MoneyGram's Stellar anchor.

> **Status**: Active development — testnet only.

---

## How it works

1. Creator launches a campaign with a funding goal, deadline, and optional milestones
2. Contributors send USDC (or any Stellar asset — path payments handle conversion)
3. Funds sit in a campaign escrow wallet; the Soroban contract tracks milestone completion
4. Creator requests withdrawal → platform co-signs → funds released to creator
5. If the campaign fails to hit its goal, contributors can claim refunds

---

## Architecture

```
Browser  ──────────────────────────────────────────────────────────────
  React 18 + Vite │ React Router │ Freighter wallet │ i18next (en, fr)
────────────────────────────────────────────────────────────────────────
                            │ HTTPS
                            ▼
Backend  ──────────────────────────────────────────────────────────────
  Express │ JWT auth │ Winston │ Sentry │ rate-limit │ Swagger docs
  ┌────────────────────────────────────────────────────────────────┐
  │ routes: campaigns · contributions · withdrawals · milestones   │
  │         disputes · users · wallets · notifications · webhooks  │
  │         anchor · admin · api-keys                              │
  └────────────────────────────────────────────────────────────────┘
  ┌────────────────────────────────────────────────────────────────┐
  │ services: stellarService · sorobanService · anchorService      │
  │           ledgerMonitor · reconciliation · contributionService │
  │           emailService · kycProvider · webhookDispatcher       │
  │           walletSecrets · campaignStatusService                │
  └────────────────────────────────────────────────────────────────┘
          │                    │                      │
          ▼                    ▼                      ▼
    PostgreSQL          Stellar Horizon         AWS S3 / R2
    (pgv8/pg)          + Soroban RPC        (campaign images)
                             │
                   MoneyGram SEP-24 Anchor
                   (fiat ↔ USDC rails)
```

---

## Project Structure

```
crowdpay/
├── backend/
│   ├── src/
│   │   ├── config/          # env, database, stellar client, logger, constants
│   │   ├── routes/          # one file per resource (campaigns, contributions, ...)
│   │   ├── services/        # all business logic and third-party integrations
│   │   ├── middleware/      # auth, validation, error handler, request ID
│   │   └── index.js         # Express app entry point
│   └── db/
│       ├── schema.sql       # canonical base schema (matches migrations, see Feature Flags)
│       ├── migrate.js       # migration runner (--bootstrap-schema for the fresh flow)
│       └── migrations/      # date-prefixed SQL files
├── frontend/
│   └── src/
│       ├── pages/           # 18 route-level page components
│       ├── components/      # reusable UI (CampaignCard, ContributeModal, ...)
│       ├── context/         # AuthContext, ThemeContext, ToastContext
│       ├── services/        # typed API client functions
│       ├── locales/         # i18n JSON (en, fr)
│       └── config/          # Stellar/Freighter config
└── contracts/
    └── soroban/             # Rust Soroban contracts (escrow, milestone release)
```

---

## Quick Start

### With Docker (recommended)

```bash
git clone https://github.com/Savitura/crowdpay
cd crowdpay
cp backend/.env.example backend/.env
docker compose up
```

| Service  | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend  | http://localhost:3001 |
| API docs | http://localhost:3001/api/docs |

The database schema is applied automatically. Hot-reload is active for both processes.

### Without Docker

```bash
# Prerequisites: Node.js 20+, PostgreSQL 14+

cd backend && npm install && cp .env.example .env
# Fill in .env (see Environment Variables below)
npm run migrate

cd ../frontend && npm install
# Optional: copy frontend defaults before overriding API, Stellar, Firebase, or Sentry settings
cp .env.example .env

# Two terminals:
cd backend  && npm run dev   # http://localhost:3001
cd frontend && npm run dev   # http://localhost:5173
```

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random 32+ char secret |
| `STELLAR_NETWORK` | `testnet` or `mainnet` |
| `STELLAR_HORIZON_URL` | Horizon endpoint URL |
| `PLATFORM_SECRET_KEY` | Stellar secret key for the platform co-signer wallet |
| `USDC_ISSUER` | USDC issuer (`GBBD47...` on testnet) |
| `WALLET_ENCRYPTION_KEY` | Base64 or hex-encoded 32-byte encryption key used by backend wallet recovery |
| `WALLET_SECRET_LOCAL_KEK` | Base64-encoded 32-byte key-encryption key for stored secrets |
| `FRONTEND_URL` | Allowed CORS origin (dev: `http://localhost:5173`) |
| `SMTP_HOST` / `EMAIL_SERVICE_API_KEY` | Email delivery (optional in dev) |
| `PERSONA_API_KEY` / `PERSONA_TEMPLATE_ID` | KYC provider (optional in dev) |
| `AWS_ACCESS_KEY_ID` + S3 vars | Image uploads (optional in dev) |
| `FEATURE_FLAG_PROVIDER` | Feature flag backend: `env` (default), `unleash`, or `launchdarkly` |
| `UNLEASH_API_URL` | Unleash API URL (required for Unleash adapter) |
| `UNLEASH_API_TOKEN` | Unleash API token (required for Unleash adapter) |
| `UNLEASH_APP_NAME` | Unleash application name (default: `crowdpay`) |
| `UNLEASH_ENVIRONMENT` | Unleash environment (default: `development`) |
| `LAUNCHDARKLY_SDK_KEY` | LaunchDarkly SDK key (required for LaunchDarkly adapter) |

The frontend runs locally without an `.env`: Vite proxies `/api` to `http://localhost:3001` and Stellar explorer links default to testnet. Use `frontend/.env.example` when you need to override those defaults or configure optional integrations.

Generate a 32-byte key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Wallet secret key rotation

- `WALLET_SECRET_LOCAL_KEK` and `WALLET_ENCRYPTION_KEY` must remain stable across process restarts. If either key is changed while encrypted wallet secrets still exist, those secrets become unrecoverable.
- For local secret storage, generate the keys once and keep them in a secure secret store or deployment environment.
- To rotate keys safely, decrypt existing secrets with the current key and re-encrypt them with the new key before switching the environment to use the new value.
- In production, using `WALLET_SECRET_PROVIDER=aws-kms` is the recommended approach because AWS KMS can manage key lifecycle without direct key material rotation in the app.

Generate a platform keypair:
```bash
node -e "const {Keypair} = require('@stellar/stellar-sdk'); const kp = Keypair.random(); console.log('Public:', kp.publicKey()); console.log('Secret:', kp.secret());"
```

Fund it on testnet:
```bash
curl "https://friendbot.stellar.org?addr=<PLATFORM_PUBLIC_KEY>"
```

---

## Production database

Production Compose intentionally expects an external PostgreSQL service. See the **[Production PostgreSQL guide](docs/production-database.md)** for provisioning, TLS connection configuration, migrations, pooling, backups, recovery, monitoring, and tuning.

---

## Testing

```bash
cd backend  && npm test       # Node test runner + Supertest
cd frontend && npm test       # Vitest
```

---

## Key Concepts

**Campaign wallet**: Each campaign has a dedicated Stellar account with a 2-of-2 multisig threshold — contributions go directly to it. The platform co-signer key is required for withdrawals.

**Soroban escrow**: The Rust contract at `contracts/soroban/` holds contribution records on-chain. Milestone release calls invoke the contract before the backend builds the withdrawal transaction.

**Anchor deposits**: `anchorService.js` implements SEP-10 (web auth) + SEP-24 (interactive deposit) with MoneyGram. Users can deposit cash or USD and receive USDC in their CrowdPay wallet.

**Reconciliation**: `reconciliation.js` runs periodically to compare `raised_amount` in PostgreSQL against the live Stellar account balance. Discrepancies are logged and resolved.

**Campaign status cron**: `campaignStatusService.js` runs hourly (via `node-cron` in `backend/src/index.js`) to transition active campaigns to `funded` or `failed` when goals or deadlines are met. Set `ENABLE_CAMPAIGN_STATUS_CRON=false` to disable the in-process scheduler (e.g. when using an external cron that calls `POST /api/campaigns/cron/fail-expired` instead). On each transition, `campaignStatusActions.js` sends emails, fires webhooks, creates in-app notifications, logs the change in `campaign_status_events`, and queues contributor refunds for failed campaigns.

**Weekly digest cron**: `weeklyDigestService.js` runs Sunday evenings by default (`0 18 * * 0`) and sends grouped contributor digests for campaign updates, milestone releases, funded/failed transitions, and upcoming deadlines. Set `ENABLE_WEEKLY_DIGEST_CRON=false` to disable it, or override the schedule with `WEEKLY_DIGEST_CRON`.

---

## Feature Flags

Feature flags use pluggable adapters. In addition to the default `env` adapter, [Unleash](https://www.getunleash.io) and [LaunchDarkly](https://launchdarkly.com) are supported. Set `FEATURE_FLAG_PROVIDER` to one of `env` (default), `unleash`, or `launchdarkly` and configure the corresponding environment variables listed above. If the external service is unavailable, the system automatically falls back to the `env` adapter.

---

## Part of Savitura

- **[Fluxa](https://github.com/Savitura/Fluxa)** — the payment infrastructure layer
- **[SaviTools](https://github.com/Savitura/Savitools)** — developer tools for Stellar builders

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
 
## Feature Flags

CrowdPay supports runtime feature flags stored in PostgreSQL. This lets the team ship behind flags, gather feedback, and kill a bad feature instantly without a deploy.

### Database schema

Migration: `backend/db/migrations/20260906_feature_flags.sql`

`backend/db/schema.sql` declares the same canonical table (`key` PK +
`default_enabled`) so the two bootstrap paths agree. Local dev uses
`npm run migrate:fresh` (`psql -f db/schema.sql` followed by `migrate up
--bootstrap-schema`), which skips early migrations whose objects schema.sql
already provides instead of failing on duplicate tables. A CI job
(`backend/db/verify-schema-convergence.js`) guards against drift between the two
paths (#800).

| Column            | Type        | Description                          |
|-------------------|-------------|--------------------------------------|
| `key`             | TEXT (PK)   | Flag identifier (kebab-case)         |
| `enabled`         | BOOLEAN     | Current runtime state                |
| `default_enabled` | BOOLEAN     | Fallback when row is absent          |
| `description`     | TEXT        | Human-readable purpose               |
| `updated_at`      | TIMESTAMPTZ | Last modification time               |

### API

- `GET /api/feature-flags` — list all flags (public, no admin required)
- `GET /api/feature-flags/enabled` — list only enabled flag keys (public)
- `GET /api/admin/feature-flags` — list all flags with details (admin only)
- `PUT /api/admin/feature-flags/:key` — toggle a flag (admin only)

### Frontend usage

Wrap your app with `FeatureFlagsProvider` (already added in `App.jsx`).

```jsx
import { useFeatureFlags } from './context/FeatureFlagsContext';

function MyComponent() {
  const { isEnabled } = useFeatureFlags();
  if (isEnabled('new-dashboard')) {
    return <NewDashboard />;
  }
  return <OldDashboard />;
}
```

Flags are fetched once on app load and cached. Call `refreshFlags()` to force a refresh.

### Defaults

Unknown flags resolve to `false` unless `default_enabled` is explicitly `true`.
