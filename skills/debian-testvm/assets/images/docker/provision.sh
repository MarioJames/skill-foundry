# Docker CE from Docker's official apt repository, plus Git.
apt-get update
apt-get -y full-upgrade
apt-get install -y --no-install-recommends ca-certificates curl git gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${TESTVM_RELEASE}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker.service containerd.service
docker info --format '{{.ServerVersion}}' >/dev/null
echo "TESTVM_VERSIONS docker=$(docker version --format '{{.Server.Version}}') compose=$(docker compose version --short) git=$(git --version | cut -d' ' -f3)"
