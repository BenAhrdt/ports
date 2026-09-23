# Änderungsprotokoll

Alle wichtigen Änderungen an Ports werden hier versioniert. Die Versionsnummern entsprechen den Git-Tags im Format `vX.Y.Z`.

## Unveröffentlicht

### Behoben

- Intervall-Blöcke zeigen geplante Läufe jetzt als laufend, erfolgreich oder fehlgeschlagen an.
- Gespeicherte Zugangsdaten verwenden normalisierte, serverbezogene Schlüssel, damit Pfadänderungen, Leerzeichen oder unterschiedliche Schreibweisen nach einem Reload nicht zu einem falschen fehlenden Passwort führen.

## [0.1.1] - 2026-09-23

### Hinzugefügt

- GitHub-Actions-Workflows für CI-Tests bei Pushes/Pull Requests und tagbasierte Releases.
- `release.sh` für automatisierte Patch-, Minor- und Major-Releases.

## [0.1.0] - 2026-09-23

### Hinzugefügt

- Erster lauffähiger Workflow-Editor für IMAP- und SMB-/Netzwerkordner-Abläufe.
- Debian-/Ubuntu-LXC-Installation mit `install.sh` und systemd-Dienst.
- Manuelle und über die Oberfläche startbare Updates mit Fortschrittsanzeige.
- Anzeige der installierten Version und Prüfung veröffentlichter GitHub-Releases.
- Dauerhafte AES-256-GCM-Verschlüsselung für IMAP-/SMB-Zugangsdaten.
- Änderungsprotokoll in der Weboberfläche unter **Einstellungen**.
