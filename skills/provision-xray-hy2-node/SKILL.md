---
name: provision-xray-hy2-node
description: 部署、排查或审计 Xray Vision/REALITY 与 Hysteria 2 混合节点，包括证书、网络链路和客户端配置。
---

# Xray and Hysteria 2 nodes

Keep Xray on TCP/443 and Hysteria 2 on UDP/443 as independent paths. Select the route from the user's task and inspect current state before deciding what to change.

## Task routes

- **Read-only audit:** use [verification.md](references/verification.md) for inventory and requested evidence. No DNS writes, installations, or certificate issuance; ask only for read access needed by the inspection.
- **Troubleshooting:** inspect the failing path and relevant logs/listeners first. Use [verification.md](references/verification.md); read deployment details only if a supported fix requires them. Preserve the working protocol.
- **Renewal:** use the certificate section of [deployment.md](references/deployment.md). Establish the current renewal mechanism and certificate identity; collect DNS credentials only if actual issuance requires them.
- **Deployment / upgrade / migration:** use the relevant sections of [deployment.md](references/deployment.md), then verify the changed paths with [verification.md](references/verification.md).

Use a persistent SSH session when available and close it after verification. Consult current official documentation when versions, installers, provider APIs, or configuration fields matter. Read [templates.md](references/templates.md) before writing configuration; replace placeholders at runtime.

## Safety boundaries

- Never expose DNS credentials, private keys, UUIDs, short IDs, HY2 passwords, ACME account keys, or unredacted secret-bearing configuration.
- Pass credentials through protected runtime environment variables. Persist only what the selected ACME provider requires, in root-owned files with mode `600`.
- Back up Xray, Hysteria, certificate, and systemd configuration before changes. Preserve unrelated configuration and existing nodes.
- Keep Xray by default and add HY2. Remove an existing path only when the user explicitly requests replacement.
- Treat TCP/443 and UDP/443 as separate listeners. Verify service binding, host firewall, cloud firewall/security group, and network ACL independently.
- Keep the HY2 DNS record unproxied unless the selected DNS/CDN product explicitly supports the required UDP transport.
- Stop when an existing DNS record points elsewhere, certificate identity conflicts, authentication material cannot be confirmed, or the migration could cut off access.

Collect only inputs needed by the selected route. Host identity and current service state are enough to begin an audit; ACME email, DNS write credentials, client source paths, and target proxy groups are required only for operations that use them. Existing authorization covers routine steps within that route, not replacement of an unrelated service.
