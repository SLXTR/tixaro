# Tixaro

Tixaro ist ein deutschsprachiger Service Desk. Die Arbeitsweise orientiert sich an bewährten OTRS-Konzepten, bleibt aber bewusst schlank: Tickets laufen durch Queues, werden typisiert, priorisiert, zugewiesen und vollständig protokolliert. Die Anwendung läuft vollständig im Browser und wird per Docker Compose mit PostgreSQL betrieben.

## Funktionen

- Dashboard mit offenen, dringenden und laufenden Tickets sowie Queue-Übersicht
- Umfangreiches Rechtekonzept mit geschützten Systemrollen, frei anlegbaren Rollen und 19 granularen Berechtigungen
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
- Eigene Firmendomain je Kunde statt einer allgemeinen Kunden-E-Mail-Adresse
- Automatische Domain-Zuordnung sowie manuelle Zuordnung und Umordnung von Kundenbenutzern, Agenten und Administratoren
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
- Serverseitige Sitzungen mit automatischer Abmeldung anderer Geräte nach Passwortwechsel, CSRF-Schutz, Rate-Limit und Sicherheits-Header
- Minimalistische, responsive Tixaro-Oberfläche mit gut lesbarer Typografie für Desktop, Tablet und Smartphone
- Delegationsschutz für Administrator-, Rollen- und Gruppenrechte sowie serverseitig begrenzte Ticket- und Ressourcensichtbarkeit
- Schutz der Mailanbindung vor Verbindungen zu Loopback-, Link-Local- und Metadaten-Adressen
- Persistente Farbanpassung über sieben Farbwähler für Akzent, Flächen, Sekundärfarbe und Navigation
- Frei anpassbarer Firmenname und eigenes Logo im ursprünglichen Seitenverhältnis; Tixaro bleibt als Standard erhalten
- Übersichtliche Einstellungen mit klaren Bereichen und schneller Suche
- Einmaliger Einrichtungsassistent für Firma, URL, Zeitzone, Queue, SLA und Administratorkonto
- Persistente PostgreSQL-Datenbank, Healthchecks und automatischer Neustart
- GitHub Actions für automatische Tests

## Schnellstart auf Ubuntu 26.04

### 1. Voraussetzungen installieren

Auf dem vServer werden nur Git und Docker mit Compose benötigt. Ein bereits laufender Nginx, Nginx Proxy Manager oder SWAG wird vom Installationsskript erkannt und weiterverwendet. Ist noch kein Nginx-basierter Reverse Proxy vorhanden, startet Tixaro einen eigenen schlanken Nginx-Container.

```bash
sudo apt update
sudo apt install -y git curl docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Melde dich danach einmal neu am Server an, damit die Docker-Gruppenberechtigung aktiv wird. Falls dein Anbieter ein minimales Ubuntu-Image verwendet, installiere Docker alternativ nach der offiziellen Docker-Anleitung für Ubuntu.

### 2. Repository laden

```bash
sudo mkdir -p /opt/tixaro
sudo chown "$USER":"$USER" /opt/tixaro
git clone https://github.com/SLXTR/tixaro.git /opt/tixaro
cd /opt/tixaro
```

Das Repository ist öffentlich und kann ohne vorherige GitHub-Anmeldung geklont werden.

### 3. Starten

```bash
sh install.sh
```

Starte dieses Skript als normaler Installationsbenutzer und nicht mit `sudo`. Nur beim einmaligen Einrichten des Update-Helfers fragt das Skript gezielt nach der sudo-Freigabe.

Das Skript fragt zuerst, unter welcher vollständigen URL das Frontend erreichbar sein soll, zum Beispiel `https://tickets.deine-firma.de`. Diese Adresse wird für den Reverse Proxy, Links in E-Mails, den Einrichtungsassistenten und die abschließende Installationsmeldung verwendet.

Anschließend zeigt das Skript alle laufenden Container an und sucht nach einem vorhandenen Reverse Proxy:

- Wird genau ein Proxy-Container erkannt, verbindet das Skript ihn mit dem gemeinsamen Docker-Netzwerk `tixaro_proxy`.
- Werden mehrere Proxys erkannt, fragt das Skript, welcher verwendet werden soll.
- Läuft Nginx direkt auf dem Linux-Host, wählt Tixaro automatisch einen freien lokalen Port und erzeugt `.tixaro/nginx-host.conf`.
- Ist kein Proxy vorhanden, wird ein eigener Nginx-Container gestartet.

Die Anwendung selbst veröffentlicht keinen festen Host-Port mehr. Dadurch kollidiert sie nicht mit Anwendungen, die bereits Port 3000 verwenden. Ein vorhandener Proxy erreicht Tixaro intern stabil unter `tixaro-app:3000`. Bei Nginx Proxy Manager wird dafür ein Proxy Host mit dem beim Installieren angegebenen Domainnamen, Forward Host `tixaro-app` und Forward Port `3000` angelegt.

Öffne danach die vom Skript ausgegebene Adresse mit `/setup`. Der Assistent übernimmt die öffentliche URL bereits als Vorgabe und fragt Firmenname, Zeitzone, zentrale Queue, Standard-SLA und das erste Administratorkonto ab. Danach wird er dauerhaft gesperrt. Sitzungs- und Mail-Schlüssel werden beim ersten Containerstart automatisch erzeugt und dauerhaft im Volume `tixaro_data` gespeichert.

Für eine unbeaufsichtigte Installation kann die URL vorgegeben werden:

```bash
TIXARO_URL=https://tickets.deine-firma.de sh install.sh
```

Bei mehreren erkannten Proxys kann zusätzlich `TIXARO_PROXY_CONTAINER=containername` gesetzt werden. Der gewählte Betriebsmodus wird gespeichert, damit ein von Tixaro selbst gestarteter Nginx bei Updates nicht mit einem fremden Proxy verwechselt wird.

Zum Schluss kann das Skript Ein-Klick-Updates aktivieren. Dafür wird einmalig mit `sudo` ein eng begrenzter Systemdienst eingerichtet. Die Webanwendung selbst erhält weder Root-Rechte noch Zugriff auf den Docker-Socket. Alle dauerhaft verwendeten Werte stehen danach in `.env`; die Vorlage `.env.example` enthält weitere Optionen.

## Domain und HTTPS einrichten

Lege zuerst einen DNS-A/AAAA-Eintrag deiner Domain auf den vServer. Bei Nginx Proxy Manager aktivierst du im zuvor angelegten Proxy Host anschließend unter **SSL** ein Zertifikat und **Force SSL**.

Wenn Nginx direkt auf dem Host läuft, hat das Installationsskript bereits eine passende Konfiguration mit der gewählten URL und einem freien internen Port erzeugt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo cp .tixaro/nginx-host.conf /etc/nginx/sites-available/tixaro
sudo ln -s /etc/nginx/sites-available/tixaro /etc/nginx/sites-enabled/tixaro
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d tickets.deine-firma.de
```

Passe im letzten Befehl nur den Domainnamen an. Die lokale Portfreigabe ist ausschließlich an `127.0.0.1` gebunden. Bestehende Proxy-Konfigurationen und Container werden vom Skript nicht überschrieben oder neu gestartet.

## Aktualisieren

Unter **Einstellungen → Updates** kann ein Administrator nach einem veröffentlichten GitHub-Release suchen und es mit einem Klick installieren. Der Host-Helfer übernimmt ausschließlich den angeforderten Release-Tag, prüft Fast-Forward-Fähigkeit und Versionsnummer, baut die Container neu und startet Tixaro. Lokale Änderungen brechen den Vorgang zum Schutz der Installation ab. Nach dem Containerwechsel wartet das Skript auf den erfolgreichen Healthcheck und lädt einen verwendeten Nginx-Container kontrolliert neu, damit dessen Upstream nicht auf der alten Container-IP stehen bleibt. Bei Host-Nginx und beim mitgelieferten Nginx bleibt der einmal gewählte lokale Port bei späteren Updates unverändert, sodass die aktive Proxy-Konfiguration weiterhin auf dasselbe Ziel zeigt.

Installationen bis einschließlich Version 1.0.5 aktualisieren den Systemdienst einmalig manuell. Führe dazu als ursprünglicher Installationsbenutzer im Tixaro-Verzeichnis `git pull --ff-only` und anschließend `sh install.sh` aus. Ab Version 1.0.6 wird der Helfer direkt aus der Installation gestartet und bei künftigen Releases automatisch mitaktualisiert.

Installationen bis einschließlich Version 1.0.9 benötigen für den Wechsel auf eine neuere Version ebenfalls einmalig `git pull --ff-only` und `sh install.sh`. Ab Version 1.0.10 verarbeitet der Host-Helfer auch kompakte, einzeilige JSON-Antworten der GitHub-API zuverlässig.

Der Button führt bewusst kein `sudo` im Container aus und klont keinen Quellcode in den laufenden Container. Der einmalig installierte Dienst läuft als normaler Installationsbenutzer und besitzt nur den festen Tixaro-Ablauf. Falls der Dienst nicht aktiviert wurde, kann weiterhin manuell aktualisiert werden:

```bash
cd /opt/tixaro
git pull --ff-only
sh install.sh
docker image prune -f
```

Der Dienststatus lässt sich auf dem Server prüfen:

```bash
systemctl status tixaro-update.timer
journalctl -u tixaro-update.service
```

Bei einem GitHub-API-Limit oder einem privaten Repository kann in `.env` optional `TIXARO_GITHUB_TOKEN` gesetzt werden. Der Host-Helfer liest den Token über eine geschützte temporäre Curl-Konfiguration ein, damit er nicht in der Prozessliste erscheint. Fehlgeschlagene Anforderungen werden einmalig verarbeitet; die konkrete Ursache steht anschließend unter Updates und im Systemprotokoll. Der Systemdienst führt den Helfer direkt aus der geprüften Tixaro-Installation aus, damit zukünftige Releases keine veraltete Kopie unter `/usr/local` zurücklassen.

## Vollständig deinstallieren

> **Achtung:** Die folgenden Schritte löschen alle Tixaro-Tickets, Kunden, Benutzer, Einstellungen, Anhänge und internen Schlüssel unwiderruflich. Erstelle vorher ein Backup, falls Daten erhalten bleiben sollen.

Lösche zuerst im verwendeten Reverse Proxy den für Tixaro angelegten Proxy Host beziehungsweise Server-Block samt Zertifikat. Andere Proxy Hosts bleiben bestehen.

Deaktiviere anschließend den Update-Helfer und entferne nur dessen Tixaro-Dateien:

```bash
sudo systemctl disable --now tixaro-update.timer
sudo rm -f /etc/systemd/system/tixaro-update.timer /etc/systemd/system/tixaro-update.service /usr/local/libexec/tixaro-update
sudo systemctl daemon-reload
```

Wechsle zuerst in das Installationsverzeichnis und stoppe beide möglichen Compose-Varianten. Die vorhandene fremde Nginx- oder Proxy-Installation wird dabei nicht beendet:

```bash
cd /opt/tixaro
docker compose -f docker-compose.yml -f docker-compose.nginx.yml down --volumes --remove-orphans
```

Falls ein vorhandener Proxy-Container bei der Installation angebunden wurde, trenne nur dessen Tixaro-Netzwerkverbindung. Die beiden Werte werden sicher aus `.env` gelesen, ohne die Datei als Shell-Code auszuführen:

```bash
proxy_container="$(sed -n 's/^TIXARO_PROXY_CONTAINER=//p' .env | tail -n 1)"
proxy_network="$(sed -n 's/^TIXARO_PROXY_NETWORK=//p' .env | tail -n 1)"
[ -n "$proxy_network" ] || proxy_network="tixaro_proxy"
[ -z "$proxy_container" ] || docker network disconnect "$proxy_network" "$proxy_container"
docker network rm "$proxy_network"
```

Wurde die erzeugte Host-Nginx-Konfiguration installiert, entferne ausschließlich diese Site und lade Nginx neu:

```bash
sudo rm -f /etc/nginx/sites-enabled/tixaro /etc/nginx/sites-available/tixaro /etc/nginx/conf.d/tixaro.conf
sudo nginx -t
sudo systemctl reload nginx
```

Zum Schluss können das selbst gebaute Tixaro-Image und das Repository entfernt werden:

```bash
docker image rm tixaro-app 2>/dev/null || true
cd /opt
sudo rm -rf /opt/tixaro
```

Die gemeinsam nutzbaren Basis-Images für PostgreSQL und Nginx sowie Docker selbst bleiben absichtlich installiert, da andere Container sie verwenden können. Ob noch Tixaro-Reste vorhanden sind, lässt sich so prüfen:

```bash
docker ps -a --filter name=tixaro
docker volume ls --filter name=tixaro
docker network ls --filter name=tixaro
docker image ls --filter reference='tixaro*'
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
