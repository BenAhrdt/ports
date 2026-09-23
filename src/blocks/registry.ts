import type { BlockDefinition } from '../types';

export const blocks: BlockDefinition[] = [
  {
    type: 'interval', name: 'Intervall', description: 'Löst einen Ablauf regelmäßig aus', category: 'Logik',
    color: '#9b59b6', icon: 'clock', inputs: [], outputs: [
      { id: 'trigger', label: 'Auslösen', type: 'trigger', direction: 'output' },
    ],
    config: [
      { id: 'seconds', label: 'Sekunden', type: 'number', min: 0, max: 60, step: 1, defaultValue: 0 },
      { id: 'minutes', label: 'Minuten', type: 'number', min: 0, max: 60, step: 1, defaultValue: 1 },
      { id: 'hours', label: 'Stunden', type: 'number', min: 0, max: 60, step: 1, defaultValue: 0 },
      { id: 'days', label: 'Tage', type: 'number', min: 0, max: 60, step: 1, defaultValue: 0 },
    ],
  },
  {
    type: 'imap', name: 'IMAP', description: 'Liest neue E-Mails und filtert Anhänge', category: 'Quellen',
    color: '#6c5ce7', icon: 'mail', inputs: [
      { id: 'trigger', label: 'Prüfen', type: 'trigger', direction: 'input' },
    ], outputs: [
      { id: 'documents', label: 'Dokument-Anhänge', type: 'document', direction: 'output' },
    ],
    config: [
      { id: 'host', label: 'IMAP-Server', type: 'text', placeholder: 'imap.example.de', required: true },
      { id: 'port', label: 'Port', type: 'number', defaultValue: 993, required: true },
      { id: 'username', label: 'Benutzername', type: 'text', placeholder: 'rechnung@example.de', required: true },
      { id: 'password', label: 'Passwort', type: 'password', placeholder: 'Passwort eingeben', required: true, help: 'Wird nicht im Browser gespeichert, sondern verschlüsselt im Backend abgelegt. OAuth ist noch nicht unterstützt; manche Anbieter verlangen ein App-Passwort.' },
      { id: 'folder', label: 'Ordner', type: 'text', defaultValue: 'INBOX' },
      { id: 'patterns', label: 'Anhangsmuster', type: 'string-list', defaultValue: ['*.pdf'], placeholder: '*.pdf', help: 'Sternchen dienen als Platzhalter. Groß-/Kleinschreibung wird ignoriert. Ein verbundener Intervall-Block startet die regelmäßige Prüfung.' },
    ],
  },
  {
    type: 'network-read', name: 'Netzwerkordner lesen', description: 'Liest passende Dateien aus einer Netzwerkfreigabe', category: 'Dateien',
    color: '#2f80ed', icon: 'folder', inputs: [
      { id: 'trigger', label: 'Auslösen', type: 'trigger', direction: 'input' },
    ], outputs: [
      { id: 'files', label: 'Gefundene Dateien', type: 'file', direction: 'output' },
    ],
    config: [
      { id: 'path', label: 'Quellpfad', type: 'text', defaultValue: '\\\\OMV\\Datenaustausch\\Quelle', placeholder: '\\\\Server\\Freigabe\\Quelle', required: true, help: 'UNC-Pfad einer SMB-/Windows-Freigabe. Unter Linux kann später alternativ ein eingebundener lokaler Pfad verwendet werden.' },
      { id: 'username', label: 'Benutzername', type: 'text', placeholder: 'benutzer' },
      { id: 'password', label: 'Passwort', type: 'password', placeholder: 'Passwort eingeben', help: 'Wird nicht im Browser gespeichert, sondern verschlüsselt im Backend abgelegt.' },
      { id: 'domain', label: 'Domäne / Arbeitsgruppe', type: 'text', defaultValue: 'WORKGROUP', placeholder: 'z. B. WORKGROUP' },
      { id: 'patterns', label: 'Dateimuster', type: 'string-list', defaultValue: ['*.pdf'], placeholder: '*.pdf', help: 'Sternchen dienen als Platzhalter. Groß-/Kleinschreibung wird ignoriert.' },
      { id: 'recursive', label: 'Unterordner durchsuchen', type: 'boolean', defaultValue: false },
    ],
  },
  {
    type: 'network-write', name: 'Netzwerkordner schreiben', description: 'Speichert Dateien in einer Netzwerkfreigabe', category: 'Dateien',
    color: '#e08e2f', icon: 'folder', inputs: [
      { id: 'files', label: 'Dateien', type: 'file', direction: 'input', required: true },
    ], outputs: [],
    config: [
      { id: 'path', label: 'Zielpfad', type: 'text', defaultValue: '\\\\OMV\\Datenaustausch\\Ziel', placeholder: '\\\\Server\\Freigabe\\Ziel', required: true },
      { id: 'username', label: 'Benutzername', type: 'text', placeholder: 'benutzer' },
      { id: 'password', label: 'Passwort', type: 'password', placeholder: 'Passwort eingeben', help: 'Wird nicht im Browser gespeichert, sondern verschlüsselt im Backend abgelegt.' },
      { id: 'domain', label: 'Domäne / Arbeitsgruppe', type: 'text', defaultValue: 'WORKGROUP', placeholder: 'z. B. WORKGROUP' },
      { id: 'naming', label: 'Dateiname', type: 'select', defaultValue: 'original', options: [{ label: 'Original beibehalten', value: 'original' }, { label: 'Datum + Originalname', value: 'date-original' }] },
      { id: 'collision', label: 'Wenn Datei vorhanden', type: 'select', defaultValue: 'rename', options: [{ label: 'Eindeutig umbenennen', value: 'rename' }, { label: 'Überspringen', value: 'skip' }, { label: 'Überschreiben', value: 'overwrite' }] },
    ],
  },
];

export const blockByType = Object.fromEntries(blocks.map((block) => [block.type, block]));
