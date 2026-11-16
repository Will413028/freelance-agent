# deploy — the self-hosted stack on the VM

Plan: `docs/plans/2026-11-15-self-hosted-rebuild.md` (step 2 built the walking skeleton, step 3 the data model, step 9 the deploy script).
Every deploy, scheduled job or new container on the VM needs Will's authorization first.

- Checkout: `/opt/side-income` (a git clone of this repository).
- Env file: `/etc/side-income/compose.env`, mode 0600, owned by root. It sets `APP_IMAGE` (the image tag, e.g. `side-income-web:<commit>`) `POSTGRES_PASSWORD` (hex, so it needs no URL escaping), and `RESEND_API_KEY` and `RESEND_INBOX` for the mail sources (passed to the `daily` service only). Never commit it.
- Ports: `web` publishes `127.0.0.1:3347` only; `db` publishes nothing. `deploy/check-compose.mjs` (in `pnpm check` and CI) fails on any other binding. Tailscale Serve is the only way in.

## Deploy

Run as root, after CI is green for the commit:

```bash
/opt/side-income/deploy/deploy.sh <commit>
```

It checks out the commit, builds `side-income-web:<short sha>`, runs `migrate-pg` with the new image (failure: nothing else changes), points `APP_IMAGE` at the new tag, recreates `web` and waits for its healthcheck; unhealthy means `APP_IMAGE` and the checkout go back to the previous ones and `web` is recreated on them. `deploy/test-deploy.mjs` (in `pnpm check`) covers these decisions with stub `docker` and `git`. The procedure, the migration rule and what is lost without a backup are in [`docs/operations.md`](../docs/operations.md), section 自建 VM.

Run the script file itself, not a copy pasted into a shell: before `deploy.sh` existed (2026-11-15) a pasted block stopped after the migration with no error, because `compose run` read the rest of the pasted lines from stdin, so `web` was never recreated. `deploy.sh` gives the migration `</dev/null`, so even `bash -s < deploy.sh` runs to the end; any other one-off `compose run` typed after more pasted commands needs `-T </dev/null` too.

First install only (no previous `APP_IMAGE` yet): set `APP_IMAGE` in the env file to any placeholder tag, then run `deploy.sh`.

Before cutover (plan step 10) the migrations may be regenerated in place (`web/drizzle-pg/` squashed to one `0000_init.sql`, as in step 3a). The migrator then tries to re-run `0000` on the old database and stops at "already exists": the database holds only shadow data, so remove the `db` volume (`compose down -v`, with Will's go-ahead like every VM deploy) and run the steps above again.

## Browser tier

`browser` (plan step 8d) renders pages for the sources whose `maxTier` is `browser`: Crawlee with Playwright Chromium, image `${APP_IMAGE}-browser` built by `deploy.sh` from `browser/` (`deploy/browser.Dockerfile`). It publishes no port and sits on its own `browser` network shared only with `daily` (`BROWSER_URL=http://browser:3100`), never with `db` or `web`: it loads untrusted pages (`deploy/check-compose.mjs` fails otherwise). It is not a dependency of `daily`: the systemd unit's `ExecStartPre` starts it (`-`: if it cannot start, the run still goes ahead and only the browser-tier sources fail) and `ExecStopPost` removes it, so Chromium holds no memory between runs (limit 1 GB). For a manual `run-source.ts` of a browser source, start it first with `docker compose … --profile jobs up -d --wait browser` and remove it after with `docker compose … --profile jobs rm --stop --force browser`. A change to the unit file takes effect only after it is installed again (`install` and `daemon-reload`, with Will's authorization).

The first deploy of step 8d runs the previous `deploy.sh`, which does not build this image: in the same authorized session, build it by hand with `docker build -f deploy/browser.Dockerfile -t "<APP_IMAGE>-browser" browser`.

## Tailscale Serve

```bash
tailscale serve --bg --https=<port> http://127.0.0.1:3347
tailscale serve status
```

Choose an HTTPS port no other service on the VM's Serve config uses (check `tailscale serve status` first). Serve keeps the setting across restarts. The guard in `web/src/app/_lib/guard.ts` works behind Serve unchanged (plan, spike 1).

## Checks

- `compose ps`: `db` and `web` healthy (`web`'s healthcheck calls `/healthz`, which only checks Postgres).
- From another tailnet machine: `curl -fsS https://<vm>.<tailnet>.ts.net:<port>/healthz`.
- `ss -ltnp`: 3347 listens on 127.0.0.1 only.
- Every page reads Postgres: `/`, `/jobs/<id>` and `/settings` since step 3c, `/sources` since step 6.
