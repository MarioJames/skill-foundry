# Inspection, verification, and rollback

For read-only inspection, collect only the requested evidence; do not install software, change DNS or firewalls, or request DNS write credentials. Run an external client probe when connectivity verification is in scope, and clean up its temporary resources. Rollback applies only to changes made by the current task.

## Inventory the server

Record host, user, operating system, service units, binaries, config paths, listeners, firewall systems, and public IP:

```bash
cat /etc/os-release
systemctl status xray hysteria-server --no-pager -l
ss -lunpt
ps -ef | grep -Ei '[x]ray|[h]ysteria'
curl -4 -fsS --max-time 10 https://api.ipify.org
```

Redact credentials and key material before displaying any config. If Xray already works, retain it and reuse only the public client parameters required for compatibility.

## Acceptance

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
