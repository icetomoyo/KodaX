# Run a KodaX Host for remote clients

> Unreleased. The network listener described here ships with the v2 Host
> protocol in a future release. Today it is on the development line only.

This guide is for whoever runs KodaX Hosts for other people: a platform that
gives each user a cloud workspace, a backend that drives agents, or one person
keeping a Host up on their own machine. It covers everything a Host needs from
the platform and what it promises in return. For reaching your own Host from
a phone, see [Remote access](remote-access.md).

## What a Host is

A Host is one `kodax daemon serve` process. It owns one home directory
(`KODAX_HOME`, normally `~/.kodax`) with that person's settings, Sessions and
memory, and runs their agents. Clients connect to it over WebSocket at `/v2`.

- **One person per Host.** Everyone who can connect is the same person or a
  backend acting for them. Give each user their own Host, in their own
  container or OS account.
- **One Host per home.** A second `kodax daemon serve` on a home that a live
  Host already owns exits with a non-zero code.
- Node.js 22.4 or later, or the standalone binary. See
  [Installation](../getting-started/installation.md).

## Configure the listener

The Host listens on the network only when
`$KODAX_HOME/integrations/host.json` asks it to. Write the file before the
Host starts.

```json
{
  "version": 1,
  "server": {
    "listen": { "hostname": "0.0.0.0", "port": 8080 },
    "jwt": {
      "issuer": "https://auth.example.com",
      "audience": "kodax-host-alice",
      "jwksUrl": "https://auth.example.com/.well-known/jwks.json"
    },
    "owner": "alice",
    "services": ["orders-backend"],
    "allowedOrigins": ["https://app.example.com"],
    "workspaceRoot": "/data/workspace",
    "tools": ["read", "grep", "glob", "edit", "write", "bash"]
  }
}
```

| Field | Meaning |
|---|---|
| `listen` | `{hostname, port}` or `{socketPath}`. The Host does not do TLS; put it behind your ingress or mesh. |
| `jwt` | How the Host checks tokens. See [Tokens](#tokens). |
| `owner` | The JWT `sub` of the person this Host belongs to. Connects as `user`. |
| `services` | JWT subjects of backends. Each connects as `service`. |
| `allowedOrigins` | Browser origins that may connect, such as `https://app.example.com`, without a path. Empty refuses every browser. |
| `pairing` | Lets the person pair browsers without a JWT. For personal remote access; see [Remote access](remote-access.md). |
| `webRoot` | An absolute path to static web pages the Host serves on the same port. See [Serve a web UI](#serve-a-web-ui). |
| `workspaceRoot` | An absolute path. Network clients name projects by their path inside it, and cannot name any project without it. |
| `tools` | The only tools any Run on this Host may use, whoever submits it. Session and Run policies can narrow it, never widen it. Absent means no Host limit. |

The Host refuses to start when:

- the file has a field it does not know, so roll the file back with the image;
- it listens but has neither `jwt` nor `pairing`;
- `jwt` is set but nobody is admitted by it (no `owner`, no `services`);
- `owner` or `services` is set without `jwt`;
- one subject is both `owner` and a service.

### Changing the file while the Host runs

- `owner`, `services`, `allowedOrigins`, `pairing`, `jwt` and `tools` apply
  without a restart. Connections the new file would not admit are closed:
  - a change to `jwt` closes every connection with 4401, so clients come back
    with a token the new check accepts;
  - a dropped subject or origin, a removed `jwt`, or pairing turned off closes
    the affected connections with 4403.
- `tools` applies to the next Run. Runs already working keep their limit.
- `listen`, `workspaceRoot` and `webRoot` need a restart. Changing them only
  logs a warning.
- An edit the Host cannot read does not apply. The previous file stays in
  force, and the error goes to the log.

## Who can connect

| Who | How they prove it | Role |
|---|---|---|
| The person (`owner`) | A JWT whose `sub` is `owner` | `user` |
| A backend in `services` | A JWT whose `sub` is listed | `service` |
| A paired browser | The cookie it got when it paired | `user` |
| A local client (CLI, desktop app) | The token file in the home | `owner` |

- `user` can do what a person does in a UI: chat, answer approvals, read
  history.
- `service` can also bind credentials and tools to Sessions and set Session
  policies. A Session it creates rejects approval requests by default,
  because no person is there to answer.
- Only local clients can manage the Host itself.

A browser always sends an `Origin` header. Its origin must be in
`allowedOrigins`, or be the origin a paired device paired from. A refused
browser is closed with 4403 `origin_not_allowed`. A client that sends no
`Origin` is not a browser and is checked by its token alone.

When the Host closes a connection, the close code tells the client what to do:

| Code | Meaning | Client action |
|---|---|---|
| 4400 | Protocol error | Do not reconnect |
| 4401 | Token expired, invalid, or the JWT check changed | Get a new token, reconnect |
| 4403 | Device revoked, or no longer admitted | Do not reconnect |
| 4408 | Idle for 60 s | Reconnect |
| 4409 | Replaced by a newer connection of the same client | Do not reconnect |
| 4429 | Overloaded | Back off, reconnect |
| 4503 | Stopping, or cannot check tokens right now | Back off, reconnect |

The KodaX client SDK (`connectKodaXHost`) already acts on these codes.

## Tokens

The Host checks a JWT against your identity provider's public keys. It needs
only these claims:

| Claim | Requirement |
|---|---|
| `iss` | Equals `server.jwt.issuer` |
| `aud` | Equals, or is an array containing, `server.jwt.audience`. Give each Host its own audience so a token for one Host does not open another. |
| `sub` | `owner` or one of `services` |
| `exp` | In the future. `nbf` is checked when present. Clocks may be off by 30 s. |

It does not require `typ: at+jwt`, `jti` or `client_id`, so default Keycloak
and Entra tokens work.

- Signatures: RS256/384/512, PS256/384/512, ES256/384/512 or EdDSA. RSA keys
  need at least 2048 bits. `none` and HS* are refused.
- JWKS: HTTPS, or HTTP to exact loopback only. A private address is fine. The
  response must be under 1 MiB, arrive within 10 s and not redirect.
- The Host keeps the key set for 10 minutes. A token naming an unknown `kid`
  reads the set again, at most once every 30 s, so a rotated key works at
  once.
- If the Host has never been able to read the key set, new connections are
  refused as `unavailable`, which a client retries, not `unauthorized`.
  Connections already open stay.

Keep tokens short-lived. When a token expires, the Host closes the connection
with 4401. A client renews before that with `auth.renew`; the SDK does it when
80% of the token's life has passed.

### Minimal example

A platform that signs its own tokens needs one key pair, a JWKS endpoint and
a function that issues tokens. This example uses only Node's standard
library.

```js
import { generateKeyPairSync, sign } from 'node:crypto';

const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'kodax-host-alice';
const KID = 'host-key-1';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

// Serve this at server.jwt.jwksUrl.
export const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' }] };

const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token for one person or backend, valid for five minutes. */
export function issueHostToken(subject) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${part({ alg: 'ES256', typ: 'JWT', kid: KID })}.${part({ iss: ISSUER, aud: AUDIENCE, sub: subject, iat: now, exp: now + 300 })}`;
  const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}
```

A client passes a function that fetches a fresh token from your backend:

```js
import { connectKodaXHost } from '@kodax-ai/kodax/browser'; // '@kodax-ai/kodax/client' in Node

const host = await connectKodaXHost({
  url: 'https://alice.workspaces.example.com',
  client: { name: 'my-app', version: '1.0.0', instanceId: localStorage.kodaxInstanceId },
  credential: async () => (await fetch('/api/kodax-token')).text(),
});
```

`credential` is called for each connection and each renewal.

## Lifecycle

A Host that listens on the network stays up when no client is connected. It
stops on SIGTERM:

1. The listener starts draining. New connections get 503, connected clients
   get a `host.draining` notification, and `/healthz` reports `draining`.
2. Runs stop or pause at a checkpoint, for up to 10 s. Clients see how their
   Runs ended.
3. Each connection is flushed for up to 2 s and closed with 4503.
4. The process cleans up and exits.

The Host part has a 90 s deadline. Cleanup after it can take up to 160 s more,
so the worst case from SIGTERM to exit is about 250 s. A grace period that
long never ends in SIGKILL. A shorter one is also safe: a Host killed early
recovers from its home on the next start. 15 to 20 s is usually enough for
clients to see their Runs end.

If you stop a Host whose `/healthz` lists blockers, Runs still working end
with an unknown outcome and unanswered questions are lost.

### Questions nobody answers

By default an approval request waits 30 minutes, then the call is rejected and
the model carries on. An ordinary question waits forever. A question nobody
answers keeps the Host busy, so it never reports `canStop`. On a platform, set a
question deadline:

```bash
kodax daemon serve --user-input-timeout-ms 1800000
```

## Health: `/healthz`

`GET /healthz` on the listener port answers:

```json
{ "state": "ready", "canStop": true, "blockers": [], "lastActivityAt": 1795389425000 }
```

- `200` when `state` is `ready`; `503` when it is `starting` or `draining`, or
  when the Host cannot report its health. Point readiness probes here.
- `canStop` and `blockers` tell whether stopping now would interrupt work,
  such as `active_runs`, pending questions or a change being written.
- `lastActivityAt` is the last time the Host was seen busy, in UTC
  milliseconds. Use it to reclaim idle Hosts.
- It carries no Session content and asks for no credential.
- While `pairing` is on, it answers only `{ "state": ... }`. A paired Host is
  reached through a tunnel that shows the port to anyone, and the full answer
  would tell a stranger when its owner is at work.

## Logs

Logs are JSON lines, `{time, level, message, data}`. A foreground
`kodax daemon serve` writes them to stdout and to the home's `daemon.log`.
`kodax daemon logs` prints the file.

Security events have `data.source` `host.security` and the message
`[host.security] <event>`, with the event in `data.detail`. They never carry
tokens or parameter values:

- `auth_failed`: a refused token, browser origin, or pairing attempt;
- `permission_decided`: who answered which approval, and how;
- `trusted_use`: a `service` connection used a privileged method or parameter;
- `device_paired`, `device_revoked`.

## Limits

| Limit | Value |
|---|---|
| Frame size | 8 MiB |
| Connections still in their handshake | 32; more get 503 |
| Idle connection | 60 s; clients ping inside it |
| Unread output to one client | 64 MiB, then the socket is dropped |
| Upload chunk / file / whole Host | 512 KiB / 32 MiB / 1 GiB |

## Platform checklist

KodaX does not do these for you:

1. One container or OS account per user, and one Host per home. Mount the
   home on a volume only one Host can use at a time.
2. Block egress to `169.254.169.254` and your cluster's internal network.
   Commands the model runs in `bash` can reach anything the container can.
3. Keep your own provider keys out of the Host's environment. Commands the
   model runs inherit it. Use an egress proxy that adds the key, or have a
   trusted client lend the key per request (a credential lease).
4. TLS at your ingress or mesh.
5. Short-lived JWTs whose `aud` names this Host.
6. If you serve a web UI, a strict CSP and sanitized output. See below.

## Container

Use an init process as PID 1, such as `tini` or `docker run --init`.
Otherwise processes that `bash` commands leave behind become zombies.

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG KODAX_VERSION
RUN npm install -g @kodax-ai/kodax@${KODAX_VERSION}
ENV KODAX_HOME=/data/kodax
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["kodax", "daemon", "serve", "--user-input-timeout-ms", "1800000"]
```

The OS sandbox for shell commands may not work inside an unprivileged
container. Treat the container as the boundary.

A StatefulSet with one replica and a `ReadWriteOncePod` volume keeps one Host
per home. The init container copies `host.json` from a ConfigMap into the
home. To change auth fields without a restart, rewrite the file in the volume.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kodax-alice
spec:
  replicas: 1
  serviceName: kodax-alice
  selector:
    matchLabels: { app: kodax-alice }
  template:
    metadata:
      labels: { app: kodax-alice }
    spec:
      terminationGracePeriodSeconds: 260
      securityContext: { fsGroup: 1000 }
      initContainers:
        - name: host-config
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /data/kodax/integrations && cp /config/host.json /data/kodax/integrations/host.json"]
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: host-config, mountPath: /config }
      containers:
        - name: host
          image: registry.example.com/kodax-host:1.0.0
          ports:
            - { name: v2, containerPort: 8080 }
          readinessProbe:
            httpGet: { path: /healthz, port: v2 }
            periodSeconds: 10
          livenessProbe:
            tcpSocket: { port: v2 }
            periodSeconds: 30
          volumeMounts:
            - { name: data, mountPath: /data }
      volumes:
        - name: host-config
          configMap: { name: kodax-alice-host }
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOncePod"]
        resources:
          requests: { storage: 20Gi }
```

Do not use `/healthz` as the liveness probe: it answers 503 while the Host
starts and drains, and a restart then would interrupt work.

## Keep a Host up on your own machine

A Host the CLI starts for you reads the same `host.json`, so you only need a
service when the Host must be up before anything else starts it.

### Linux: systemd user service

Save as `~/.config/systemd/user/kodax-host.service`. Replace the path with the
output of `command -v kodax`.

```ini
[Unit]
Description=KodaX Host
After=network-online.target

[Service]
ExecStart=/usr/local/bin/kodax daemon serve
Restart=on-failure
RestartSec=10
TimeoutStopSec=260

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kodax-host
loginctl enable-linger "$USER"   # keep it running after you log out
journalctl --user -u kodax-host  # its logs
```

If another Host already owns the home, `serve` exits non-zero and systemd
retries every 10 s until that Host stops.

### Windows: Task Scheduler

`kodax daemon start` starts the Host in the background without a window.
Run it when you sign in:

```powershell
$kodax = (Get-Command kodax.cmd).Source
$action = New-ScheduledTaskAction -Execute $kodax -Argument 'daemon start'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'KodaX Host' -Action $action -Trigger $trigger
```

The task does not restart a Host that crashes. The next sign-in, or any
`kodax` command, starts it again.

## Serve a web UI

`server.webRoot` serves static files on the listener port, so the page and
the Host share one origin.

- `GET` and `HEAD` only. `/` serves `index.html`; there is no fallback to
  `index.html` for unknown paths.
- A path that leaves `webRoot`, through `..` or a link, gets 404.
- Responses carry `X-Content-Type-Options: nosniff` and
  `X-Frame-Options: DENY`, but no CSP and no cache headers.

A page that can reach the Host can run commands on it: a script injected into
the page can submit Runs and answer approvals with the person's own
connection. A paired browser's cookie is `HttpOnly`, so a script cannot steal
it, but it can still use the open page. Two defences matter:

**A strict CSP.** The Host sends none, so put it in the page:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">
```

- No `'unsafe-inline'` or `'unsafe-eval'` in `script-src`.
- `connect-src 'self'` covers the Host's WebSocket on the same origin. If an
  older browser refuses it, add the page's `wss://` origin.
- `img-src` without remote hosts stops model output from loading an image
  whose URL carries data out.

**Sanitized output.** Model replies, tool results, file contents and command
output can all contain text an attacker wrote, such as a web page the model
fetched.

- Render them as text, or as Markdown with raw HTML turned off.
- Allow only `http:` and `https:` links. Open them with
  `rel="noopener noreferrer"`.
- Do not load remote images from model output without asking.
- Show diffs and code as text, never through `innerHTML`.
