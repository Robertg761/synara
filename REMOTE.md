# Remote Access Setup

Use this when you want to open Synara from another device (phone, tablet, another laptop).

## Anywhere access (quick tunnel)

For "connect from any network" without port forwarding, Tailscale, or an account, run the server
behind a Cloudflare quick tunnel:

```bash
bun run --cwd apps/server start -- --tunnel --no-browser
# or: SYNARA_TUNNEL=1
```

- Requires the `cloudflared` binary (`pacman -S cloudflared`, `brew install cloudflared`, or
  `winget install Cloudflare.cloudflared`).
- The server stays on its normal bind (loopback by default); cloudflared dials it from the same
  machine and publishes a random `https://<name>.trycloudflare.com` URL.
- The startup pairing link is minted against the tunnel URL and printed **with a QR code** — scan
  it from a phone on any network.
- The tunnel closes with the server. Quick-tunnel URLs change between runs, which is fine:
  pairing links are one-time anyway, and paired devices re-resolve nothing (they store the URL
  they paired with; re-pair after a URL change).

In the desktop app this is **Settings → Remote access → Connect from anywhere**. The tunnel is
independent of the LAN bind toggle and never restarts the backend, so enabling it does not
interrupt running agents. The panel's **Android QR** encodes a `synara://pair?…` deep link that
opens the Android app with the pairing prefilled.

## CLI ↔ Env option map

The Synara CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `SYNARA_MODE`         | Runtime mode.                      |
| `--port <number>`       | `SYNARA_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `SYNARA_HOST`         | Bind interface/address.            |
| `--home-dir <path>`     | `SYNARA_HOME`         | Base directory.                    |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `SYNARA_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `SYNARA_AUTH_TOKEN`   | WebSocket auth token.              |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## 1) Build + run server for remote access

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone:

`http://<your-machine-ip>:3773`

Example:

`http://192.168.1.42:3773`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.
