---
name: provision-xray-hy2-node
description: Provision, upgrade, troubleshoot, or audit a Linux server running Xray VLESS Vision/REALITY on TCP/443 and Hysteria 2 on UDP/443; configure DNS, DNS-01 certificates, host/cloud firewalls, and generic Mihomo-compatible clients. Use for Xray Vision + HY2 mixed-node setup, migration, certificate renewal, client configuration, or end-to-end acceptance.
---

# Provision Xray + Hysteria 2 Node

Operate a server that keeps Xray on TCP/443 and Hysteria 2 on UDP/443. Preserve both independent paths and prove them from outside the server.

## Before changing anything

- Use a persistent SSH session when available and close it after verification.
- Consult only official documentation and repositories when versions, installers, provider APIs, or config fields may have changed.
- Read [references/templates.md](references/templates.md) before writing configuration. Replace every placeholder at runtime; never commit credentials or generated private material.
- Collect the target host, public IP, HY2 domain, DNS API credential scope, ACME email, client-config source path, node name, and target proxy group.
- Inspect the target repo's agent instructions and dirty state before editing client configuration.

## Safety boundaries

- Never expose DNS credentials, private keys, UUIDs, short IDs, HY2 passwords, ACME account keys, or unredacted secret-bearing configuration.
- Pass credentials through protected runtime environment variables. Persist only what the selected ACME provider requires, in root-owned files with mode `600`.
- Back up Xray, Hysteria, certificate, and systemd configuration before changes. Preserve unrelated configuration and existing nodes.
- Keep Xray by default and add HY2. Remove an existing path only when the user explicitly requests replacement.
- Treat TCP/443 and UDP/443 as separate listeners. Verify service binding, host firewall, cloud firewall/security group, and network ACL independently.
- Keep the HY2 DNS record unproxied unless the selected DNS/CDN product explicitly supports the required UDP transport.
- Stop when an existing DNS record points elsewhere, certificate identity conflicts, authentication material cannot be confirmed, or the migration could cut off access.

## 1. Inventory the server

Record host, user, operating system, service units, binaries, config paths, listeners, firewall systems, and public IP:

```bash
cat /etc/os-release
systemctl status xray hysteria-server --no-pager -l
ss -lunpt
ps -ef | grep -Ei '[x]ray|[h]ysteria'
curl -4 -fsS --max-time 10 https://api.ipify.org
```

Redact credentials and key material before displaying any config. If Xray already works, retain it and reuse only the public client parameters required for compatibility.

## 2. Configure DNS

Query the authoritative DNS provider for the zone and existing record before deciding whether to create or update it. Save the original record for rollback.

- Create or update `A <hy2-domain> -> <server-public-ip>`.
- Disable proxying for ordinary DNS providers/CDNs that do not relay HY2 UDP.
- Use automatic TTL unless the user requires another value.
- Validate permissions with the smallest read operation the provider supports; do not infer an invalid credential from the wrong verification endpoint.
- Verify through authoritative/public DNS, not only the local resolver.

## 3. Preserve or configure Xray Vision/REALITY

For a new install:

1. Install the current stable Xray build from the official project.
2. Generate a unique UUID, X25519 keypair, and short ID on the target server.
3. Choose and verify an appropriate REALITY target.
4. Apply the template from [references/templates.md](references/templates.md).
5. Run `xray run -test -config <config-path>` before enabling or restarting the service.
6. Confirm TCP/443 listening and retain the private key only on the server.

## 4. Install Hysteria 2 and certificates

Use the current official Hysteria installation path. Install and enable the operating system's cron service before relying on acme.sh renewal.

Run acme.sh from a root login shell. Disable shell history before injecting DNS credentials, issue an EC P-256 certificate through DNS-01, install it to a stable `/etc/hysteria/certs/` path, configure a reload command, unset credentials, and restore history.

Generate an independent strong HY2 password. Reuse other protocol credentials only when required for compatibility and explicitly approved. Apply the template, validate paths and permissions, then enable Hysteria.

## 5. Open UDP/443

Add only the required UDP/443 rule to each applicable layer:

- host firewall;
- cloud firewall or security group;
- network ACL/NAT path.

Do not modify TCP/443, SSH, or unrelated rules. Local listening is not proof that the cloud path is open.

## 6. Update a Mihomo-compatible client source

Find the project's canonical YAML/template/generator before editing. Preserve the Xray node, add one independent `hysteria2` node, use the certificate domain for `server` and `sni`, keep certificate verification enabled, add `alpn: [h3]`, and place the new node in the intended proxy group.

Modify only the true source of generated config and its relevant tests. Prefer Bun when the repository supports it; run YAML parsing plus the repo's type checks/tests and `git diff --check`. Do not commit, push, or deploy unless the user requested it.

## 7. Acceptance

On the server, verify active/enabled services, both protocol listeners, certificate SAN and dates, bounded Hysteria logs, renewal schedule, reload command, and secret-file ownership/mode.

From a separate network location, start the official Hysteria client with a temporary protected config and local SOCKS5 listener. Confirm:

- the client reports a successful connection with UDP enabled;
- an external IP check through SOCKS returns the server public IP;
- server logs show the matching client connection;
- the final domain-based client configuration also works.

Stop the temporary client, delete temporary config/binaries, and close SSH.

## Rollback

- If HY2 fails, stop and disable only Hysteria; Xray TCP/443 should remain available.
- Restore the exact timestamped configs changed in this task, validate, and restart.
- Restore only the DNS record saved before this task.
- Remove only the exact firewall rules added in this task.
- Revert client-config changes from the current diff without overwriting unrelated work.

## Reporting

Report the target host identity, TCP/443 and UDP/443 status, DNS result, certificate issuer/SAN/dates, renewal mechanism, changed client files, external exit-IP evidence, cleanup state, and any remaining process/session. Never report secret values.

## Gotchas

- TCP/443 and UDP/443 can coexist; checking only the port number produces false conflicts.
- DNS/CDN proxying commonly breaks HY2 even when HTTPS works.
- A successful certificate issuance does not prove renewal, permissions, reload, or external UDP reachability.
- Local Fake-IP DNS can corrupt acceptance; test with server IP plus certificate SNI when diagnosing.
- A working comparison node with a failing new node points first to firewall/ACL routing, not certificate replacement.
