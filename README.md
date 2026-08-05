# Havehjulet — opsætning på Proxmox (Debian LXC)

## 1. Opret LXC-containeren
På Proxmox-værten:

```bash
pveam update
pveam available | grep debian
# hent fx debian-12-standard hvis du ikke allerede har den
pveam download local debian-12-standard_12.7-1_amd64.tar.zst

pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname havehjulet \
  --cores 1 \
  --memory 512 \
  --swap 512 \
  --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=1

pct start 200
pct enter 200
```

(Justér `--rootfs`-størrelse, netværk og lagerpulje efter dit setup. 512 MB RAM og 4 GB disk er rigeligt til denne app.)

## 2. Installér Node.js og nginx i containeren

```bash
apt update && apt upgrade -y
apt install -y curl nginx git

# Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

node -v   # bør vise v20.x
```

## 3. Læg appen på plads

Kopiér hele denne mappe (`havehjulet-app/`) op i containeren, f.eks. via `scp` fra din egen maskine:

```bash
# fra din egen computer:
scp -r havehjulet-app root@<lxc-ip>:/opt/havehjulet
```

Eller lav mappen manuelt og kopiér filerne ind med en editor/`nano`.

Inde i containeren:

```bash
cd /opt/havehjulet
cp .env.example .env
nano .env        # tjek at PERENUAL_API_KEY er den rigtige nøgle, og evt. skift PORT
npm install
```

## 4. Opret en dedikeret bruger (valgfrit, men anbefalet)

```bash
useradd -r -s /usr/sbin/nologin havehjulet
chown -R havehjulet:havehjulet /opt/havehjulet
```

## 5. Test at den kører

```bash
sudo -u havehjulet node /opt/havehjulet/server.js
```

Åbn `http://<lxc-ip>:3000` i en browser — du bør se login-siden. Stop den igen med Ctrl+C når testen er ok.

## 6. Kør som systemd-service (så den starter automatisk og genstarter ved fejl)

```bash
cp havehjulet.service /etc/systemd/system/havehjulet.service
systemctl daemon-reload
systemctl enable --now havehjulet
systemctl status havehjulet
```

Logs: `journalctl -u havehjulet -f`

## 7. (Anbefalet) Sæt nginx op foran som reverse proxy

Så du kan bruge port 80 (eller 443 med TLS) i stedet for :3000, og evt. lægge et rigtigt domænenavn/TLS-certifikat på senere.

```bash
cp nginx-havehjulet.conf /etc/nginx/sites-available/havehjulet
ln -s /etc/nginx/sites-available/havehjulet /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
```

Herefter kan du tilgå appen på `http://<lxc-ip>/`.

### Vil du have HTTPS?
Hvis containeren har et rigtigt domænenavn, kan du bruge certbot:
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d dit-domæne.dk
```
Kører du kun internt på dit hjemmenetværk uden domæne, er alm. HTTP fint — men login-adgangskoden sendes da ukrypteret på netværket, så brug det kun på et netværk du stoler på (eller sæt Proxmox/din router til at give containeren et internt HTTPS-certifikat via f.eks. en lokal Caddy/Nginx Proxy Manager-instans).

## Data og backup
Alle konti og havedata gemmes i `/opt/havehjulet/data/db.json`. Tag jævnligt en kopi af den fil (eller hele `/opt/havehjulet/data/`) som backup — f.eks. med en cronjob der kopierer den til Proxmox-værten eller din NAS.

## Opdatering af appen senere
```bash
systemctl stop havehjulet
# kopiér nye filer ind (bevar data/-mappen!)
npm install     # hvis der er nye afhængigheder
systemctl start havehjulet
```
