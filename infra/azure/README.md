# Deploying fops-pulse to Azure Container Apps

Target: a **new** container app `fops-pulse` inside the **existing** `blacksmoke`
Container Apps environment in `eastus2` — the same environment that already runs
`fops-api`. Nothing here touches `fops-api`.

```
fops-pulse . blacksmoke-b7a622bd . eastus2 . azurecontainerapps.io
    │                │                 │
    │                │                 └─ region
    │                └─ managed environment (already exists)
    └─ new container app (this deployment)
```

`fops-api` serves `/api/planning-overview/...`, which does **not** exist in this
repo — it is a different codebase. So this is a second app, not a redeploy of
that one.

---

## Step 1 — Install the Azure CLI

Not currently installed on this machine (`az: command not found`).

```bash
winget install --exact --id Microsoft.AzureCLI
```

Reopen the shell afterwards, then:

```bash
az login
```

If the account spans several tenants, select the one holding `blacksmoke`:

```bash
az account set --subscription "<subscription name or id>"
```

Verify the environment is visible before going further:

```bash
az containerapp env list -o table
```

## Step 2 — Confirm what already exists

```bash
az containerapp env show --name blacksmoke --resource-group <rg> --query "{name:name,domain:properties.defaultDomain}" -o json
```

`deploy.sh` auto-detects the resource group, so you do not need to hardcode it.

## Step 3 — Fill in secrets

```bash
cp infra/azure/.env.azure.example infra/azure/.env.azure
openssl rand -base64 48          # paste as SESSION_SECRET
```

`infra/azure/.env.azure` is gitignored. Leave `DATABASE_URL` as the placeholder
on the very first run — Postgres does not exist yet, and step 4 prints the real
host and password.

## Step 4 — Provision and deploy

```bash
./infra/azure/deploy.sh
```

First run creates the container registry and the Postgres server, then prints
the admin password **once**. Store it, paste the real `DATABASE_URL` into
`.env.azure`, and run the script again — it is idempotent, so the second run
reuses everything and only completes the app deployment.

Afterwards, a code-only redeploy is:

```bash
./infra/azure/deploy.sh --image-only
```

## Step 5 — Verify

```bash
curl -fsS https://fops-pulse.<env-domain>/healthz
```

```bash
curl -fsS https://fops-pulse.<env-domain>/readyz
```

`/healthz` proves the process is up. `/readyz` proves Postgres is reachable and
migrations ran — that is the one that actually confirms a good deploy.

```bash
az containerapp logs show -g <rg> -n fops-pulse --follow
```

## Step 6 — Point Entra SSO at the new hostname

`deploy.sh` sets `ENTRA_REDIRECT_URI` to the live FQDN automatically, but Azure
will not accept a callback that is not also registered:

- Entra admin centre → App registrations → the fops app → Authentication
- Add redirect URI: `https://fops-pulse.<env-domain>/api/auth/entra/callback`

Without this, sign-in fails with `redirect_uri_mismatch`.

---

## Step 7 — Continuous deployment from Azure DevOps

`azure-pipelines.yml` at the repo root deploys `dev` to this same container app.
Two one-time setup steps, both in the Azure DevOps UI (neither can be done from
the CLI without permissions we do not have):

1. **Service connection.** Project settings → Service connections → New →
   Azure Resource Manager → Workload identity federation (automatic). Scope it
   to the subscription that holds `FOps-Dev`. Name it exactly `FOps-Dev-ARM`
   (the `azureServiceConnection` variable in the YAML) and tick *Grant access
   permission to all pipelines*.
2. **Pipeline.** Pipelines → New pipeline → Azure Repos Git →
   `FOps-MarketPulse` → Existing Azure Pipelines YAML file →
   `/azure-pipelines.yml`, branch `dev`.

What it does: runs `npm test`, builds the image with `az acr build` inside
`fopsdev`, then `az containerapp update --image ... --revision-suffix b<buildId>`
and polls `/readyz` until the new revision reports `db: up`. `main` builds but
does not deploy; pull requests only run tests.

**The pipeline holds no application secrets.** `az containerapp update --image`
patches the image only and leaves existing secrets and env vars in place, so
`DATABASE_URL`, `SESSION_SECRET`, `GROQ_API_KEY` and the rest stay where
`deploy.sh` put them — as Container Apps secrets, with exactly one copy to
rotate. The consequence is that **changing an env var is still a `deploy.sh`
job**, not a pipeline job. If that becomes annoying, move the keys into a DevOps
variable group (or Key Vault) and add `--replace-env-vars` to the update step —
but then you own two copies of every credential.

---

## Things that will bite you

### pgvector must be allowlisted

`migrations/001_init.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` and
declares `vector(768)` and `vector(384)` columns with an ivfflat index. On
Azure Database for PostgreSQL Flexible Server, extensions are blocked unless
named in the `azure.extensions` server parameter. `deploy.sh` sets it before
first boot. If you provision Postgres by hand and skip it, `node migrate.js`
fails and the container never reaches `server.js` — the app will look like a
crash loop with no obvious cause.

### Why exactly one replica

`server.js` registers five `setInterval` schedulers at module scope,
unconditionally — not behind any feature flag:

| Line   | Schedule    | Work                        |
|--------|-------------|-----------------------------|
| ~629   | every 6 h   | `fetchRealTimeLogistics`    |
| ~2747  | every 15 min| `tickPrices`                |
| ~2752  | interval    | scheduled write             |
| ~2772  | interval    | scheduled write             |
| ~2810  | interval    | scheduled write             |

Every replica runs all of them. Two replicas means duplicate price ticks and
duplicate rows; scale-to-zero means they stop firing entirely and data silently
goes stale. Hence `--min-replicas 1 --max-replicas 1`.

This is also why `CMD npm start` (`migrate.js` then `server.js`) is safe here —
with one replica there is no concurrent-migration race. **If you ever want to
scale out, the schedulers have to move into a separate single-replica worker app
first.** Raising `--max-replicas` alone will corrupt data.

### Ephemeral disk

`data-archive.js` writes JSON snapshots to `data-archive/` on the local
filesystem. Container Apps replicas have **ephemeral** storage: that archive is
wiped on every restart, redeploy, and platform-initiated move. Postgres holds
the primary data, so this is a degradation rather than data loss — but
`getArchiveStats` (surfaced via `auth.js:477`) will report a near-empty archive
after each deploy.

To make it durable, mount Azure Files:

```bash
az containerapp env storage set -g <rg> -n blacksmoke --storage-name fopsarchive --azure-file-account-name <acct> --azure-file-account-key <key> --azure-file-share-name fops-archive --access-mode ReadWrite
```

then add the volume mount at `/usr/src/app/data-archive`. Deferred for now —
it is not needed for the API endpoints to work.

### Secrets path differs from Render

`server.js` and `db.js` both check `/etc/secrets/.env`, a Render convention.
That path does not exist in Azure, so both fall through to plain
`dotenv.config()` and pick up the Container Apps environment variables. This
works as-is, no change needed.

Separately, the `server.js` secrets block has a dead `else if` testing the same
condition as its `if` — harmless, but it is not doing what it looks like it is
doing. Left alone here to keep this change scoped to deployment.

### Cookies behind ingress

`trust proxy` is already set (`server.js:124`) and the session cookie's `secure`
flag keys off `NODE_ENV === 'production' || process.env.RENDER`. The Dockerfile
and `deploy.sh` both set `NODE_ENV=production`, so cookies are marked secure —
correct, since Container Apps ingress terminates TLS. If you ever override
`NODE_ENV`, sign-in over HTTPS will break.

### Cost shape

Roughly, at the settings in `deploy.sh`:

| Resource                          | Config              |
|-----------------------------------|---------------------|
| Container app                     | 1 CPU / 2 GiB, 1 replica always on |
| Postgres Flexible Server          | Burstable `Standard_B2s`, 32 GB |
| Container registry                | Basic |

The container app cannot scale to zero (see above), so it bills continuously.
The `blacksmoke` environment itself is already paid for by `fops-api`.
