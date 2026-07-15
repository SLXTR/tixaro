# Tixaro

Tixaro ist ein deutschsprachiges Ticketsystem für interne Service-, IT- und Supportanfragen. Es läuft vollständig im Browser und wird per Docker Compose mit PostgreSQL betrieben.

## Funktionen

- Dashboard mit offenen, dringenden und laufenden Tickets
- Rollen für **Administratoren**, **Mitarbeiter** und **anfragende Personen**
- Ticketnummern, Status, Prioritäten, Kategorien, Fälligkeiten und Zuweisungen
- Öffentliche Antworten und interne Teamnotizen
- Benutzerverwaltung und sichere Passwortspeicherung
- Serverseitige Sitzungen, CSRF-Schutz, Rate-Limit und Sicherheits-Header
- Responsive Oberfläche für Desktop, Tablet und Smartphone
- Persistente PostgreSQL-Datenbank, Healthchecks und automatischer Neustart
- GitHub Actions für automatische Tests

## Schnellstart auf Ubuntu 26.04

### 1. Voraussetzungen installieren

Auf dem vServer werden Git, Docker mit Compose, Nginx und optional Certbot benötigt:

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
sudo systemctl enable --now docker nginx
```

Falls dein Anbieter ein minimales Ubuntu-Image verwendet, installiere Docker alternativ nach der offiziellen Docker-Anleitung für Ubuntu.

### 2. Repository laden

```bash
sudo mkdir -p /opt/tixaro
sudo chown "$USER":"$USER" /opt/tixaro
git clone https://github.com/SLXTR/tixaro.git /opt/tixaro
cd /opt/tixaro
```

Da das Repository privat ist, verlangt GitHub beim ersten Klonen eine Anmeldung. Für Server ist ein GitHub-SSH-Schlüssel die bequemste Variante.

### 3. Konfiguration anlegen

```bash
cp .env.example .env
openssl rand -hex 32
nano .env
```

Trage den erzeugten Zufallswert als `SESSION_SECRET` ein. Ändere außerdem zwingend:

- `COMPANY_NAME`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD` (mindestens 12 Zeichen)
- `POSTGRES_PASSWORD`
- das Passwort innerhalb von `DATABASE_URL`

Wichtig: `POSTGRES_PASSWORD` und das Passwort in `DATABASE_URL` müssen identisch sein.

### 4. Tixaro starten

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/health
```

Bei Erfolg antwortet der Healthcheck mit `{"status":"ok"}`. Das Administratorkonto wird beim ersten Start aus der `.env`-Datei erzeugt.

## Domain und HTTPS einrichten

Lege zuerst einen DNS-A/AAAA-Eintrag deiner Domain auf den vServer. Danach:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tixaro
sudo sed -i 's/tickets.example.com/tickets.deine-firma.de/g' /etc/nginx/sites-available/tixaro
sudo ln -s /etc/nginx/sites-available/tixaro /etc/nginx/sites-enabled/tixaro
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d tickets.deine-firma.de
```

Tixaro ist danach über `https://tickets.deine-firma.de` erreichbar. Port 3000 bleibt absichtlich nur an `127.0.0.1` gebunden.

## Aktualisieren

```bash
cd /opt/tixaro
git pull --ff-only
docker compose up -d --build
docker image prune -f
```

## Backup und Wiederherstellung

Backup erzeugen:

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U tixaro tixaro | gzip > "backups/tixaro-$(date +%F-%H%M).sql.gz"
```

Backup wiederherstellen (überschreibt den aktuellen Datenbestand):

```bash
gunzip -c backups/DATEI.sql.gz | docker compose exec -T db psql -U tixaro tixaro
```

Bewahre Backups zusätzlich verschlüsselt außerhalb des vServers auf.

## Lokale Entwicklung

Ohne konfigurierte PostgreSQL-URL verwendet Tixaro eine flüchtige In-Memory-Datenbank:

```bash
npm install
npm run dev
```

Anmeldung im Entwicklungsmodus:

- E-Mail: `admin@tixaro.local`
- Passwort: `ChangeMe123!`

Diese Zugangsdaten sind ausschließlich für die lokale Entwicklung vorgesehen.

Tests starten:

```bash
npm test
```

## Betriebshinweise

- Ändere das initiale Adminpasswort direkt nach dem ersten Login.
- Verwende ausschließlich HTTPS für den öffentlichen Betrieb.
- Öffne PostgreSQL-Port 5432 nicht in der Firewall.
- Sichere die Datenbank regelmäßig und teste die Wiederherstellung.
- Interne Notizen sind nur für Administratoren und Mitarbeiter sichtbar.
- E-Mail-Benachrichtigungen und Dateianhänge sind in dieser ersten Version noch nicht enthalten.

## Lizenz

Privates Firmenprojekt. Alle Rechte vorbehalten.
