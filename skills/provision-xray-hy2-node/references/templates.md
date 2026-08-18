# Mixed-node configuration templates

## Contents

- [Placeholders and permissions](#placeholders-and-permissions)
- [DNS API pattern](#dns-api-pattern)
- [Xray VLESS Vision/REALITY](#xray-vless-visionreality)
- [Hysteria 2 server](#hysteria-2-server)
- [acmesh certificate install](#acmesh-certificate-install)
- [Mihomo nodes](#mihomo-nodes)
- [External HY2 acceptance](#external-hy2-acceptance)

## Placeholders and permissions

Replace every `<...>` placeholder at runtime and verify no placeholder remains before restarting a service. Generate UUIDs, private keys, short IDs, and passwords uniquely for the target.

Keep server configs and certificate keys owned by `root:root` with mode `600`. Do not commit rendered client config when it contains authentication material.

## DNS API pattern

Use the selected provider's official API. For Cloudflare-compatible DNS-01, inject values without echoing them:

```bash
set +o history
read -r -s -p 'DNS API token: ' CF_Token
export CF_Token
export CF_ZONE_NAME='<zone-name>'
export HY2_DOMAIN='<hy2-domain>'
export SERVER_IPV4='<server-public-ip>'
```

Resolve the zone and account identifiers with a read-only request, query the exact record, and save its current type/name/content/TTL/proxy fields before mutation. Create or update one unproxied A record only after checking for conflicts.

Verify the result through public DNS:

```bash
curl -fsS -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=<hy2-domain>&type=A'
```

## Xray VLESS Vision/REALITY

Server template:

```json
{
  "log": {
    "loglevel": "warning"
  },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "<generated-xray-uuid>",
            "flow": "xtls-rprx-vision"
          }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "target": "<verified-reality-target>:443",
          "serverNames": ["<reality-server-name>"],
          "privateKey": "<generated-xray-private-key>",
          "shortIds": ["<generated-xray-short-id>"]
        }
      }
    }
  ],
  "outbounds": [{ "protocol": "freedom" }]
}
```

Generate material on the server:

```bash
xray uuid
xray x25519
openssl rand -hex 8
```

Mihomo client node:

```yaml
- name: <xray-node-name>
  type: vless
  server: <server-public-ip-or-domain>
  port: 443
  uuid: <generated-xray-uuid>
  network: tcp
  tls: true
  udp: true
  flow: xtls-rprx-vision
  client-fingerprint: chrome
  servername: <reality-server-name>
  reality-opts:
    public-key: <generated-xray-public-key>
    short-id: <generated-xray-short-id>
```

Do not copy private keys, seed values, or capability flags from another server.

## Hysteria 2 server

`/etc/hysteria/config.yaml`:

```yaml
listen: :443

tls:
  cert: /etc/hysteria/certs/<hy2-domain>.fullchain.pem
  key: /etc/hysteria/certs/<hy2-domain>.key

auth:
  type: password
  password: "<generated-hy2-password>"

masquerade:
  type: proxy
  proxy:
    url: https://<masquerade-upstream>/
    rewriteHost: true
```

Generate a password without printing it to shared logs, then write it only to protected server and client configuration.

## acmesh certificate install

From a root login shell with DNS credentials already injected:

```bash
/root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
/root/.acme.sh/acme.sh --issue \
  --dns dns_cf \
  -d '<hy2-domain>' \
  --keylength ec-256 \
  --server letsencrypt

install -d -m 700 /etc/hysteria/certs
/root/.acme.sh/acme.sh --install-cert \
  -d '<hy2-domain>' \
  --ecc \
  --key-file '/etc/hysteria/certs/<hy2-domain>.key' \
  --fullchain-file '/etc/hysteria/certs/<hy2-domain>.fullchain.pem' \
  --reloadcmd 'systemctl try-restart hysteria-server.service'
```

Unset credential variables and restore history immediately. Inspect only variable names and file permissions in persisted acme.sh configuration; never display their values.

## Mihomo nodes

Keep the existing Xray node and add:

```yaml
- name: <hy2-node-name>
  type: hysteria2
  server: <hy2-domain>
  port: 443
  password: <generated-hy2-password>
  sni: <hy2-domain>
  skip-cert-verify: false
  alpn:
    - h3
```

Add both node names to the intended selection group. Tests should assert node type, server/SNI identity, port, certificate verification, group membership, and preservation of the Xray node.

## External HY2 acceptance

Temporary official-client config:

```yaml
server: <server-public-ip>:443
auth: <generated-hy2-password>

tls:
  sni: <hy2-domain>
  insecure: false

socks5:
  listen: 127.0.0.1:<temporary-local-port>
```

After starting the client, verify the exit IP through SOCKS:

```bash
curl --silent --show-error --fail --max-time 15 \
  --socks5-hostname 127.0.0.1:<temporary-local-port> \
  https://api.ipify.org
```

Require a successful client connection, UDP enabled, the expected server exit IP, and the matching bounded server log event. Stop the client and delete the protected temporary config afterward.
