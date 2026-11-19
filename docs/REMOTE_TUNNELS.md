# Remote Access Paths & Tunnels

CodeCockpit Remote speaks one protocol over one port (`wss://<address>:<port>`, default
**47315** — see [REMOTE_PROTOCOL.md](REMOTE_PROTOCOL.md)). Any path that delivers a
reachable TCP address to the phone works. This page covers when to use which path and
how to set the tunnel tools up.

| Path | Use when | Needs a third-party service? |
|---|---|---|
| **Same network** | Phone and desktop share a LAN (home Wi-Fi, office) | No |
| **IPv6 direct** | Both ends have public IPv6 and no gateway on the path blocks inbound IPv6 | No |
| **Tailscale / Netbird / ZeroTier** | Anywhere — recommended default for cross-network use | Account (free tiers) |
| **Plain WireGuard** | You already run a VPS or an exposed UDP port | Self-hosted |
| **frp (TCP forward)** | You have a VPS and want a plain port forward | Self-hosted |

The protocol security is identical on every path: TLS with a self-signed certificate
pinned by fingerprint (TOFU on first connect), then secret pairing → device token.
The path only decides *reachability*, never trust.

## Tailscale (recommended)

Tailscale is a WireGuard-based mesh VPN. Both devices join one tailnet and get a
stable `100.x.x.x` address that works from any network — home, cellular, hotel Wi-Fi.

1. **Desktop**: install [Tailscale](https://tailscale.com/download) for Windows and log
   in. CodeCockpit picks the `100.64/10` address up automatically — it appears in
   Settings → Remote access with the other addresses.
2. **Phone**: install Tailscale from the app store, log in with the **same** account,
   and toggle it on. ("VPN on demand" / always-on keeps it connected.)
3. In the app, add a desktop with the Tailscale address (`100.x.x.x`, port 47315) and
   the pairing secret. Both devices must be on the same tailnet.

Notes:

- Free tier allows 3 users and 100 devices — enough for personal use.
- Traffic stays peer-to-peer in most cases (DERP relays only when punching fails).
- No ports to open on any firewall or router.

## Netbird

[Netbird](https://netbird.io) is an open-source WireGuard mesh with the same shape as
Tailscale (free tier, self-hostable). Install on both ends, join the same network, and
add a desktop using the Netbird-managed IP of the desktop. If you want the mesh model
without a proprietary control plane, this is the closest substitute.

## ZeroTier

[ZeroTier](https://www.zerotier.com) is another overlay network (free up to 25 devices
per network).

1. Create a network on my.zerotier.com, join it from the desktop (system tray app) and
   the phone (Play Store app, join by network ID).
2. Authorize both members in the web console.
3. Use the ZeroTier IP assigned to the desktop (shown in its app) as the address in
   CodeCockpit Remote. Default route is not needed — only reachability of that IP.

## Plain WireGuard

For self-hosters who already run WireGuard: put the desktop and the phone in one
WireGuard network, e.g. with a small VPS as the hub (`AllowedIPs` hub-and-spoke), or
expose one UDP port on your router and peer the phone directly.

- The phone uses the desktop's **tunnel IP** (e.g. `10.0.0.2`) as the address.
- The desktop does not need WireGuard installed if the VPS forwards TCP 47315 to it
  (`iptables`/`nftables` DNAT); in that case the phone dials the VPS's tunnel IP.
- WireGuard config is fully manual — expect to write the `[Interface]`/`[Peer]`
  sections yourself.

## frp (TCP forwarding through a VPS)

[frp](https://github.com/fatedier/frp) forwards a TCP port from a public VPS to the
desktop. Useful when you already have a VPS and don't want a mesh.

1. Run `frps` on the VPS (bind port e.g. 7000, with a token).
2. On the desktop, run `frpc` with:

   ```toml
   serverAddr = "vps.example.com"
   serverPort = 7000
   auth.token = "<token>"

   [[proxies]]
   name = "codecockpit"
   type = "tcp"
   localIP = "127.0.0.1"
   localPort = 47315
   remotePort = 47315
   ```

3. The phone adds a desktop with the VPS address and port 47315.

The desktop's TLS + fingerprint pinning still protects this path end-to-end — the VPS
only relays ciphertext. Prefer a non-obvious `remotePort` and keep `frps` behind its
auth token; CodeCockpit additionally bans an IP for 60 seconds after 5 failed auth
attempts, which also rate-limits scanners hitting a forwarded port.

## Choosing

- **Just want it to work, any network**: Tailscale. Two installs, one login, no router
  changes.
- **Public IPv6 on both ends already**: IPv6 direct — zero extra software. Remember
  some home gateways drop unsolicited inbound IPv6; test once and you'll know.
- **Existing VPS / hardening preferences**: frp or plain WireGuard.
- **Only ever on the same Wi-Fi**: the plain LAN address — nothing to install.
