# Self-Hosting OpenBase

This guide walks through running OpenBase on your own machine or VPS, with and without Docker.

## Requirements

You will need:

- a Linux VPS, local server, or cloud VM
- Node.js 20+
- pnpm
- Redis, or a Redis-compatible hosted service such as Upstash
- Telegram API credentials from `https://my.telegram.org`
- at least one Telegram account session per OpenBase project you intend to provision

Recommended production baseline:

- 2 vCPU
- 4 GB RAM
- persistent disk storage for SQLite indexes and logs
- a domain name pointed at your server

## Environment Variable Setup

Create a root `.env` file from the example:

```bash
cp .env.example .env
```

Fill in the required values:

```env
PORT=3001
NODE_ENV=production
JWT_SECRET=replace-me
STORAGE_SECRET=replace-me-too
REDIS_URL=redis://redis:6379
SQLITE_BASE_PATH=./data/indexes
BACKUP_ROOT_PATH=./data/backups
BACKUP_INTERVAL_MINUTES=720
BACKUP_RETENTION_COUNT=10
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=replace-with-telegram-api-hash
DASHBOARD_URL=https://openbase.example.com
API_PUBLIC_URL=https://api.openbase.example.com
MASTER_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
MOCK_TELEGRAM=false
SKIP_WARMUP=false
```

Optional:

- `RESEND_API_KEY` and `RESEND_FROM_EMAIL` if you want email magic links
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` if you want Google OAuth
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` if you want GitHub OAuth
- `BACKUP_ROOT_PATH`, `BACKUP_INTERVAL_MINUTES`, and `BACKUP_RETENTION_COUNT` if you want to change the default operator backup schedule or storage location

For the dashboard, create `apps/dashboard/.env.local`:

```env
NEXT_PUBLIC_API_URL=https://api.openbase.example.com
```

If you are serving the dashboard and API under the same domain through a reverse proxy, set `NEXT_PUBLIC_API_URL` to the public API origin.

Notes:

- `API_PUBLIC_URL` defaults to `http://localhost:3001` only in development.
- When `NODE_ENV=production`, `API_PUBLIC_URL` must be set explicitly or the API will refuse to start.
- `DASHBOARD_URL` and `API_PUBLIC_URL` are both used in the production CORS allowlist and OAuth callback validation.
- The operator dashboard uses the backup settings above to schedule snapshots and enforce retention automatically.

## Running with Docker Compose

The repo includes a root `docker-compose.yml` that starts:

- Redis on `6379`
- the API on `3001`
- the dashboard on `3000`

From the repo root:

```bash
docker compose up -d
```

Check service status:

```bash
docker compose ps
docker compose logs -f
```

Notes:

- The compose file reads variables from the repo root `.env`.
- Redis data is persisted in a named volume.
- SQLite index data is persisted in a named volume mounted to the repo `data/` path inside the API container.
- The dashboard container expects `NEXT_PUBLIC_API_URL` to point at the public API endpoint.

To stop the stack:

```bash
docker compose down
```

To stop and remove volumes:

```bash
docker compose down -v
```

## Running Without Docker

Install dependencies:

```bash
pnpm install
```

Run typechecks and build:

```bash
pnpm typecheck
pnpm build
```

Start Redis locally or configure `REDIS_URL` to a remote instance.

Start the API:

```bash
pnpm --filter @openbase/api start
```

Start the dashboard in a second terminal:

```bash
pnpm --filter @openbase/dashboard start
```

For development:

```bash
pnpm dev
```

## CLI

The monorepo includes an `openbase` CLI for local workflow automation.

Initialize a config:

```bash
openbase init --api-url http://localhost:3001 --service-role-key your-service-role-key
```

Common commands:

```bash
openbase status
openbase start
openbase stop
openbase migration new add_posts_table
openbase migration run
openbase migration rollback
openbase db push
openbase db pull
openbase db reset --seed true
openbase seed
openbase gen types --out ./openbase/generated.ts
```

## Setting Up a Telegram Account for a Project

OpenBase stores project data in Telegram, so each project needs a usable Telegram account session.

### 1. Create Telegram API credentials

Go to:

```text
https://my.telegram.org
```

Create an application and collect:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

### 2. Prepare a Telegram account

For production usage, it is better to dedicate a Telegram account to each project or workload rather than sharing a single personal account across everything.

Recommended:

- enable two-factor authentication on the account
- avoid using newly created accounts for high-volume workloads immediately
- keep recovery email and login information secure

### 3. Generate a session string

Use the OpenBase dashboard project creation flow, or your Telegram session tooling, to obtain the session string that OpenBase will encrypt and store.

In mock mode (`MOCK_TELEGRAM=true`), any string is accepted and no real Telegram login occurs.

## Reverse Proxy with Nginx

In production, put OpenBase behind Nginx and expose the dashboard and API over HTTPS.

Example split-domain setup:

- dashboard: `openbase.example.com`
- API: `api.openbase.example.com`

Example Nginx config:

```nginx
server {
    listen 80;
    server_name openbase.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name api.openbase.example.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /realtime/v1/ {
        proxy_pass http://127.0.0.1:3001/realtime/v1/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Reload Nginx after updating:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## SSL with Certbot

Install Certbot and the Nginx plugin:

```bash
sudo apt update
sudo apt install certbot python3-certbot-nginx
```

Request certificates:

```bash
sudo certbot --nginx -d openbase.example.com -d api.openbase.example.com
```

Verify auto-renewal:

```bash
sudo certbot renew --dry-run
```

## Production Checklist

Before exposing OpenBase publicly, verify:

- `NODE_ENV=production`
- strong `JWT_SECRET` and `STORAGE_SECRET`
- a valid 64-character `MASTER_ENCRYPTION_KEY`
- `MOCK_TELEGRAM=false`
- `SKIP_WARMUP=false`
- Redis persistence or a managed Redis instance is configured
- dashboard and API are behind HTTPS
- firewall rules only expose required ports
- logs are monitored
- database/index data is backed up
- Telegram sessions are generated and stored securely
- magic-link email provider is configured if you need email auth flows

If you are running on a single VPS, a reverse proxy plus Docker Compose is the simplest production layout.
