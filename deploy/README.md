# deploy — the self-hosted stack on the VM

Plan: `docs/plans/2026-11-15-self-hosted-rebuild.md` (step 2 builds this walking skeleton; step 9 writes the full operations procedure).
Every deploy, scheduled job or new container on the VM needs Will's authorization first.

- Checkout: `/opt/side-income` (a git clone of this repository).
- Env file: `/etc/side-income/compose.env`, mode 0600, owned by root. It sets `APP_IMAGE` (the image tag, e.g. `side-income-web:<commit>`) and `POSTGRES_PASSWORD` (hex, so it needs no URL escaping). Never commit it.
- Ports: `web` publishes `127.0.0.1:3347` only; `db` publishes nothing. `deploy/check-compose.mjs` (in `pnpm check` and CI) fails on any other binding. Tailscale Serve is the only way in.

## Build and start

Run as root from `/opt/side-income`:

```bash
git fetch origin && git checkout --detach origin/dev
commit=$(git rev-parse --short HEAD)
docker build -f deploy/web.Dockerfile -t "side-income-web:$commit" web
sed -i "s/^APP_IMAGE=.*/APP_IMAGE=side-income-web:$commit/" /etc/side-income/compose.env
compose() { docker compose --env-file /etc/side-income/compose.env -f deploy/compose.yaml "$@"; }
compose up -d db
compose run --rm daily pnpm exec tsx scripts/migrate-pg.ts
compose up -d web
compose ps
```

Walking skeleton only (removed in step 3): `compose run --rm daily pnpm exec tsx scripts/seed-skeleton.ts` writes one synthetic listing shown at `/skeleton`.

## Tailscale Serve

```bash
tailscale serve --bg --https=<port> http://127.0.0.1:3347
tailscale serve status
```

Choose an HTTPS port no other service on the VM's Serve config uses (check `tailscale serve status` first). Serve keeps the setting across restarts. The guard in `web/src/app/_lib/guard.ts` works behind Serve unchanged (plan, spike 1).

## Checks

- `compose ps`: `db` and `web` healthy (`web`'s healthcheck calls `/healthz`, which only checks Postgres).
- From another tailnet machine: `curl -fsS https://<vm>.<tailnet>.ts.net:<port>/skeleton`.
- `ss -ltnp`: 3347 listens on 127.0.0.1 only.
- The old pages (`/`, `/jobs`, `/sources`, `/settings`) still read D1 and fail on the VM, which has no D1 credentials; steps 3 and 6 replace them.
