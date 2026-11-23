# Remote access to your own Host

> Unreleased. Device pairing ships with the v2 Host protocol in a future
> release, and needs a web UI to open: KodaX Space will ship one.

You can reach the KodaX Host on your computer from a phone or another
browser: the page comes from your Host, and the phone pairs once with a
link. No account and no server of ours is involved. For Hosts that a platform
runs for many users, see [Run a KodaX Host](host.md).

Anyone who can use your Host can run commands on your computer. Pairing is
what keeps strangers out, even on a private network: the Host cannot tell
traffic from a tunnel apart from other programs on your machine.

## 1. Turn on pairing

Write `~/.kodax/integrations/host.json` (`$KODAX_HOME/integrations/host.json`
if you set `KODAX_HOME`):

```json
{
  "version": 1,
  "server": {
    "listen": { "hostname": "127.0.0.1", "port": 8787 },
    "pairing": true,
    "webRoot": "/absolute/path/to/the/web/ui"
  }
}
```

- `127.0.0.1` keeps the port off your network. The tunnel reaches it locally.
- `webRoot` is the folder of the web UI. The page and the Host then share one
  address.

Restart the Host so it starts listening:

```bash
kodax host stop
kodax host start
```

To keep it up after a reboot, see
[Keep a Host up on your own machine](host.md#keep-a-host-up-on-your-own-machine).

## 2. Choose how to reach it

Pick by how you will use it. All of these are free.

| Use | Option | Notes |
|---|---|---|
| Any time, long term | Tailscale serve | Fixed address `<machine>.<tailnet>.ts.net` with HTTPS. Only your own devices can open it; the phone needs the Tailscale app. The free Personal plan is for non-commercial use. |
| Long term, no app on the phone | Tailscale funnel, or a named Cloudflare tunnel | Public address. Funnel is in beta, with unpublished bandwidth limits. A named tunnel needs your own domain. |
| Once in a while | Cloudflare quick tunnel | No account, no app. The address changes each time `cloudflared` restarts, and you cannot learn the new one while away. |
| Same Wi-Fi | Your computer's LAN address | HTTP only. Listen on `0.0.0.0` instead of `127.0.0.1`. |

```bash
tailscale serve --bg 8787                     # Tailscale serve
tailscale funnel --bg 8787                    # Tailscale funnel
cloudflared tunnel --url http://127.0.0.1:8787  # Cloudflare quick tunnel
```

Free ngrok is not recommended: it puts a warning page in front of yours, and
scripts on the page can get the warning page too.

## 3. Pair a device

```bash
kodax host pair --name "My phone" --url https://my-pc.tailnet-name.ts.net
```

It prints a link like `https://my-pc.tailnet-name.ts.net/#pair=…`. Open it on
the device. Send it to yourself any way you like, or make a QR code of it.

- The link works once, within 10 minutes. Only the first device to open it
  pairs.
- The code is after `#`, so it never reaches the tunnel, proxies or logs. The
  page removes it from the address bar after pairing.
- The device keeps a cookie that scripts on the page cannot read. Later
  visits connect with it, with no code. Clearing the browser's data means
  pairing again.
- The cookie works only from the address the device paired from. When the
  tunnel address changes, pair again.

Without `--url`, the command prints `/#pair=…`; put your tunnel's address in
front of it.

## 4. Manage devices

```bash
kodax host devices                  # id, name, address, last connection
kodax host devices revoke "My phone"
```

Revoking a device closes its connections at once. Turning `pairing` off in
`host.json` disconnects every paired device and stops new pairing, without a
restart; the device list stays, so you can still clean it up.

These commands talk to the running Host. Start it first.

## What strangers can see

With funnel or a Cloudflare tunnel, your Host's port is on the internet.

- Pairing needs a code from your own computer. A code is 128 random bits, so
  guessing one is hopeless, and it lasts 10 minutes.
- `/healthz` answers only whether the Host is ready. It does not say whether
  you are working or when you last were.
- The web UI's files are public. Your Sessions are not: they go only to
  paired devices.

## Not yet tested

These need the web UI and will be checked before release:

- pairing and connecting through Tailscale serve and a Cloudflare quick
  tunnel;
- an iPhone that stays paired after more than a week without visiting;
- whether each option is reachable reliably from mainland China.
