import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge, Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow,
  ReactFlowProvider, useEdgesState, useNodesState, type Connection, type Edge, type Node,
} from '@xyflow/react';
import { blocks, blockByType } from './blocks/registry';
import { BlockNode } from './components/BlockNode';
import { isTypeCompatible, typeLabels } from './core/typeSystem';
import type { BlockNodeData, ConfigValue, DataType } from './types';
import { AlertTriangle, Box, CheckCircle2, ChevronDown, CircleHelp, Play, Plus, RefreshCw, Search, Settings2, Sparkles, X, Zap } from 'lucide-react';

const initialNodes: Node<BlockNodeData>[] = [
  { id: 'imap-1', type: 'block', position: { x: 110, y: 190 }, data: { blockType: 'imap', label: 'E-Mails abrufen', status: 'idle', config: { port: 993, folder: 'INBOX', patterns: ['*.pdf'] } } },
  { id: 'interval-1', type: 'block', position: { x: 40, y: 430 }, data: { blockType: 'interval', label: 'Intervall', status: 'idle', config: { seconds: 0, minutes: 1, hours: 0, days: 0 } } },
  { id: 'network-read-1', type: 'block', position: { x: 420, y: 430 }, data: { blockType: 'network-read', label: 'Dateien aus Quelle lesen', status: 'idle', config: { path: '\\\\OMV\\Datenaustausch\\Quelle', domain: 'WORKGROUP', patterns: ['*.pdf'], recursive: false } } },
  { id: 'network-write-1', type: 'block', position: { x: 850, y: 430 }, data: { blockType: 'network-write', label: 'Dateien im Ziel speichern', status: 'idle', config: { path: '\\\\OMV\\Datenaustausch\\Ziel', domain: 'WORKGROUP', naming: 'original', collision: 'rename' } } },
];
const initialEdges: Edge[] = [
  { id: 'e1', source: 'imap-1', sourceHandle: 'documents', target: 'network-write-1', targetHandle: 'files', animated: true },
  { id: 'e2', source: 'network-read-1', sourceHandle: 'files', target: 'network-write-1', targetHandle: 'files', animated: true },
  { id: 'e3', source: 'interval-1', sourceHandle: 'trigger', target: 'network-read-1', targetHandle: 'trigger', animated: true },
  { id: 'e4', source: 'interval-1', sourceHandle: 'trigger', target: 'imap-1', targetHandle: 'trigger', animated: true },
];
const STORAGE_KEY = 'ports.workflow.triggers-patterns.v3';
const ACTIVE_STORAGE_KEY = 'ports.workflow.active';
const intervalUnits = [
  { id: 'seconds', milliseconds: 1000 },
  { id: 'minutes', milliseconds: 60_000 },
  { id: 'hours', milliseconds: 3_600_000 },
  { id: 'days', milliseconds: 86_400_000 },
] as const;

type ApplicationMeta = {
  version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string | null;
  repository: string | null;
  changelog: string;
  update_check_error: string | null;
};

type UpdateStatus = {
  state: 'idle' | 'running' | 'current' | 'complete' | 'failed';
  progress: number;
  step: string;
  updated_at?: string;
};

function normalizeIntervalConfig(
  config: Record<string, ConfigValue>,
  storedConfig: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const hasStored = (key: string) => Object.prototype.hasOwnProperty.call(storedConfig, key);
  const { value: _oldValue, unit: _oldUnit, seconds: _oldSeconds, ...other } = config;
  const values = Object.fromEntries(intervalUnits.map(({ id }) => [id, 0])) as Record<string, number>;
  const clamp = (value: ConfigValue | undefined, fallback = 0) => {
    const numeric = Number(value);
    return Math.max(0, Math.min(60, Number.isFinite(numeric) ? Math.floor(numeric) : fallback));
  };

  if (hasStored('value') && hasStored('unit')) {
    const unit = intervalUnits.find((option) => option.id === String(storedConfig.unit));
    if (unit) values[unit.id] = clamp(storedConfig.value, 1);
    else values.minutes = 1;
  } else if (['minutes', 'hours', 'days'].some(hasStored)) {
    for (const { id } of intervalUnits) values[id] = clamp(storedConfig[id]);
  } else if (hasStored('seconds')) {
    // Ältere Workflows speicherten die gesamte Dauer als Sekundenwert.
    const oldSeconds = Number(storedConfig.seconds);
    if (Number.isInteger(oldSeconds) && oldSeconds >= 0) {
      let remaining = oldSeconds;
      for (const { id, milliseconds } of [...intervalUnits].reverse()) {
        values[id] = Math.min(60, Math.floor(remaining / (milliseconds / 1000)));
        remaining -= values[id] * (milliseconds / 1000);
      }
    } else values.minutes = 1;
  } else {
    for (const { id } of intervalUnits) values[id] = clamp(config[id]);
  }

  return { ...other, ...values };
}

function withoutSecrets(node: Node<BlockNodeData>): Node<BlockNodeData> {
  const secretIds = new Set(blockByType[node.data.blockType].config
    .filter((field) => field.type === 'password')
    .map((field) => field.id));
  const config = Object.fromEntries(Object.entries(node.data.config ?? {})
    .filter(([key]) => !secretIds.has(key)));
  const { statusMessage: _statusMessage, statusDetails: _statusDetails, ...data } = node.data;
  return { ...node, data: { ...data, status: 'idle', config } };
}

function Editor() {
  const saved = useMemo(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!stored?.nodes || !stored?.edges) return null;
      const storedNodes = (stored.nodes as Node<BlockNodeData>[])
        .filter((node) => Boolean(blockByType[node.data.blockType]));
      const hydratedNodes = storedNodes.map(withoutSecrets).map((node): Node<BlockNodeData> => {
        const definition = blockByType[node.data.blockType];
        const defaults = Object.fromEntries(definition.config
          .filter((field) => field.defaultValue !== undefined)
          .map((field) => [field.id, field.defaultValue as ConfigValue])) as Record<string, ConfigValue>;
        const config = { ...defaults, ...node.data.config };
        return { ...node, data: {
          ...node.data,
          status: 'idle',
          config: node.data.blockType === 'interval'
            ? normalizeIntervalConfig(config, node.data.config ?? {})
            : config,
        } };
      });
      const definitions = new Map(hydratedNodes.map((node) => [node.id, blockByType[node.data.blockType]]));
      const validEdges = (stored.edges as Edge[]).filter((edge) => {
        const source = definitions.get(edge.source);
        const target = definitions.get(edge.target);
        return source?.outputs.some((port) => port.id === edge.sourceHandle)
          && target?.inputs.some((port) => port.id === edge.targetHandle);
      });
      return { nodes: hydratedNodes, edges: validEdges };
    } catch { return null; }
  }, []);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<BlockNodeData>>(saved?.nodes ?? initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved?.edges ?? initialEdges);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('Bereit');
  const [active, setActive] = useState(() => localStorage.getItem(ACTIVE_STORAGE_KEY) === 'true');
  const [running, setRunning] = useState(false);
  const [secretAvailable, setSecretAvailable] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [meta, setMeta] = useState<ApplicationMeta | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle', progress: 0, step: 'Kein Update aktiv.' });
  const updateTimerRef = useRef<number | null>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const runWorkflowRef = useRef<(scheduled?: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: nodes.map(withoutSecrets), edges }));
  }, [nodes, edges]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_STORAGE_KEY, String(active));
  }, [active]);

  const loadMeta = useCallback(async (refresh = false) => {
    const response = await fetch(`/api/meta${refresh ? '?refresh=true' : ''}`);
    if (!response.ok) throw new Error('Versionsinformationen konnten nicht geladen werden.');
    const result = await response.json() as ApplicationMeta;
    setMeta(result);
    return result;
  }, []);

  useEffect(() => {
    void loadMeta().catch(() => setUpdateMessage('Versionsinformationen sind derzeit nicht verfügbar.'));
    return () => {
      if (updateTimerRef.current !== null) window.clearTimeout(updateTimerRef.current);
    };
  }, [loadMeta]);

  const checkForUpdates = async () => {
    setCheckingUpdates(true);
    setUpdateMessage('');
    try {
      const result = await loadMeta(true);
      setUpdateMessage(result.update_available
        ? `Update auf Version ${result.latest_version} ist verfügbar.`
        : `Ports ${result.version} ist aktuell.`);
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : 'Updateprüfung fehlgeschlagen.');
    } finally {
      setCheckingUpdates(false);
    }
  };

  const startUpdate = async () => {
    if (!meta?.update_available || updateInstalling) return;
    const previousVersion = meta.version;
    setUpdateInstalling(true);
    setUpdateStatus({ state: 'running', progress: 5, step: 'Update wird angefordert …' });
    setUpdateMessage('');
    try {
      const response = await fetch('/api/system/update', { method: 'POST' });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || 'Das Update konnte nicht gestartet werden.');

      const deadline = Date.now() + 15 * 60_000;
      const poll = async () => {
        try {
          const statusResponse = await fetch('/api/system/update/status', { cache: 'no-store' });
          if (statusResponse.ok) setUpdateStatus(await statusResponse.json() as UpdateStatus);
          const metaResponse = await fetch('/api/meta', { cache: 'no-store' });
          if (metaResponse.ok) {
            const current = await metaResponse.json() as ApplicationMeta;
            setMeta(current);
            if (current.version !== previousVersion) {
              window.location.reload();
              return;
            }
          }
        } catch {
          // Während des Dienstneustarts ist die Oberfläche kurz nicht erreichbar.
        }
        if (Date.now() >= deadline) {
          setUpdateInstalling(false);
          setUpdateStatus({ state: 'failed', progress: 0, step: 'Das Update dauert länger als erwartet.' });
          setUpdateMessage('Bitte prüfe auf dem Server den Status mit „systemctl status ports-update.service“.');
          return;
        }
        updateTimerRef.current = window.setTimeout(() => { void poll(); }, 2000);
      };
      void poll();
    } catch (error) {
      setUpdateInstalling(false);
      setUpdateStatus({ state: 'failed', progress: 0, step: 'Update konnte nicht gestartet werden.' });
      setUpdateMessage(error instanceof Error ? error.message : 'Update konnte nicht gestartet werden.');
    }
  };

  const portType = useCallback((nodeId: string, handleId: string | null, direction: 'input' | 'output'): DataType | undefined => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const block = blockByType[node.data.blockType];
    return (direction === 'input' ? block.inputs : block.outputs).find((port) => port.id === handleId)?.type;
  }, [nodes]);

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    if (!connection.source || !connection.target) return false;
    const output = portType(connection.source, connection.sourceHandle ?? null, 'output');
    const input = portType(connection.target, connection.targetHandle ?? null, 'input');
    return Boolean(output && input && isTypeCompatible(output, input));
  }, [portType]);

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) {
      setNotice('Diese Port-Typen sind nicht kompatibel');
      return;
    }
    setEdges((current) => addEdge({ ...connection, markerEnd: { type: MarkerType.ArrowClosed }, animated: active }, current));
    setNotice('Verbindung erstellt');
  }, [active, isValidConnection, setEdges]);

  const addBlock = useCallback((blockType: string) => {
    const block = blockByType[blockType];
    const count = nodes.filter((node) => node.data.blockType === blockType).length;
    const config = Object.fromEntries(
      block.config
        .filter((field) => field.defaultValue !== undefined)
        .map((field) => [field.id, field.defaultValue as ConfigValue]),
    ) as Record<string, ConfigValue>;
    setNodes((current) => [...current, {
      id: `${blockType}-${Date.now()}`, type: 'block', position: { x: 340 + count * 24, y: 160 + count * 30 },
      data: { blockType, label: block.name, status: 'idle', config },
    }]);
    setNotice(`${block.name} hinzugefügt`);
  }, [nodes, setNodes]);

  const runWorkflow = async (scheduled = false) => {
    if (running) return;
    const intervalNode = nodes.find((node) => node.data.blockType === 'interval');
    const scheduledSourceIds = new Set(scheduled && intervalNode
      ? edges.filter((edge) => edge.source === intervalNode.id).map((edge) => edge.target)
      : []);
    const imapNodes = nodes.filter((node) => node.data.blockType === 'imap'
      && (!scheduled || scheduledSourceIds.has(node.id))
      && Boolean(node.data.config?.host) && Boolean(node.data.config?.username));
    const sourceNode = nodes.find((node) => node.data.blockType === 'network-read');
    const targetNode = nodes.find((node) => node.data.blockType === 'network-write');
    const networkConnected = sourceNode && targetNode
      && (!scheduled || scheduledSourceIds.has(sourceNode.id))
      && edges.some((edge) => edge.source === sourceNode.id && edge.target === targetNode.id);
    const imapTargetNodeIds = new Set(imapNodes
      .filter((imapNode) => targetNode && edges.some((edge) => edge.source === imapNode.id && edge.target === targetNode.id))
      .map(() => targetNode!.id));
    const hasNetworkWrites = Boolean(networkConnected) || imapTargetNodeIds.size > 0;
    if (!imapNodes.length && !networkConnected) {
      setNotice(nodes.some((node) => node.data.blockType === 'imap')
        ? 'Bitte IMAP-Server und Benutzernamen konfigurieren'
        : 'Netzwerk-Quelle und -Ziel müssen miteinander verbunden sein');
      return;
    }

    setRunning(true);
    setNotice(imapNodes.length && hasNetworkWrites ? 'Postfach und Netzwerkordner werden verarbeitet …' : imapNodes.length ? 'Postfach wird geprüft …' : 'Netzwerkordner werden verarbeitet …');
    const runningNodeIds = new Set([
      ...imapNodes.map((node) => node.id),
      ...imapTargetNodeIds,
      ...(networkConnected ? [sourceNode!.id, targetNode!.id] : []),
    ]);
    setNodes((current) => current.map((node) => runningNodeIds.has(node.id)
      ? { ...node, data: { ...node.data, status: 'running', statusMessage: 'Verarbeitung läuft', statusDetails: 'Die Quelle wird vorbereitet.' } }
      : node));
    const summaries: string[] = [];
    try {
      for (const imapNode of imapNodes) {
        try {
          const imapTargetConnected = Boolean(targetNode && edges.some((edge) => edge.source === imapNode.id && edge.target === targetNode.id));
          const response = await fetch('/api/run/imap-fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              config: imapNode.data.config ?? {},
              ...(imapTargetConnected ? { target: targetNode!.data.config ?? {} } : {}),
            }),
          });
          const responseText = await response.text();
          let result: { ok: boolean; mailboxPath?: string; mailboxTotal?: number; checkpointUid?: number; nextUid?: number; initialScan?: boolean; checkedMessages?: number; retriedMessages?: number; newUidsFound?: number; uidFallbackUsed?: boolean; uidSearchRange?: { from: number; to: number } | null; uidSearchCount?: number; uidFetchCount?: number; uidReconcileCount?: number; pendingLeft?: number; pendingAttachments?: number; matchedAttachments?: { filename: string }[]; targetPath?: string; copiedAttachments?: { filename: string; target: string; bytes: number }[]; skippedAttachments?: { filename: string; target: string }[]; lastBatch?: { checkedMessages: number; retriedMessages?: number; matchedAttachmentCount: number; filenames: string[]; copiedCount?: number; copiedFiles?: string[]; skippedCount?: number; checkedAt: string } | null; lastCopy?: { count: number; filenames: string[]; targets: string[]; copiedAt: string } | null; error?: string; stage?: string };
          try {
            result = responseText ? JSON.parse(responseText) : { ok: false, error: 'Das lokale Backend hat nicht geantwortet. Bitte npm run dev neu starten.' };
          } catch {
            result = { ok: false, error: `Ungültige Backend-Antwort (${response.status}). Bitte npm run dev neu starten.` };
          }
          if (!response.ok || !result.ok) {
            const detail = result.error || `Backend-Fehler ${response.status}`;
            const message = result.stage ? `${result.stage}: ${detail}` : detail;
            setNodes((current) => current.map((node) => {
              if (node.id === imapNode.id) return { ...node, data: { ...node.data, status: 'error', statusMessage: 'Postfachprüfung fehlgeschlagen', statusDetails: message } };
              if (imapTargetConnected && node.id === targetNode!.id) return result.stage?.startsWith('Ziel') || result.stage?.startsWith('Anhang speichern')
                ? { ...node, data: { ...node.data, status: 'error', statusMessage: 'Anhang konnte nicht gespeichert werden', statusDetails: message } }
                : { ...node, data: { ...node.data, status: 'idle', statusMessage: 'Ziel nicht erreicht', statusDetails: 'Die Postfachprüfung ist fehlgeschlagen, bevor Anhänge gespeichert werden konnten.' } };
              return node;
            }));
            summaries.push(`IMAP-Fehler: ${message}`);
            continue;
          }
          const matches = result.matchedAttachments ?? [];
          const copied = result.copiedAttachments ?? [];
          const skipped = result.skippedAttachments ?? [];
          const filenames = matches.slice(0, 4).map((item) => item.filename).join(', ');
          const checked = result.initialScan
            ? `${result.checkedMessages ?? 0} im Erstabgleich geprüft`
            : `${result.checkedMessages ?? 0} neu seit letzter Prüfung`;
          const lastBatch = !result.checkedMessages && !result.retriedMessages && result.lastBatch
            ? ` · zuletzt verarbeitet: ${result.lastBatch.checkedMessages} E-Mail(s), ${result.lastBatch.matchedAttachmentCount} Anhänge${result.lastBatch.filenames.length ? ` (${result.lastBatch.filenames.join(', ')})` : ''}${result.lastBatch.copiedCount ? `, ${result.lastBatch.copiedCount} gespeichert` : ''} um ${new Date(result.lastBatch.checkedAt).toLocaleTimeString()}`
            : '';
          const lastBatchNotCopied = Boolean(result.lastBatch
            && result.lastBatch.matchedAttachmentCount > 0
            && !result.lastBatch.copiedCount
            && !result.lastBatch.skippedCount
            && !result.lastCopy);
          const uidSearch = !result.initialScan
            ? result.uidSearchRange
              ? ` · UID ${result.uidSearchRange.from}–${result.uidSearchRange.to}: Suche ${result.uidSearchCount ?? 0}${result.uidFallbackUsed ? `, Direktabruf ${result.uidFetchCount ?? 0}, Abgleich ${result.uidReconcileCount ?? 0}` : ''} (Cursor ${result.checkpointUid ?? '?'}, nächste UID ${result.nextUid ?? '?'})`
              : ` · Keine neue UID im Bereich (Cursor ${result.checkpointUid ?? '?'}, nächste UID ${result.nextUid ?? '?'})`
            : '';
          const transferSummary = imapTargetConnected
            ? copied.length
              ? ` · ${copied.length} gespeichert${skipped.length ? `, ${skipped.length} übersprungen` : ''}`
              : result.lastCopy
                ? ` · zuletzt ${result.lastCopy.count} gespeichert (${result.lastCopy.filenames.join(', ')}) um ${new Date(result.lastCopy.copiedAt).toLocaleTimeString()}`
                : lastBatchNotCopied
                  ? ' · letzter erkannter Anhang wurde noch nicht gespeichert'
                : ` · 0 gespeichert${skipped.length ? `, ${skipped.length} übersprungen` : ''}`
            : '';
          const details = `${result.mailboxPath ?? 'Postfach'}: ${result.mailboxTotal ?? 0} Nachrichten · ${checked} · ${matches.length} passende Anhänge in diesem Lauf${filenames ? `: ${filenames}` : ''}${transferSummary}${result.pendingLeft ? ` · ${result.pendingLeft} weitere beim nächsten Lauf` : ''}${uidSearch}${lastBatch}`;
          const retrySummary = result.retriedMessages ? ` · ${result.retriedMessages} vorgemerkte Mail(s) erneut geprüft` : '';
          const pendingSummary = result.pendingAttachments ? ` · ${result.pendingAttachments} Mail(s) mit passenden Anhängen warten auf ein Ziel` : '';
          const displayedDetails = `${details}${retrySummary}${pendingSummary}`;
          setNodes((current) => current.map((node) => {
            if (node.id === imapNode.id) return { ...node, data: { ...node.data, status: 'success', statusMessage: 'Postfach erfolgreich geprüft', statusDetails: displayedDetails } };
            if (imapTargetConnected && node.id === targetNode!.id) {
              const statusMessage = copied.length
                ? 'Anhänge gespeichert'
                : skipped.length
                  ? 'Anhänge übersprungen'
                  : result.lastCopy
                    ? 'Zuletzt Anhänge gespeichert'
                    : lastBatchNotCopied
                      ? 'Letzte Anhänge noch nicht gespeichert'
                    : matches.length
                      ? 'Keine Anhänge gespeichert'
                      : 'Keine neuen Anhänge in diesem Lauf';
              const transferDetails = copied.length
                ? `${copied.length} gespeichert${skipped.length ? ` · ${skipped.length} übersprungen` : ''} · ${copied.map((file) => file.target).join(', ')}`
                : skipped.length
                  ? `${skipped.length} übersprungen · ${skipped.map((file) => file.filename).join(', ')}`
                  : result.lastCopy
                    ? `Zuletzt ${result.lastCopy.count} gespeichert (${result.lastCopy.targets.join(', ')}) um ${new Date(result.lastCopy.copiedAt).toLocaleTimeString()}`
                    : lastBatchNotCopied
                      ? `Nicht gespeichert: ${result.lastBatch!.filenames.join(', ')}`
                    : `${matches.length ? '0 passende Anhänge gespeichert' : 'Keine passenden Anhänge'}${result.targetPath ? ` · Ziel ${result.targetPath}` : ''}`;
              return { ...node, data: { ...node.data, status: 'success', statusMessage, statusDetails: transferDetails } };
            }
            return node;
          }));
          setSecretAvailable((current) => ({
            ...current,
            [imapNode.id]: Boolean(imapNode.data.config?.password) || current[imapNode.id] || false,
            ...(imapTargetConnected ? { [targetNode!.id]: Boolean(targetNode!.data.config?.password) || current[targetNode!.id] || false } : {}),
          }));
          summaries.push(`${matches.length} passende Anhänge`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
          const imapTargetConnected = Boolean(targetNode && edges.some((edge) => edge.source === imapNode.id && edge.target === targetNode.id));
          setNodes((current) => current.map((node) => {
            if (node.id === imapNode.id) return { ...node, data: { ...node.data, status: 'error', statusMessage: 'Postfachprüfung fehlgeschlagen', statusDetails: message } };
            if (imapTargetConnected && node.id === targetNode!.id) return { ...node, data: { ...node.data, status: 'error', statusMessage: 'Anhang konnte nicht gespeichert werden', statusDetails: message } };
            return node;
          }));
          summaries.push(`IMAP-Fehler: ${message}`);
        }
      }

      if (networkConnected) {
        const networkNodeIds = new Set([sourceNode!.id, targetNode!.id]);
        try {
          const response = await fetch('/api/run/network-copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: sourceNode!.data.config ?? {}, target: targetNode!.data.config ?? {} }),
          });
          const responseText = await response.text();
          let result: { ok: boolean; found?: number; copied?: unknown[]; skipped?: unknown[]; error?: string; stage?: string };
          try {
            result = responseText ? JSON.parse(responseText) : { ok: false, error: 'Das lokale Backend hat nicht geantwortet. Bitte npm run dev neu starten.' };
          } catch {
            result = { ok: false, error: `Ungültige Backend-Antwort (${response.status}). Bitte npm run dev neu starten.` };
          }
          if (!response.ok || !result.ok) {
            const detail = result.error || `Backend-Fehler ${response.status}`;
            const message = result.stage ? `${result.stage}: ${detail}` : detail;
            const targetFailed = Boolean(result.stage?.includes('Ziel'));
            setNodes((current) => current.map((node) => {
              if (node.id === sourceNode!.id) return {
                ...node,
                data: targetFailed
                  ? { ...node.data, status: 'success', statusMessage: 'Quelle erfolgreich gelesen', statusDetails: 'Der Fehler ist erst beim Schreiben ins Ziel aufgetreten.' }
                  : { ...node.data, status: 'error', statusMessage: 'Lesen fehlgeschlagen', statusDetails: message },
              };
              if (node.id === targetNode!.id) return {
                ...node,
                data: targetFailed
                  ? { ...node.data, status: 'error', statusMessage: 'Schreiben fehlgeschlagen', statusDetails: message }
                  : { ...node.data, status: 'idle', statusMessage: 'Nicht ausgeführt', statusDetails: 'Das Ziel wurde nicht erreicht, weil die Quelle fehlgeschlagen ist.' },
              };
              return node;
            }));
            summaries.push(`Netzwerkfehler: ${message}`);
          } else {
            const summary = `${result.found ?? 0} Datei(en) gefunden · ${result.copied?.length ?? 0} kopiert · ${result.skipped?.length ?? 0} übersprungen`;
            setSecretAvailable((current) => ({
              ...current,
              [sourceNode!.id]: Boolean(sourceNode!.data.config?.password) || current[sourceNode!.id] || false,
              [targetNode!.id]: Boolean(targetNode!.data.config?.password) || current[targetNode!.id] || false,
            }));
            setNodes((current) => current.map((node) => {
              if (!networkNodeIds.has(node.id)) return node;
              const imapDetails = node.id === targetNode!.id && imapTargetNodeIds.has(node.id) && node.data.status === 'success'
                ? node.data.statusDetails
                : '';
              return {
                ...node,
                data: {
                  ...node.data,
                  status: 'success',
                  statusMessage: 'Letzter Lauf erfolgreich',
                  statusDetails: [summary, imapDetails && `IMAP-Anhänge: ${imapDetails}`].filter(Boolean).join(' · '),
                },
              };
            }));
            summaries.push(summary);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
          setNodes((current) => current.map((node) => networkNodeIds.has(node.id)
            ? { ...node, data: { ...node.data, status: 'error', statusMessage: 'Letzter Lauf fehlgeschlagen', statusDetails: message } }
            : node));
          summaries.push(`Netzwerkfehler: ${message}`);
        }
      }
      setNotice(summaries.join(' · ') || 'Lauf abgeschlossen');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
      setNodes((current) => current.map((node) => runningNodeIds.has(node.id)
        ? { ...node, data: { ...node.data, status: 'error', statusMessage: 'Letzter Lauf fehlgeschlagen', statusDetails: message } }
        : node));
      setNotice(`Fehler: ${message}`);
    } finally {
      setRunning(false);
    }
  };

  runWorkflowRef.current = runWorkflow;
  const intervalNode = nodes.find((node) => node.data.blockType === 'interval');
  const intervalParts = intervalUnits.map(({ id, milliseconds }) => ({
    value: Number(intervalNode?.data.config?.[id] ?? 0),
    milliseconds,
  }));
  const intervalMilliseconds = intervalParts.reduce((total, part) => total + part.value * part.milliseconds, 0);
  const intervalConfigurationValid = intervalParts.every(({ value }) => Number.isInteger(value) && value >= 0 && value <= 60)
    && intervalMilliseconds > 0;
  const triggerConnected = Boolean(intervalNode && edges.some((edge) => edge.source === intervalNode.id
    && ['network-read', 'imap'].includes(nodes.find((node) => node.id === edge.target)?.data.blockType ?? '')));
  useEffect(() => {
    if (!active || !triggerConnected || !intervalConfigurationValid) return;
    const maximumTimeout = 2_147_483_647;
    let stopped = false;
    let timer: number;
    const schedule = (remainingMilliseconds: number) => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        if (remainingMilliseconds > maximumTimeout) {
          schedule(remainingMilliseconds - maximumTimeout);
          return;
        }
        void runWorkflowRef.current(true).then(
          () => { if (!stopped) schedule(intervalMilliseconds); },
          () => { if (!stopped) schedule(intervalMilliseconds); },
        );
      }, Math.min(remainingMilliseconds, maximumTimeout));
    };
    schedule(intervalMilliseconds);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, intervalConfigurationValid, intervalMilliseconds, triggerConnected]);

  const filtered = blocks.filter((block) => `${block.name} ${block.description} ${block.category}`.toLowerCase().includes(search.toLowerCase()));
  const selectedNode = nodes.find((node) => node.selected);
  const selectedIntervalParts = selectedNode?.data.blockType === 'interval'
    ? intervalUnits.map(({ id }) => Number(selectedNode.data.config?.[id] ?? 0))
    : [];
  const selectedIntervalInvalid = selectedIntervalParts.length > 0
    && (selectedIntervalParts.some((value) => !Number.isInteger(value) || value < 0 || value > 60)
      || selectedIntervalParts.every((value) => value === 0));
  const selectedPath = selectedNode?.data.config?.path;
  const selectedUsername = selectedNode?.data.config?.username;
  const selectedDomain = selectedNode?.data.config?.domain;
  const selectedHost = selectedNode?.data.config?.host;
  const selectedPort = selectedNode?.data.config?.port;
  useEffect(() => {
    if (!selectedNode || !['network-read', 'network-write', 'imap'].includes(selectedNode.data.blockType)) return;
    const nodeId = selectedNode.id;
    const config = selectedNode.data.config ?? {};
    const isImap = selectedNode.data.blockType === 'imap';
    let cancelled = false;
    void fetch(isImap ? '/api/imap/credentials/status' : '/api/credentials/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: isImap
        ? { host: config.host, port: config.port, username: config.username }
        : { path: config.path, username: config.username, domain: config.domain } }),
    }).then((response) => response.json())
      .then((result: { available?: boolean }) => {
        if (!cancelled) setSecretAvailable((current) => ({ ...current, [nodeId]: Boolean(result.available) }));
      })
      .catch(() => {
        if (!cancelled) setSecretAvailable((current) => ({ ...current, [nodeId]: false }));
      });
    return () => { cancelled = true; };
  }, [selectedNode?.id, selectedPath, selectedUsername, selectedDomain, selectedHost, selectedPort]);
  const saveCredential = async (node: Node<BlockNodeData>, value: ConfigValue) => {
    if (typeof value !== 'string' || !value) return;
    const config = { ...(node.data.config ?? {}), password: value };
    const isImap = node.data.blockType === 'imap';
    try {
      const response = await fetch(isImap ? '/api/imap/credentials/save' : '/api/credentials/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const result = await response.json().catch(() => ({})) as { available?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || 'Zugangsdaten konnten nicht gespeichert werden.');
      setSecretAvailable((current) => ({ ...current, [node.id]: Boolean(result.available) }));
      setNotice('Zugangsdaten verschlüsselt gespeichert');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Zugangsdaten konnten nicht gespeichert werden.');
    }
  };
  const updateSelected = (key: string, value: ConfigValue) => {
    if (!selectedNode) return;
    setNodes((list) => list.map((node) => node.id === selectedNode.id
      ? { ...node, data: { ...node.data, status: 'idle', statusMessage: undefined, statusDetails: undefined, config: { ...node.data.config, [key]: value } } }
      : node));
  };

  const displayEdges = edges.map((edge) => {
    const sourceType = portType(edge.source, edge.sourceHandle ?? null, 'output');
    const targetType = portType(edge.target, edge.targetHandle ?? null, 'input');
    const sameType = sourceType === targetType;
    return {
      ...edge,
      label: sourceType && targetType && !sameType ? `${typeLabels[sourceType]} ist ${typeLabels[targetType]}` : undefined,
      labelStyle: { fontSize: 9, fontWeight: 600, fill: '#625d76' },
      labelBgStyle: { fill: '#fff', fillOpacity: .94 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 5,
      style: { stroke: '#7568dc', strokeWidth: 2.4 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#7568dc' },
    };
  });

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Zap size={17} fill="currentColor" /></span><span>Ports</span><small>v{meta?.version || '…'}</small></div>
      <div className="workflow-title"><strong>Posteingang archivieren</strong><span>Alle Änderungen gespeichert · Version {meta?.version || '…'}</span></div>
      <div className="top-actions">
        <button className="ghost-button"><CircleHelp size={17} /> Hilfe</button>
        <button className="ghost-button settings-button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> Einstellungen{meta?.update_available && <i className="update-dot" />}</button>
        <label className="active-toggle"><span className={`switch ${active ? 'on' : ''}`} onClick={() => setActive(!active)}><i /></span><b>{active ? 'Aktiv' : 'Inaktiv'}</b></label>
        <button className="run-button" onClick={() => { void runWorkflow(); }} disabled={running}><Play size={16} fill="currentColor" /> {running ? 'Läuft …' : 'Testen'}</button>
      </div>
    </header>

    <aside className={`library ${libraryOpen ? '' : 'closed'}`}>
      <div className="panel-title"><div><small>BAUSTEINE</small><h2>Blockbibliothek</h2></div><button onClick={() => setLibraryOpen(false)}><X size={18} /></button></div>
      <div className="search"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Blöcke durchsuchen …" /></div>
      <div className="library-list">
        {[...new Set(filtered.map((b) => b.category))].map((category) => <section key={category}>
          <h3><ChevronDown size={14} />{category}</h3>
          {filtered.filter((b) => b.category === category).map((block) => <button className="library-item" key={block.type} onClick={() => addBlock(block.type)}>
            <span style={{ background: block.color }}><Plus size={17} /></span><div><strong>{block.name}</strong><small>{block.description}</small></div>
          </button>)}
        </section>)}
      </div>
    </aside>
    {!libraryOpen && <button className="open-library" onClick={() => setLibraryOpen(true)}><Box size={18} /> Blöcke</button>}

    <main className="canvas" ref={flowRef}>
      <ReactFlow nodes={nodes} edges={displayEdges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection}
        nodeTypes={{ block: BlockNode }} fitView minZoom={0.45} maxZoom={1.6} deleteKeyCode={['Backspace', 'Delete']}>
        <Background color="#d9d9d3" gap={22} size={1.2} variant={BackgroundVariant.Dots} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => blockByType[(node.data as BlockNodeData).blockType]?.color ?? '#999'} />
      </ReactFlow>
      <div className="canvas-hint"><Sparkles size={14} /> Verbinde eine Quelle links mit einem passenden Ziel rechts</div>
    </main>

    {selectedNode && <aside className="inspector">
      <div className="panel-title"><div><small>KONFIGURATION</small><h2>{selectedNode.data.label}</h2></div><Settings2 size={19} /></div>
      <div className="inspector-scroll">
      <label>Name<input value={selectedNode.data.label} onChange={(e) => setNodes((list) => list.map((n) => n.id === selectedNode.id ? { ...n, data: { ...n.data, label: e.target.value } } : n))} /></label>
      <div className="config-fields">
        {blockByType[selectedNode.data.blockType].config.filter((field) => {
          if (!field.showWhen) return true;
          const controllingValue = selectedNode.data.config?.[field.showWhen.field]
            ?? blockByType[selectedNode.data.blockType].config.find((item) => item.id === field.showWhen?.field)?.defaultValue;
          return controllingValue === field.showWhen.equals;
        }).map((field) => {
          const value = selectedNode.data.config?.[field.id] ?? field.defaultValue ?? '';
          if (field.type === 'boolean') return <label className="check-field" key={field.id}>
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => updateSelected(field.id, e.target.checked)} /><span>{field.label}</span>
          </label>;
          if (field.type === 'string-list') {
            const values = Array.isArray(value) ? value : [];
            return <div className="list-field" key={field.id}>
              <b>{field.label}</b>
              {values.map((item, index) => <div className="list-field-row" key={`${index}-${item}`}>
                <input value={item} placeholder={field.placeholder} onChange={(e) => updateSelected(field.id, values.map((current, currentIndex) => currentIndex === index ? e.target.value : current))} />
                <button title="Muster löschen" onClick={() => updateSelected(field.id, values.filter((_, currentIndex) => currentIndex !== index))}><X size={14} /></button>
              </div>)}
              <button className="add-list-item" onClick={() => updateSelected(field.id, [...values, '*.*'])}><Plus size={14} /> Dateimuster hinzufügen</button>
              {field.help && <small className="field-help">{field.help}</small>}
            </div>;
          }
          return <label key={field.id}>{field.label}{field.required && <em> erforderlich</em>}
            {field.type === 'select'
              ? <select value={String(value)} onChange={(e) => updateSelected(field.id, e.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              : <input
                type={field.type}
                min={field.min}
                max={field.max}
                step={field.step}
                value={String(value)}
                placeholder={field.type === 'password' && secretAvailable[selectedNode.id] ? '••••••••••' : field.placeholder}
                onChange={(e) => updateSelected(field.id, field.type === 'number'
                  ? (e.target.value === '' ? '' : Number(e.target.value))
                  : e.target.value)}
                onBlur={field.type === 'password'
                  ? () => { void saveCredential(selectedNode, value); }
                  : field.type === 'number' && (field.min !== undefined || field.max !== undefined) ? (e) => {
                    const parsed = Number(e.currentTarget.value);
                    const finiteValue = Number.isFinite(parsed) ? parsed : Number(field.defaultValue ?? field.min ?? 0);
                    const steppedValue = field.step === 1 ? Math.round(finiteValue) : finiteValue;
                    const boundedValue = Math.max(field.min ?? Number.NEGATIVE_INFINITY, Math.min(field.max ?? Number.POSITIVE_INFINITY, steppedValue));
                    updateSelected(field.id, boundedValue);
                  } : undefined}
              />}
            {field.help && <small className="field-help">{field.help}</small>}
          </label>;
        })}
      </div>
      {selectedIntervalInvalid && <small className="field-help interval-validation">Mindestens ein Intervallwert muss größer als 0 sein. Jeder Wert darf zwischen 0 und 60 liegen.</small>}
      <div className="type-info"><b>Verfügbare Ports</b>{[...blockByType[selectedNode.data.blockType].inputs, ...blockByType[selectedNode.data.blockType].outputs].map((p) => <span key={`${p.direction}-${p.id}`}><i className={`type-chip type-${p.type}`} />{p.label}<small>{typeLabels[p.type]}</small></span>)}</div>
      {blockByType[selectedNode.data.blockType].inputs.some((port) => port.type === 'metadata') || blockByType[selectedNode.data.blockType].outputs.some((port) => port.type === 'metadata')
        ? <div className="metadata-note"><b>Was sind Metadaten?</b><p>Strukturierte Begleitinfos wie Absender, Betreff, Empfangsdatum, Dateiname und Tags. Sie beschreiben ein Dokument, sind aber nicht das Dokument selbst.</p></div>
        : null}
      </div>
    </aside>}

    {settingsOpen && <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-modal-header"><div><small>EINSTELLUNGEN</small><h2 id="settings-title">Ports verwalten</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Einstellungen schließen"><X size={19} /></button></header>
        <div className="settings-modal-scroll">
          <section className="settings-card">
            <div className="settings-card-heading"><div><h3>Version und Aktualisierungen</h3><p>Installierte Version: <strong>{meta ? `v${meta.version}` : 'wird geladen …'}</strong></p></div><span className="version-badge">v{meta?.version || '…'}</span></div>
            {!meta?.repository && <p className="settings-hint"><AlertTriangle size={15} /> Kein GitHub-Repository für die Updateprüfung konfiguriert.</p>}
            {meta?.repository && <p className="settings-hint">Repository: <code>{meta.repository}</code></p>}
            {meta?.update_available
              ? <div className="update-available"><CheckCircle2 size={17} /><span><strong>Version {meta.latest_version} ist verfügbar.</strong>{meta.release_url && <a href={meta.release_url} target="_blank" rel="noreferrer">Release ansehen</a>}</span><button className="run-button" onClick={() => { void startUpdate(); }} disabled={updateInstalling}>{updateInstalling ? 'Update läuft …' : 'Update installieren'}</button></div>
              : <p className="update-current">{meta?.update_check_error || updateMessage || 'Noch keine Updateprüfung durchgeführt.'}</p>}
            {updateMessage && meta?.update_available && <p className="update-message">{updateMessage}</p>}
            {updateInstalling && <div className="update-progress"><div className="progress-label"><span>{updateStatus.step}</span><strong>{Math.round(updateStatus.progress)}%</strong></div><div className="progress-track"><i style={{ width: `${Math.max(5, Math.min(100, updateStatus.progress))}%` }} /></div><small>Der Dienst kann während des Neustarts kurz nicht erreichbar sein.</small></div>}
            {updateStatus.state === 'failed' && !updateInstalling && <p className="update-error"><AlertTriangle size={15} />{updateStatus.step} {updateMessage}</p>}
            <button className="secondary-button" onClick={() => { void checkForUpdates(); }} disabled={checkingUpdates || updateInstalling}><RefreshCw size={15} className={checkingUpdates ? 'spin-icon' : ''} />{checkingUpdates ? 'Suche nach Updates …' : 'Nach Updates suchen'}</button>
            <details className="changelog"><summary>Änderungsprotokoll anzeigen</summary><pre>{meta?.changelog || 'Änderungsprotokoll wird geladen …'}</pre></details>
          </section>
          <section className="settings-card">
            <h3>Zugangsdaten</h3>
            <p>IMAP- und SMB-Benutzernamen werden zusammen mit den Passwörtern dauerhaft im Backend gespeichert. Passwörter liegen verschlüsselt in <code>data/credentials.enc</code> und werden nicht im Browser-Workflow abgelegt.</p>
          </section>
        </div>
      </section>
    </div>}

    <footer className="statusbar"><span><i className={active ? 'live' : ''} />{notice}</span><span>{nodes.length} Blöcke&nbsp;&nbsp;·&nbsp;&nbsp;{edges.length} Verbindungen</span></footer>
  </div>;
}

export function App() { return <ReactFlowProvider><Editor /></ReactFlowProvider>; }
