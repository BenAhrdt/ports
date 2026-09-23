import express from 'express';
import SMB2 from '@gv__/smb2';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const app = express();
const port = Number(process.env.PORTS_API_PORT || 8787);
const host = process.env.PORTS_API_HOST || '127.0.0.1';
const projectDir = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.PORTS_DATA_DIR || join(projectDir, 'data'));
const credentialFile = join(dataDir, 'credentials.enc');
const updateStatusFile = join(dataDir, 'update-status.json');
const imapCheckpoints = new Map();

function loadEncryptionKey() {
  if (process.env.PORTS_SECRET_KEY) {
    return createHash('sha256').update(process.env.PORTS_SECRET_KEY).digest();
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyFile = join(dataDir, '.credential-key');
  try {
    const existing = readFileSync(keyFile);
    if (existing.length === 32) return existing;
  } catch {
    // Der lokale Entwicklungsbetrieb erhält unten automatisch einen neuen Schlüssel.
  }
  const generated = randomBytes(32);
  writeFileSync(keyFile, generated, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return generated;
}

const encryptionKey = loadEncryptionKey();
const storedCredentials = new Map();

function loadCredentials() {
  if (!existsSync(credentialFile)) return;
  try {
    const payload = JSON.parse(readFileSync(credentialFile, 'utf8'));
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);
    for (const [key, value] of Object.entries(JSON.parse(plaintext.toString('utf8')))) {
      if (value && typeof value === 'object' && typeof value.password === 'string') {
        storedCredentials.set(key, value);
      }
    }
  } catch (error) {
    console.error(`Gespeicherte Zugangsdaten konnten nicht gelesen werden: ${error instanceof Error ? error.message : error}`);
  }
}

function persistCredentials() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(storedCredentials)), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
  const temporaryFile = `${credentialFile}.tmp-${process.pid}`;
  writeFileSync(temporaryFile, payload, { mode: 0o600 });
  chmodSync(temporaryFile, 0o600);
  renameSync(temporaryFile, credentialFile);
  chmodSync(credentialFile, 0o600);
}

function rememberCredential(key, value) {
  storedCredentials.set(key, value);
  persistCredentials();
}

loadCredentials();

app.use(express.json({ limit: '64kb' }));

function readVersion() {
  try {
    return readFileSync(join(projectDir, 'VERSION'), 'utf8').trim().replace(/^v/, '') || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

const version = readVersion();
const repository = String(process.env.PORTS_GITHUB_REPOSITORY || '').trim();
let releaseCache = null;

function versionParts(value) {
  const match = String(value || '').match(/^v?(\d+(?:\.\d+)*)/);
  return match ? match[1].split('.').map(Number) : [0];
}

function isNewerVersion(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

async function applicationMeta(refresh = false) {
  const result = {
    version,
    latest_version: null,
    update_available: false,
    release_url: null,
    repository: repository || null,
    changelog: readChangelog(),
    update_check_error: null,
  };
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return result;
  if (!refresh && releaseCache && Date.now() - releaseCache.checkedAt < 60 * 60 * 1000) {
    result.latest_version = releaseCache.version;
    result.release_url = releaseCache.url;
  } else {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Ports/${version}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`GitHub antwortete mit HTTP ${response.status}`);
      const payload = await response.json();
      releaseCache = {
        checkedAt: Date.now(),
        version: String(payload.tag_name || '').replace(/^v/, ''),
        url: typeof payload.html_url === 'string' ? payload.html_url : null,
      };
      result.latest_version = releaseCache.version || null;
      result.release_url = releaseCache.url;
    } catch {
      result.update_check_error = 'Die Updateprüfung ist derzeit nicht erreichbar.';
      return result;
    }
  }
  result.update_available = Boolean(result.latest_version && isNewerVersion(result.latest_version, version));
  return result;
}

function readUpdateStatus() {
  try {
    return JSON.parse(readFileSync(updateStatusFile, 'utf8'));
  } catch {
    return { state: 'idle', progress: 0, step: 'Kein Update aktiv.' };
  }
}

function readChangelog() {
  try {
    return readFileSync(join(projectDir, 'CHANGELOG.md'), 'utf8');
  } catch {
    return '# Änderungsprotokoll\n\nNoch kein Änderungsprotokoll vorhanden.';
  }
}

function parseUncPath(value) {
  const normalized = String(value || '').trim().replaceAll('/', '\\');
  const match = normalized.match(/^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/);
  if (!match) throw new Error('Bitte einen vollständigen UNC-Pfad wie \\\\Server\\Freigabe\\Ordner angeben.');
  const relativePath = (match[3] || '').replace(/^\\+|\\+$/g, '');
  if (relativePath.split('\\').some((part) => part === '..')) throw new Error('Relative Pfadsegmente (..) sind nicht erlaubt.');
  if (/[";\r\n]/.test(relativePath)) throw new Error('Der Netzwerkpfad enthält nicht unterstützte Sonderzeichen.');
  return { share: `\\\\${match[1]}\\${match[2]}`, server: match[1], shareName: match[2], relativePath };
}

function normalizedCredentialPart(value) {
  return String(value || '').trim().toLowerCase();
}

function credentialKey(config, parsedPath) {
  return `${normalizedCredentialPart(parsedPath.server)}|${normalizedCredentialPart(config.domain)}|${normalizedCredentialPart(config.username)}`;
}

function credentialResourceServer(resource) {
  const match = String(resource || '').match(/^\\\\([^\\]+)/);
  return normalizedCredentialPart(match ? match[1] : resource);
}

function storedNetworkCredential(config, parsedPath) {
  const key = credentialKey(config, parsedPath);
  let credential = storedCredentials.get(key);
  if (!credential) {
    const server = normalizedCredentialPart(parsedPath.server);
    const domain = normalizedCredentialPart(config.domain);
    const username = normalizedCredentialPart(config.username);
    for (const [storedKey, value] of storedCredentials.entries()) {
      const resource = storedKey.split('|', 1)[0];
      if (credentialResourceServer(resource) === server
        && normalizedCredentialPart(value.domain) === domain
        && normalizedCredentialPart(value.username) === username) {
        credential = value;
        break;
      }
    }
  }
  if (credential && !storedCredentials.has(key)) {
    storedCredentials.set(key, credential);
    persistCredentials();
  }
  return credential;
}

function credentialsFor(config, parsedPath) {
  const key = credentialKey(config, parsedPath);
  const username = String(config.username || '').trim();
  const domain = String(config.domain || '').trim();
  const suppliedPassword = typeof config.password === 'string' ? config.password : '';
  if (suppliedPassword) {
    rememberCredential(key, { username, domain, password: suppliedPassword });
  }
  const password = suppliedPassword || storedNetworkCredential(config, parsedPath)?.password || '';
  if (username && !password) {
    throw new Error('Passwort fehlt. Bitte im Konfigurationsfeld eingeben.');
  }
  return { username, domain, password };
}

function imapCredentialKey(config) {
  return `${normalizedCredentialPart(config.host)}|${Number(config.port || 993)}|${normalizedCredentialPart(config.username)}`;
}

function imapCredentialsFor(config) {
  const host = String(config.host || '').trim();
  const username = String(config.username || '').trim();
  const port = Number(config.port || 993);
  if (!host) throw new Error('Bitte einen IMAP-Server angeben.');
  if (!username) throw new Error('Bitte einen Benutzernamen angeben.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Der IMAP-Port muss zwischen 1 und 65535 liegen.');

  const key = imapCredentialKey({ host, port, username });
  const suppliedPassword = typeof config.password === 'string' ? config.password : '';
  if (suppliedPassword) {
    rememberCredential(key, { host, port, username, password: suppliedPassword });
  }
  const password = suppliedPassword || storedCredentials.get(key)?.password || '';
  if (!password) throw new Error('Passwort fehlt. Bitte im Konfigurationsfeld eingeben.');
  return { host, username, port, password, key };
}

function createImapClient(credentials) {
  return new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.port === 993,
    auth: { user: credentials.username, pass: credentials.password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

function createClient(config, parsedPath) {
  const credentials = credentialsFor(config, parsedPath);
  return new SMB2({
    share: parsedPath.share,
    domain: credentials.domain,
    username: credentials.username,
    password: credentials.password,
    autoCloseTimeout: 5000,
    packetConcurrency: 4,
  });
}

function joinSmb(...parts) {
  return parts.filter(Boolean).join('\\').replace(/\\+/g, '\\');
}

function matchesAnyPattern(filename, patterns) {
  return patterns.some((pattern) => {
    const expression = String(pattern).trim()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return expression && new RegExp(`^${expression}$`, 'i').test(filename);
  });
}

async function findFiles(client, folder, recursive, patterns, prefix = '') {
  const entries = await client.readdir(joinSmb(folder, prefix), { stats: true });
  const files = [];
  for (const entry of entries) {
    const relative = joinSmb(prefix, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...await findFiles(client, folder, true, patterns, relative));
    } else if (matchesAnyPattern(entry.name, patterns)) {
      files.push(relative);
    }
  }
  return files;
}

function leafName(path) {
  return path.split('\\').at(-1).replace(/[\\/:*?"<>|]/g, '_');
}

async function availableTarget(client, folder, originalName, collision) {
  const first = joinSmb(folder, originalName);
  if (!await client.exists(first)) return { path: first, existed: false };
  if (collision === 'skip') return null;
  if (collision === 'overwrite') return { path: first, existed: true };
  const dot = originalName.lastIndexOf('.');
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const extension = dot > 0 ? originalName.slice(dot) : '';
  for (let index = 2; index < 10000; index += 1) {
    const candidate = joinSmb(folder, `${stem} (${index})${extension}`);
    if (!await client.exists(candidate)) return { path: candidate, existed: false };
  }
  throw new Error(`Kein freier Dateiname für ${originalName} gefunden.`);
}

async function putWithSmbClient(config, parsedPath, remotePath, data) {
  const credentials = credentialsFor(config, parsedPath);
  const workdir = await mkdtemp(join(tmpdir(), 'ports-smb-'));
  const authPath = join(workdir, 'credentials');
  const localPath = join(workdir, 'upload.bin');
  try {
    await writeFile(authPath, `username = ${credentials.username}\npassword = ${credentials.password}\ndomain = ${credentials.domain}\n`, { mode: 0o600 });
    await writeFile(localPath, data, { mode: 0o600 });
    const command = `put "${localPath}" "${remotePath}"`;
    await new Promise((resolve, reject) => {
      const child = spawn('smbclient', [
        `//${parsedPath.server}/${parsedPath.shareName}`,
        '-A', authPath,
        '-c', command,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(output.trim() || `smbclient wurde mit Code ${code} beendet.`));
      });
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

app.get('/api/health', (_request, response) => response.json({ ok: true }));

app.get('/api/meta', async (request, response) => {
  response.json(await applicationMeta(request.query.refresh === 'true'));
});

app.get('/api/system/update/status', (_request, response) => {
  response.json(readUpdateStatus());
});

app.post('/api/system/update', (request, response) => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const marker = join(dataDir, '.update-requested');
  try {
    writeFileSync(marker, `requested_at=${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o640 });
    return response.status(202).json({ started: true, from_version: version });
  } catch (error) {
    if (error?.code === 'EEXIST') return response.status(409).json({ ok: false, error: 'Ein Update wurde bereits angefordert.' });
    return response.status(500).json({ ok: false, error: 'Das Update konnte nicht angefordert werden.' });
  }
});

app.post('/api/credentials/save', (request, response) => {
  try {
    const config = request.body?.config ?? {};
    const parsedPath = parseUncPath(config.path);
    credentialsFor(config, parsedPath);
    return response.json({ ok: true, available: storedCredentials.has(credentialKey(config, parsedPath)) });
  } catch (error) {
    return response.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Zugangsdaten konnten nicht gespeichert werden.' });
  }
});

app.post('/api/imap/credentials/save', (request, response) => {
  try {
    const credentials = imapCredentialsFor(request.body?.config ?? {});
    return response.json({ ok: true, available: storedCredentials.has(credentials.key) });
  } catch (error) {
    return response.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Zugangsdaten konnten nicht gespeichert werden.' });
  }
});

app.post('/api/credentials/status', (request, response) => {
  try {
    const config = request.body?.config ?? {};
    const parsedPath = parseUncPath(config.path);
    const available = Boolean(storedNetworkCredential(config, parsedPath));
    return response.json({ ok: true, available });
  } catch {
    return response.json({ ok: true, available: false });
  }
});

app.post('/api/imap/credentials/status', (request, response) => {
  const config = request.body?.config ?? {};
  return response.json({ ok: true, available: storedCredentials.has(imapCredentialKey(config)) });
});

app.post('/api/run/imap-fetch', async (request, response) => {
  const config = request.body?.config ?? {};
  const target = request.body?.target;
  const folder = String(config.folder || 'INBOX').trim();
  const patterns = Array.isArray(config.patterns)
    ? config.patterns.map(String).map((pattern) => pattern.trim()).filter(Boolean)
    : ['*.pdf'];
  if (patterns.length === 0) return response.status(400).json({ ok: false, error: 'Bitte mindestens ein Dateimuster angeben.', stage: 'Konfiguration prüfen' });

  let client;
  let targetClient;
  let targetPath;
  let mailboxLock;
  let stage = 'IMAP-Konfiguration prüfen';
  try {
    const credentials = imapCredentialsFor(config);
    client = createImapClient(credentials);
    stage = 'Mit dem E-Mail-Server verbinden';
    await client.connect();
    stage = `Postfach ${folder} lesen`;
    mailboxLock = await client.getMailboxLock(folder, { readOnly: true });
    if (target) {
      stage = 'Zielpfad prüfen';
      targetPath = parseUncPath(target.path);
      targetClient = createClient(target, targetPath);
    }

    const checkpointKey = `${credentials.key}|${folder.toLowerCase()}`;
    const uidValidity = String(client.mailbox.uidValidity);
    let checkpoint = imapCheckpoints.get(checkpointKey);
    if (!checkpoint || checkpoint.uidValidity !== uidValidity) {
      checkpoint = { uidValidity, highestUid: null, pendingUids: [] };
      imapCheckpoints.set(checkpointKey, checkpoint);
    }
    checkpoint.pendingUids ??= [];

    let candidateUids;
    let uidFallbackUsed = false;
    let uidSearchRange = null;
    let uidSearchCount = 0;
    let uidFetchCount = 0;
    let uidReconcileCount = 0;
    const prefetchedMessages = new Map();
    const initialScan = checkpoint.highestUid === null;
    if (initialScan) {
      stage = 'Letzte Nachrichten für den ersten Abgleich laden';
      const allUids = await client.search({ all: true }, { uid: true });
      const existingUids = Array.isArray(allUids) ? allUids : [];
      candidateUids = existingUids.slice(-100);
      checkpoint.highestUid = candidateUids.length
        ? candidateUids[0] - 1
        : Number(client.mailbox.uidNext || 1) - 1;
    } else {
      stage = 'Neue E-Mails anhand ihrer UID suchen';
      const firstNewUid = checkpoint.highestUid + 1;
      const lastCurrentUid = Number(client.mailbox.uidNext || firstNewUid) - 1;
      if (firstNewUid <= lastCurrentUid) {
        const lastUidToScan = Math.min(lastCurrentUid, firstNewUid + 99);
        uidSearchRange = { from: firstNewUid, to: lastUidToScan };
        const newUids = await client.search({ uid: `${firstNewUid}:${lastUidToScan}` }, { uid: true });
        candidateUids = Array.isArray(newUids) ? newUids : [];
        uidSearchCount = candidateUids.length;
        if (candidateUids.length === 0) {
          uidFallbackUsed = true;
          stage = 'Neue UID-Nachrichten direkt abrufen';
          const rangeMessages = await client.fetchAll(
            `${firstNewUid}:${lastUidToScan}`,
            { source: true, envelope: true, internalDate: true },
            { uid: true },
          );
          if (Array.isArray(rangeMessages)) {
            for (const message of rangeMessages) {
              if (message.uid) prefetchedMessages.set(message.uid, message);
            }
          }
          uidFetchCount = prefetchedMessages.size;
          candidateUids = [...prefetchedMessages.keys()].sort((left, right) => left - right);
          if (candidateUids.length === 0) {
            stage = 'Mailbox-UIDs vollständig abgleichen';
            const allUids = await client.search({ all: true }, { uid: true });
            const existingUids = Array.isArray(allUids) ? allUids : [];
            const reconciledUids = existingUids.filter((uid) => uid > checkpoint.highestUid && uid <= lastUidToScan);
            uidReconcileCount = reconciledUids.length;
            candidateUids = reconciledUids;
          }
        }
      } else {
        candidateUids = [];
      }
    }
    const newUidsToProcess = candidateUids.slice(0, 100);
    const newUidSet = new Set(newUidsToProcess);
    const pendingRetryUids = targetClient ? checkpoint.pendingUids.slice(0, 100) : [];
    const pendingRetrySet = new Set(pendingRetryUids);
    const uidsToProcess = [...new Set([...pendingRetryUids, ...newUidsToProcess])];
    const matchedAttachments = [];
    const copiedAttachments = [];
    const skippedAttachments = [];
    let checkedMessages = 0;
    let retriedMessages = 0;

    for (const uid of uidsToProcess) {
      stage = `E-Mail ${uid} verarbeiten`;
      const message = prefetchedMessages.get(uid)
        ?? await client.fetchOne(uid, { source: true, envelope: true, internalDate: true }, { uid: true });
      if (!message?.source) throw new Error(`Die E-Mail ${uid} konnte nicht geladen werden.`);
      const parsed = await simpleParser(message.source);
      const attachments = parsed.attachments.filter((attachment) =>
        attachment.contentDisposition === 'attachment' || (attachment.filename && !attachment.related));
      let hasMatchingAttachment = false;
      for (const attachment of attachments) {
        const filename = attachment.filename || '';
        if (!filename || !matchesAnyPattern(filename, patterns)) continue;
        hasMatchingAttachment = true;
        matchedAttachments.push({
          uid,
          filename,
          size: attachment.size,
          contentType: attachment.contentType,
          subject: parsed.subject || message.envelope?.subject || '(ohne Betreff)',
          from: parsed.from?.text || '',
          receivedAt: (parsed.date || message.internalDate || message.envelope?.date || null)?.toISOString?.() ?? null,
        });
        if (targetClient && targetPath) {
          if (!checkpoint.pendingUids.includes(uid)) checkpoint.pendingUids.push(uid);
          const originalName = leafName(filename);
          const targetName = target.naming === 'date-original'
            ? `${new Date().toISOString().slice(0, 10)}-${originalName}`
            : originalName;
          stage = `Ziel prüfen: ${targetName}`;
          const targetFile = await availableTarget(targetClient, targetPath.relativePath, targetName, target.collision || 'rename');
          if (!targetFile) {
            skippedAttachments.push({ filename, target: targetName });
            continue;
          }
          stage = `Anhang speichern: ${targetName}`;
          await putWithSmbClient(target, targetPath, targetFile.path, attachment.content);
          copiedAttachments.push({ filename, target: targetFile.path, bytes: attachment.size });
        }
      }
      if (targetClient) {
        checkpoint.pendingUids = checkpoint.pendingUids.filter((pendingUid) => pendingUid !== uid);
      } else if (hasMatchingAttachment && !checkpoint.pendingUids.includes(uid)) {
        checkpoint.pendingUids.push(uid);
      }
      if (newUidSet.has(uid)) {
        checkpoint.highestUid = Math.max(checkpoint.highestUid ?? 0, uid);
        checkedMessages += 1;
      } else if (pendingRetrySet.has(uid)) {
        retriedMessages += 1;
      }
    }

    if (checkedMessages > 0 || retriedMessages > 0) {
      checkpoint.lastBatch = {
        checkedMessages,
        retriedMessages,
        matchedAttachmentCount: matchedAttachments.length,
        filenames: matchedAttachments.slice(0, 4).map((attachment) => attachment.filename),
        copiedCount: copiedAttachments.length,
        copiedFiles: copiedAttachments.slice(0, 4).map((attachment) => attachment.filename),
        skippedCount: skippedAttachments.length,
        checkedAt: new Date().toISOString(),
      };
    }
    if (copiedAttachments.length > 0) {
      checkpoint.lastCopy = {
        count: copiedAttachments.length,
        filenames: copiedAttachments.slice(0, 4).map((attachment) => attachment.filename),
        targets: copiedAttachments.slice(0, 4).map((attachment) => attachment.target),
        copiedAt: new Date().toISOString(),
      };
    }

    return response.json({
      ok: true,
      mailboxPath: client.mailbox.path,
      mailboxTotal: client.mailbox.exists,
      checkpointUid: checkpoint.highestUid,
      nextUid: client.mailbox.uidNext,
      uidValidity,
      initialScan,
      checkedMessages,
      retriedMessages,
      newUidsFound: candidateUids.length,
      pendingAttachments: checkpoint.pendingUids.length,
      uidFallbackUsed,
      uidSearchRange,
      uidSearchCount,
      uidFetchCount,
      uidReconcileCount,
      pendingLeft: Math.max(0, candidateUids.length - newUidsToProcess.length),
      matchedAttachments,
      targetPath: targetPath?.relativePath,
      copiedAttachments,
      skippedAttachments,
      lastBatch: checkpoint.lastBatch ?? null,
      lastCopy: checkpoint.lastCopy ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter IMAP-Fehler';
    return response.status(500).json({ ok: false, error: message, stage });
  } finally {
    try { mailboxLock?.release(); } catch { /* Die Mailbox-Sperre wurde bereits geschlossen. */ }
    try { targetClient?.disconnect(); } catch { /* Verbindung wurde nicht geöffnet. */ }
    if (client?.usable) {
      try { await client.logout(); } catch { client.close(); }
    } else {
      try { client?.close(); } catch { /* Verbindung wurde nicht geöffnet. */ }
    }
  }
});

app.post('/api/run/network-copy', async (request, response) => {
  const source = request.body?.source;
  const target = request.body?.target;
  if (!source || !target) return response.status(400).json({ ok: false, error: 'Quelle oder Ziel fehlt.' });

  let sourceClient;
  let targetClient;
  let stage = 'Konfiguration prüfen';
  try {
    const sourcePath = parseUncPath(source.path);
    const targetPath = parseUncPath(target.path);
    sourceClient = createClient(source, sourcePath);
    targetClient = createClient(target, targetPath);
    const patterns = Array.isArray(source.patterns)
      ? source.patterns.map(String).map((pattern) => pattern.trim()).filter(Boolean)
      : ['*.pdf'];
    if (patterns.length === 0) throw new Error('Bitte mindestens ein Dateimuster angeben.');
    stage = 'Quelle lesen';
    const files = await findFiles(sourceClient, sourcePath.relativePath, Boolean(source.recursive), patterns);
    const copied = [];
    const skipped = [];

    for (const relativeFile of files) {
      stage = `Quelldatei lesen: ${relativeFile}`;
      const data = await sourceClient.readFile(joinSmb(sourcePath.relativePath, relativeFile));
      const originalName = leafName(relativeFile);
      const targetName = target.naming === 'date-original'
        ? `${new Date().toISOString().slice(0, 10)}-${originalName}`
        : originalName;
      stage = `Ziel prüfen: ${targetName}`;
      const targetFile = await availableTarget(targetClient, targetPath.relativePath, targetName, target.collision || 'rename');
      if (!targetFile) {
        skipped.push(originalName);
        continue;
      }
      stage = `Zieldatei schreiben: ${targetName}`;
      await putWithSmbClient(target, targetPath, targetFile.path, data);
      copied.push({ source: relativeFile, target: targetFile.path, bytes: data.length });
    }

    return response.json({ ok: true, found: files.length, copied, skipped });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unbekannter SMB-Fehler';
    return response.status(500).json({ ok: false, error: message, stage });
  } finally {
    try { sourceClient?.disconnect(); } catch { /* Verbindung wurde nicht geöffnet. */ }
    try { targetClient?.disconnect(); } catch { /* Verbindung wurde nicht geöffnet. */ }
  }
});

const frontendDist = join(projectDir, 'dist');
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { index: 'index.html', setHeaders: (response) => {
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } }));
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    return response.sendFile(join(frontendDist, 'index.html'));
  });
}

app.listen(port, host, () => {
  console.log(`Ports läuft auf http://${host}:${port} (Version ${version})`);
});
