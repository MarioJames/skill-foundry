# Deployment and renewal

Use only the steps required by the requested deployment, upgrade, migration, or renewal. Start from current state; a working service does not need reinstallation. Read [templates.md](templates.md) before writing configuration.

## Configure DNS

Query the authoritative DNS provider for the zone and existing record before deciding whether to create or update it. Save the original record for rollback.

- Create or update `A <hy2-domain> -> <server-public-ip>`.
- Disable proxying for ordinary DNS providers/CDNs that do not relay HY2 UDP.
- Use automatic TTL unless the user requires another value.
- Validate permissions with the smallest read operation the provider supports; do not infer an invalid credential from the wrong verification endpoint.
- Verify through authoritative/public DNS, not only the local resolver.

## Preserve or configure Xray Vision/REALITY

For a new install:

1. Install the current stable Xray build from the official project.
2. Generate a unique UUID, X25519 keypair, and short ID on the target server.
3. Choose and verify an appropriate REALITY target.
4. Apply the template from [templates.md](templates.md).
5. Run `xray run -test -config <config-path>` before enabling or restarting the service.
6. Confirm TCP/443 listening and retain the private key only on the server.

## Certificates and renewal

Inspect the current certificate identity, issuer, installed paths, renewal scheduler, and service reload command. For renewal, preserve the current service and credentials; renew the existing certificate and verify its dates, permissions, and reload result. Do not reinstall Hysteria or rotate its password as part of routine renewal.

For a new DNS-01 setup using acme.sh, use a root login shell, disable shell history before injecting DNS credentials, issue an EC P-256 certificate, install it to a stable `/etc/hysteria/certs/` path, and configure the reload command. Unset credentials and restore history. Check the chosen scheduler; install cron only when that renewal mechanism requires it and installation is authorized.

## Install or update Hysteria 2

Use the current official installation path when installation or upgrade is requested. For a new node, generate an independent strong HY2 password; preserve existing credentials during upgrades unless rotation is requested. Reuse other protocol credentials only when required and explicitly approved. Apply the template, validate paths and permissions, then enable or restart the changed service.

## Open UDP/443

Add only the required UDP/443 rule to each applicable layer:

- host firewall;
- cloud firewall or security group;
- network ACL/NAT path.

Do not modify TCP/443, SSH, or unrelated rules. Local listening is not proof that the cloud path is open.

## Update a Mihomo-compatible client source

Find the project's canonical YAML/template/generator before editing. Preserve the Xray node, add one independent `hysteria2` node, use the certificate domain for `server` and `sni`, keep certificate verification enabled, add `alpn: [h3]`, and place the new node in the intended proxy group.

Modify only the true source of generated config and its relevant tests. Prefer Bun when the repository supports it; run YAML parsing plus the repo's type checks/tests and `git diff --check`. Do not commit, push, or deploy unless the user requested it.
