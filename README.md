# Tixaro

Tixaro ist ein deutschsprachiger Service Desk. Die Arbeitsweise orientiert sich an bewährten OTRS-Konzepten, bleibt aber bewusst schlank: Tickets laufen durch Queues, werden typisiert, priorisiert, zugewiesen und vollständig protokolliert. Die Anwendung läuft vollständig im Browser und wird per Docker Compose mit PostgreSQL betrieben.

## Funktionen

- Dashboard mit offenen, dringenden und laufenden Tickets sowie Queue-Übersicht
- Umfangreiches Rechtekonzept mit geschützten Systemrollen, frei anlegbaren Rollen und 18 granularen Berechtigungen
- Benutzergruppen mit mehreren Rollen, Mitgliedschaften sowie Queue-Zugriffen für Lesen und Bearbeiten
- Ticketnummern, OTRS-nahe Status und Prioritätsstufen, Queues, Ticket-Typen, Fälligkeiten und Zuweisungen
- SLA-Profile mit Erstreaktions- und Lösungszeit, Warnungen und Eskalationsansicht
- Wiedervorlagen pausieren die SLA-Zeit und werden beim Fortsetzen berücksichtigt
- Ticketübernahme und Antwortvorlagen für die Kommunikation
- Separate Leistungsdokumentation mit addierbaren und abziehbaren 15-Minuten-Takten
- Schnellansichten für eigene und eskalierte Tickets
- Öffentliche Antworten und interne Teamnotizen
- CRM mit Unternehmen, Kundenstammdaten, Ansprechpartnern und Portalzugängen
- Eigenes, vereinfachtes Kundenportal für Anfragen, Statusübersicht und zugeordnete Geräte
- Adressvorschläge bei der Kundenerfassung und Kartenstandort in der Kundenakte auf Basis von Photon und OpenStreetMap
- Automatische, eindeutige Zuordnung von Kundenbenutzern über die E-Mail-Firmendomain
- Ressourcenverwaltung für Computer, Notebooks, Smartphones, Lizenzen und weitere Asset-Typen
- Zuordnung von Ressourcen zu Unternehmen und einzelnen Kundenbenutzern
- Automatische Geräteauswahl beim Erstellen eines Tickets für einen Kundenbenutzer
- Gerätekarte im Ticket mit technischer Historie und direkter Verknüpfung oder Lösung
- Ressourcenakte mit Hersteller, Modell, Seriennummer, Betriebssystem, Standort und Garantie
- Rollenbeschränkter Statistikbereich mit großer Karte aller Kundenstandorte und Bestandsabfrage zu einem frei wählbaren Stichtag
- Revisionsfähiger Zuordnungsverlauf für Ressourcen, Kundenbenutzer und Standorte
- E-Mail-Abruf per IMAP oder POP3 sowie Versand per SMTP
- Microsoft-Graph-Anbindung für Abruf und Versand über Shared Mailboxes
- Geführte Postfach-Einrichtung mit einfachen Vorwahlen für Microsoft 365, IMAP/SMTP, POP3/SMTP oder reinen Versand
- Automatische Ticketerstellung aus neuen Nachrichten, Zuordnung von Antworten über die Ticketnummer und Schutz vor Doppelimporten
- Kundenakte mit Kontakten, Ressourcen, Ticketverlauf und Supportkennzahlen
- Benutzerverwaltung und sichere Passwortspeicherung
- Serverseitige Sitzungen, CSRF-Schutz, Rate-Limit und Sicherheits-Header
- Moderne, responsive Tixaro-Oberfläche mit kompakter Navigation für Desktop, Tablet und Smartphone
- Persistente Farbanpassung über sieben Farbwähler für Akzent, Flächen, Sekundärfarbe und Navigation
- Frei anpassbarer Firmenname und eigenes Logo im ursprünglichen Seitenverhältnis; Tixaro bleibt als Standard erhalten
- Aufgeräumtes Admin-Center mit vier klar gegliederten Bereichen und schneller Einstellungssuche
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

Trage getrennte, erzeugte Zufallswerte als `SESSION_SECRET` und `MAIL_SECRET_KEY` ein. Ändere außerdem zwingend:

- `COMPANY_NAME`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD` (mindestens 12 Zeichen)
- `POSTGRES_PASSWORD`
- das Passwort innerhalb von `DATABASE_URL`
- `APP_BASE_URL` auf die öffentliche HTTPS-Adresse des Systems

Optional kann `ADDRESS_SEARCH_URL` auf eine eigene Photon-Instanz und `MAP_TILE_URL` auf einen eigenen Kartenanbieter zeigen. Ohne Änderung werden Photon und OpenStreetMap verwendet; bei einem Ausfall bleiben Adressen weiterhin manuell speicherbar.

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

Bei einer direkten Git-Installation kann ein Administrator unter **Einstellungen → Systemupdate** das neueste veröffentlichte GitHub-Release prüfen und als Fast-Forward-Update installieren. Lokale Änderungen schützen die Installation vor einer automatischen Aktualisierung. Das Remote wird mit `TIXARO_UPDATE_REMOTE` festgelegt. Für private Repositorys kann ein GitHub-Token mit reinen Leserechten über `TIXARO_GITHUB_TOKEN` hinterlegt werden.

Eine Docker-Installation wird weiterhin auf dem Host aktualisiert, da der Container weder das Git-Repository noch die Docker-Verwaltung des Hosts verändern darf:

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
- Interne Notizen, Arbeitszeiten und Verwaltungsbereiche sind ausschließlich mit der jeweiligen Berechtigung sichtbar.
- Das Recht „Statistiken anzeigen“ kann jeder frei angelegten Rolle zugewiesen oder entzogen werden.
- Mailkonten werden unter **Einstellungen → E-Mail-Konten** angelegt. Prüfe jedes Konto zuerst mit „Verbindung testen“ und starte danach einen manuellen Abruf.
- Für Microsoft Graph benötigt die App-Registrierung die Anwendungsberechtigungen `Mail.ReadWrite` und `Mail.Send` mit administrativer Zustimmung. Begrenze den Anwendungszugriff in Exchange auf die benötigte Shared Mailbox.
- IMAP und Microsoft Graph markieren erfolgreich importierte Nachrichten als gelesen. POP3 verwendet die serverseitige UIDL zur Erkennung bereits importierter Nachrichten und löscht keine E-Mails.
- Öffentliche Agentenantworten werden per E-Mail versendet; interne Notizen verlassen das Ticketsystem nie.

## Lizenz

Privates Firmenprojekt. Alle Rechte vorbehalten.
