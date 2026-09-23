# Ports

Ports ist ein local-first Workflow-Editor für visuelle Automatisierungen. Blöcke kapseln technische Integrationen; typisierte Ein- und Ausgänge sorgen dafür, dass nur sinnvolle Verbindungen entstehen.

## Lokaler Start

```bash
npm install
npm run dev
```

Ports benötigt Node.js 20 oder neuer.

`npm run dev` startet Oberfläche und lokalen Backend-Dienst gemeinsam. Beim Klick auf **Testen** prüft das Backend neue Nachrichten in einem IMAP-Postfach und filtert passende Anhänge heraus. Gelesen oder ungelesen spielt dabei keine Rolle. Standardmäßig gilt `*.pdf`; weitere Muster wie `*.jpg` oder `*.docx` lassen sich ergänzen. Die Nachrichten bleiben unverändert. Ein verbundener **Intervall**-Block startet die Prüfung regelmäßig, solange der Schalter oben auf **Aktiv** steht und die Oberfläche geöffnet ist. Er hat getrennte Zahlenfelder für Sekunden, Minuten, Stunden und Tage, jeweils von 0 bis 60; mindestens ein Feld muss größer als 0 sein. Der Aktiv-Zustand bleibt bei einem Seiten-Reload erhalten. Der verbundene Netzwerkordner-Workflow wird ebenfalls tatsächlich ausgeführt. Das Backend benötigt Netzwerkzugriff auf den Mail- und SMB-Server; Passwörter werden nicht im Browser gespeichert, sondern verschlüsselt dauerhaft im Backend abgelegt.

Der erste IMAP-Lauf prüft die letzten 100 Nachrichten im Postfach. Danach werden Nachrichten mit höherer IMAP-UID verarbeitet, auch wenn sie bereits als gelesen markiert sind. Wenn eine UID-Suche leer bleibt, obwohl UIDNEXT neue Werte erwarten lässt, ruft Ports den UID-Bereich direkt ab und gleicht anschließend die vorhandenen UIDs ab. Ein leerer Abgleich erhöht den Cursor nicht; der Status zeigt Such-, Abruf- und Abgleichzahlen sowie die letzte Verarbeitung. Ist der IMAP-Ausgang mit **Netzwerkordner schreiben** verbunden, kopiert Ports passende Anhänge direkt vom Mailserver in den konfigurierten SMB-Zielordner. Erkannte Anhänge ohne Ziel bleiben bis zum nächsten Lauf im Backend vorgemerkt und werden erneut verarbeitet, sobald ein Ziel verbunden ist. Beim ersten Lauf können passende Anhänge aus den letzten 100 Nachrichten kopiert werden. Cursor und Vormerkungen liegen im Arbeitsspeicher; nach einem Backend-Neustart beginnt der Abgleich erneut mit den letzten 100. Die Prüfung öffnet das Postfach schreibgeschützt und ändert keine Mail-Flags.

Der SMB2-Adapter verwendet NTLMv2 für die Anmeldung an aktuellen Samba-/OMV-Freigaben.
Für zuverlässiges Schreiben und Überschreiben muss zusätzlich der Samba-Client installiert sein: `apt-get install smbclient`. Zugangsdaten werden ihm über eine kurzlebige Datei mit eingeschränkten Rechten übergeben; diese Datei wird nach jedem Transfer entfernt.

## Installation in einem LXC

Auf einem Debian-13-LXC kann die Anwendung direkt aus einem geklonten GitHub-Repository installiert werden. Die folgenden Befehle werden als `root` ausgeführt; `sudo` ist dafür nicht erforderlich:

```bash
git clone https://github.com/BenAhrdt/ports.git
cd ports
./install.sh
```

Das Skript erkennt eine bereits vorhandene `root`-Shell automatisch. Wenn du stattdessen als normaler Benutzer arbeitest und `sudo` installiert ist, funktioniert alternativ `sudo ./install.sh`.

Das Skript installiert Node.js, `smbclient` und die Abhängigkeiten, erzeugt den Produktions-Build und richtet `ports.service` auf Port 8787 ein. Die Anwendung ist anschließend unter `http://<IP-DES-LXC>:8787` erreichbar. Die Installationsdatei schreibt die geheime Verschlüsselungsgrundlage in `/opt/ports/.env`; diese Datei und `/opt/ports/data` dürfen nicht veröffentlicht oder in Backups ungeschützt weitergegeben werden.

Für Updates muss eine neue Version als GitHub-Release mit einem Tag wie `v0.1.1` veröffentlicht werden. Das Update kann manuell gestartet werden:

```bash
cd /opt/ports
./update.sh
```

Auch das Update-Skript muss als `root` laufen, weil es den Quellcode aktualisiert und den systemd-Dienst neu startet. Alternativ ist `sudo /opt/ports/update.sh` möglich.

Alternativ kann in **Einstellungen → Version und Aktualisierungen** nach neuen Releases gesucht und das Update gestartet werden. Während des Dienstneustarts zeigt die Oberfläche den aktuellen Update-Schritt und Fortschritt an. Der Update-Dienst prüft vorab, dass keine lokalen Änderungen im Installationsverzeichnis liegen.

Für einen Produktions-Build:

```bash
npm run test
npm run build
```

## Aktueller Prototyp (erste Ausbaustufe)

- puzzleartiger Editor mit IMAP und Netzwerkordnern
- IMAP erkennt neue Nachrichten anhand ihrer UID, filtert Anhänge nach Dateimustern und kann sie an einen Netzwerkordner weitergeben
- PDFs zwischen Netzwerkordnern werden kopiert
- kompatibilitätsgeprüfter Dokument-Steckverbinder
- Konfiguration für IMAP-Zugang, Anhangsmuster und Intervalle
- lokale Workflow-Persistenz im Browser
- Testlauf mit sichtbarem Status für IMAP und Netzwerkordner

Die Workflows **Netzwerkordner lesen → Netzwerkordner schreiben** und **IMAP → Netzwerkordner schreiben** werden vom lokalen Backend ausgeführt. Als Ziel kann der Consume-Ordner von Paperless-ngx eingetragen werden; Paperless übernimmt den Import selbst. Browser können UNC-/SMB-Pfade wie `\\OMV\Datenaustausch\Quelle` nicht direkt lesen; deshalb übernimmt der lokale Backend-Dienst den Dateizugriff. SMTP eignet sich zum Versenden von E-Mails, das Abrufen erfolgt über IMAP.

## Architekturentscheidung zum Typsystem

Datentypen bilden eine kleine gerichtete Hierarchie. Ein spezialisierter Wert darf an einen allgemeineren Eingang fließen: Ein PDF ist ein Dokument und eine Datei. Die Gegenrichtung ist nicht automatisch sicher. Echte Transformationen (`Text → PDF`) benötigen später explizite Konvertierungsblöcke. `any` ist für generische Logikblöcke vorgesehen und sollte bei Integrationen vermieden werden.

Blocktypen werden in `src/blocks/registry.ts` deklarativ registriert. Der Editor und die Validierung lesen dieselben Definitionen; neue Blöcke benötigen deshalb keine Änderung am Canvas-Kern.

## Nächste Ausbaustufe

Die Zugangsdaten für IMAP und SMB werden nicht mehr nur im Arbeitsspeicher gehalten. Benutzername und Passwort werden im Backend mit AES-256-GCM verschlüsselt in `data/credentials.enc` gespeichert; die Passwörter bleiben aus dem Browser-Workflow und aus `localStorage` heraus. Hashing wäre für diese Fremddienste nicht geeignet, weil Ports das Passwort zur Anmeldung wiederverwenden muss.

Die aktuelle UID-Erkennung gilt nur bis zum Neustart des lokalen Backends. Für größere Automatisierungen sind außerdem versionierte Workflow-Definitionen, Job-Queue und Worker sowie Ausführungsprotokolle vorgesehen.

Das versionierte Änderungsprotokoll liegt in [CHANGELOG.md](CHANGELOG.md) und kann zusätzlich im Einstellungsdialog unter **Änderungsprotokoll anzeigen** geöffnet werden.
