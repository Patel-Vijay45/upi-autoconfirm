# Deploy

AutoConfirm runs on **Cloudflare's free plan** (no card needed to start):
- Workers: 100,000 requests a day.
- Queues: 10,000 operations a day (about 2,000 webhook deliveries).
- D1 database: 5 GB.
- Durable Objects (SQLite).

Passwords are hashed inside a Durable Object, because a normal free-plan request only gets 10 ms of CPU. Move to Workers Paid (about $5/month) only when you outgrow these limits.

Deploys run from GitHub Actions ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)):
- **Push to `main`:** tests run, then **staging** deploys.
- **Actions → Deploy → "Run workflow":** tests, then staging, then **production**.

## One-time setup (about 15 minutes)

### 1. Cloudflare account
1. Sign up at **dash.cloudflare.com/sign-up** with the email you want to use, and verify the email.
2. You don't need to create any application.
   - If "Workers & Pages" asks you to create one, you can ignore it. The first deploy creates your free `workers.dev` address itself (a random `autoconfirm-xxxxxx`, or set the GitHub variable `WORKERS_SUBDOMAIN` to choose a name).
   - Your URLs will look like `https://autoconfirm-api.<subdomain>.workers.dev`.
3. Copy your **Account ID**. It's the 32-character code in the browser address after you log in: `dash.cloudflare.com/<account-id>/…`. It's also under **Account home → ⋯ (next to your account) → Copy account ID**.

### 2. API token for GitHub
1. Click the profile icon (top right), then **My Profile → API Tokens → Create Token**.
2. Next to **"Edit Cloudflare Workers"**, click **Use template**.
3. Under **Permissions**, add two rows:
   - Account · **D1** · Edit
   - Account · **Queues** · Edit
4. **Account Resources:** your account. **Zone Resources:** All zones (the template needs it; it's only used for custom domains).
5. **Continue → Create Token**, and copy the token. Cloudflare shows it only once.
   - Never paste it into a chat, an issue or a file in the repo.

### 3. Operator token
This is a long random password that lets you create shops with `tools/admin.mjs`.
- Generate one with at least 40 characters (any password manager, or `openssl rand -base64 36`).
- Keep it in your password manager.

### 4. GitHub environments and secrets
In the GitHub repo, go to **Settings → Environments**.
1. **New environment → `staging`**. Add three **environment secrets**:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 1.
   - `AUTOCONFIRM_ADMIN_TOKEN`: the operator token from step 3.
2. **New environment → `production`**: the same three secrets. Use a *different* operator token if you like.
3. Optional, for a custom domain: add the environment **variables** `API_PUBLIC_URL` and `DASHBOARD_PUBLIC_URL` (e.g. `https://api.example.com`). Also add the routes in Cloudflare.

### 5. First deploy
- Merge the work into `main`. Staging deploys by itself.
- Open the run under **Actions**. The summary shows the API and dashboard URLs, and the smoke test checks they respond.
- For production: **Actions → Deploy → Run workflow** (branch `main`).

On the first run, the deploy script ([tools/deploy/deploy.mjs](../tools/deploy/deploy.mjs)):
- Creates the D1 database, KV namespace and queue.
- Applies the database migrations.
- Generates the three encryption keys (`DEVICE_KEY`, `WEBHOOK_KEY`, `MFA_KEY`) and stores them only in Cloudflare. They are never shown and never replaced, because replacing them would make stored phone, webhook and login secrets unreadable.

### 6. Your first shop
From a phone or computer browser:
1. Open `https://autoconfirm-dashboard.<subdomain>.workers.dev/operator` (staging: `autoconfirm-dashboard-staging…`).
2. Enter your operator token, a shop name and the owner's email, then tap **Create shop**.
   - The token is used for that one request and never stored.
   - Wrong tokens are throttled: 10 per 15 minutes per address.
3. The page shows:
   - the shop's **API keys**, once (put the secret keys in your project's server secrets; new keys can also be made later in the dashboard under Developers);
   - the owner's **setup link** (one-time, 72 hours). Open it on the owner's phone, set a password and scan the QR with an authenticator app (Google Authenticator, Microsoft Authenticator, …).
4. In the dashboard: **Counters & phones → Add counter → Add phone**, and pair the counter phone.

From a computer you can do the same with `node tools/admin.mjs create-merchant --api <API URL> --name "My Shop" --owner you@example.com` (needs `AUTOCONFIRM_ADMIN_TOKEN`).

## Check a deploy without Cloudflare
```bash
node tools/deploy/deploy.mjs --env production --dry-run
```
This builds both Workers and validates their configs without contacting Cloudflare.

## Costs to watch
- Workers Free resets daily. Error 1027 means the 100,000-request day is used up.
- Queues Free: 10,000 operations a day. Each webhook takes roughly 3–5 operations.
- If either gets close, Workers Paid ($5/month) lifts both limits a lot. Nothing in the code needs to change.
