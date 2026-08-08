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
nano .env        # tjek nøgler, PORT, og udfyld evt. PUBLIC_URL + SMTP-felter (se nedenfor)
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

## E-mail (påmindelser + glemt adgangskode)
For at appen kan sende mails (månedlige havepåmindelser og "glemt adgangskode"-links), skal `.env` udfyldes med SMTP-oplysninger:
```
PUBLIC_URL=http://din-ip-eller-domæne     # bruges i links i mails
SMTP_HOST=smtp.dit-mailudbyder.dk
SMTP_PORT=587
SMTP_USER=dit-brugernavn
SMTP_PASS=dit-kodeord-eller-app-password
SMTP_FROM=havehjulet@dit-domæne.dk
```
Mange gratis mailudbydere (Gmail, Outlook m.fl.) kræver et separat "app password" i stedet for din normale adgangskode — søg efter "app password" + udbyderens navn. Efterlades felterne tomme, logger appen bare mailen i konsollen (`journalctl -u havehjulet -f`) i stedet for at sende den — praktisk til test.

Hver bruger slår selv påmindelser til/fra og angiver sin e-mail under ⚙ Indstillinger inde i appen.

## Admin-overblik (valgfrit)
Sæt `ADMIN_USERNAME=dit-brugernavn` i `.env` for at give netop den konto adgang til et lille read-only overblik (🛠-ikon i toppen) over alle brugere, haver og lagerforbrug. Efterlad tom for at slå det fra.

## Push-notifikationer (valgfrit)
For at slå rigtige telefon/browser-notifikationer til (frostvarsler + månedlige påmindelser), generér et VAPID-nøglepar på serveren:
```bash
cd /opt/havehjulet
npx web-push generate-vapid-keys
```
Indsæt de to nøgler i `.env`:
```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```
Genstart servicen. Hver bruger slår det så selv til under ⚙ Indstillinger → Push-notifikationer, på hver enhed de vil have notifikationer på.

## Opdatering af appen senere
```bash
systemctl stop havehjulet
# kopiér nye filer ind (bevar data/-mappen!)
npm install     # hvis der er nye afhængigheder
systemctl start havehjulet
```
