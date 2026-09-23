import { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CheckCircle2, Clock3, FolderOpen, Globe2, Info, Mail, SlidersHorizontal, TriangleAlert, X } from 'lucide-react';
import { blockByType } from '../blocks/registry';
import { typeLabels } from '../core/typeSystem';
import type { BlockNodeData } from '../types';

const icons = { mail: Mail, folder: FolderOpen, filter: SlidersHorizontal, globe: Globe2, clock: Clock3 };

export function BlockNode({ data, selected }: NodeProps) {
  const nodeData = data as BlockNodeData;
  const block = blockByType[nodeData.blockType];
  const Icon = icons[block.icon];
  const rows = Math.max(block.inputs.length, block.outputs.length, 1);
  const [statusOpen, setStatusOpen] = useState(false);
  const status = nodeData.status ?? 'idle';
  const StatusIcon = status === 'error' ? TriangleAlert : status === 'success' ? CheckCircle2 : Info;

  return (
    <article className={`block-node puzzle-block ${block.inputs.length ? 'has-input' : ''} ${block.outputs.length ? 'has-output' : ''} ${selected ? 'selected' : ''}`} style={{ '--accent': block.color } as React.CSSProperties}>
      <header className="block-header">
        <span className="block-icon"><Icon size={17} strokeWidth={2.2} /></span>
        <span><strong>{nodeData.label}</strong><small>{block.category}</small></span>
        <button
          className={`status-dot nodrag ${status}`}
          title="Status und Details anzeigen"
          aria-label="Status und Details anzeigen"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setStatusOpen((open) => !open); }}
        />
      </header>
      {statusOpen && <div className={`status-popover nodrag ${status}`} onMouseDown={(event) => event.stopPropagation()}>
        <div><StatusIcon size={16} /><strong>{nodeData.statusMessage ?? (status === 'idle' ? 'Noch nicht ausgeführt' : 'Status')}</strong><button onClick={() => setStatusOpen(false)} aria-label="Schließen"><X size={14} /></button></div>
        <p>{nodeData.statusDetails ?? (status === 'idle' ? 'Starte den Ablauf über „Testen“ oder einen verbundenen Trigger.' : 'Keine weiteren Details vorhanden.')}</p>
        {status === 'error' && <small>Prüfe Pfad, Zugangsdaten, Freigaberechte und Erreichbarkeit des Servers.</small>}
      </div>}
      <div className="port-grid">
        {Array.from({ length: rows }).map((_, index) => {
          const input = block.inputs[index];
          const output = block.outputs[index];
          return (
            <div className="port-row" key={index}>
              <div className="port input-port">
                {input && <>
                  <Handle type="target" position={Position.Left} id={input.id} className={`handle type-${input.type}`} />
                  <span title={typeLabels[input.type]}>{input.label}</span>
                </>}
              </div>
              <div className="port output-port">
                {output && <>
                  <span title={typeLabels[output.type]}>{output.label}</span>
                  <Handle type="source" position={Position.Right} id={output.id} className={`handle type-${output.type}`} />
                </>}
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}
