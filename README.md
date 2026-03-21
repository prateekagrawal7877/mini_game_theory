# Multi-Armed Bandit Experiment App

This project is a complete experiment workflow for a multi-armed bandit game:

- Admin-controlled experiment configuration
- Admin-only dashboard protected by password
- Configurable number of arms (default: 2)
- Optional practice run and required final run
- Built-in A/B testing assignment with per-group visibility conditions
- Post-game questionnaire to capture recall and perceived average for recency-bias analysis
- Automatic metric calculation and on-screen display
- Persistent storage in PostgreSQL for future analysis

## Stack

- Frontend: React + TypeScript + Vite
- Backend API: Express + TypeScript
- Database: PostgreSQL (`pg`)

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file at .env with required credentials:

```bash
ADMIN_PASSWORD="your-very-strong-password"
OTP_SENDER_EMAIL="your-gmail-address@gmail.com"
OTP_SENDER_PASSWORD="your-gmail-app-password"
ALLOW_OTP_DELIVERY_FALLBACK="false"
ENABLE_TEST_ACCOUNT="false"
DATABASE_URL="postgres://username:password@localhost:5432/mini_game_theory"
```

3. Start frontend + backend together:

```bash
npm run dev
```

4. Open the app at:

```text
http://localhost:5173
```

The frontend proxies API calls to:

```text
http://localhost:8787
```

## Participant Flow

1. Instruction screen
- Shows study purpose and participant instructions
- Shows note that memory questionnaire is mandatory and does not affect score
- Allows optional participant ID entry
- Allows practice run (if enabled) and final run start

2. Run gameplay
- Player selects an arm each round
- Rewards are stochastic binary values (0 or 1)
- Active settings are controlled by admin config
- A/B group assignment is automatic when A/B testing is enabled

3. Questionnaire (before metrics)
- System picks a target arm
- Player reports remembered rewards for that arm from most recent to older
- Player reports perceived average reward for that arm
- Questionnaire is required to complete each run

4. Results
- Total reward
- Average reward
- Best arm and its true mean
- Expected regret
- Recency-weighted recall accuracy
- Perceived-average error
- Number of unique arms chosen

Practice run results are shown but not treated as the counted final run.

## Admin Flow

1. Open the app and switch to Admin Dashboard.
2. Login with ADMIN_PASSWORD.
3. Configure experiment:
- Title, purpose, participant instructions
- Number of arms
- Practice enabled/disabled and practice rounds
- Final rounds
- A/B testing enabled/disabled
- Group A and Group B visibility conditions
- Default visibility when A/B is disabled
4. Save config and monitor recent participant sessions/metrics in the dashboard table.

## Database Storage

PostgreSQL is required. The API auto-creates required tables at startup using the `DATABASE_URL` connection.

Tables:

- experiment_config
- sessions
- participants
- participant_experiments
- pulls
- questionnaires
- memory_recall_items
- metrics
- session_history
- auth_otp_codes
- auth_login_tokens
- admin_auth_tokens

This captures full session configuration, per-round pulls, questionnaire answers, and computed metrics for later analysis.

## Build and Lint

```bash
npm run lint
npm run build
```

## Deploy on Vercel

1. Import this repository in Vercel.
2. In Project Settings -> Environment Variables, set:

```bash
ADMIN_PASSWORD="your-very-strong-password"
OTP_SENDER_EMAIL="your-gmail-address@gmail.com"
OTP_SENDER_PASSWORD="your-gmail-app-password"
ALLOW_OTP_DELIVERY_FALLBACK="false"
DATABASE_URL="postgres://username:password@host:5432/database"
```

3. Redeploy after adding environment variables.

Notes:

- API routes are served from `api/[...path].ts` (Express app adapter for Vercel functions).
- Use a hosted PostgreSQL database for both Preview and Production deploys.
- In production, set `ENABLE_TEST_ACCOUNT=false` to disable tester OTP and unlimited final-trial bypass.

### Preview Deploy (Step-by-step)

1. Push your latest branch to GitHub (not `main`).
2. In Vercel Dashboard, click **Add New... -> Project** and import this repository.
3. In **Build and Output Settings**, set:

```text
Framework Preset: Vite
Install Command: npm install
Build Command: npm run check:deploy
Output Directory: dist
```

4. In **Environment Variables**, add all four variables and set the **Environment** selector to include **Preview**:

```text
ADMIN_PASSWORD
OTP_SENDER_EMAIL
OTP_SENDER_PASSWORD
ALLOW_OTP_DELIVERY_FALLBACK=false
ENABLE_TEST_ACCOUNT=false
DATABASE_URL=postgres://username:password@host:5432/database
```

5. Click **Deploy**.
6. For all future preview updates, push commits to the same branch; Vercel will auto-generate/update a Preview URL.
7. Verify Preview URL endpoints:

```text
/
/api/health
/api/participant/experiment
```

## Notes for Future Metric Customization

When you specify the final metric definitions, update metric calculation in:

- src/App.tsx

Backend storage already accepts an extensible metrics payload and stores it in JSON as well as key columns.
