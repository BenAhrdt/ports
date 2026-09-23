export type DataType = 'any' | 'trigger' | 'file' | 'document' | 'pdf' | 'image' | 'text' | 'email' | 'metadata';
export type ConfigValue = string | number | boolean | string[];

export type PortDefinition = {
  id: string;
  label: string;
  type: DataType;
  direction: 'input' | 'output';
  required?: boolean;
};

export type BlockDefinition = {
  type: string;
  name: string;
  description: string;
  category: 'Quellen' | 'Dateien' | 'Logik' | 'Netzwerk';
  color: string;
  icon: 'mail' | 'folder' | 'filter' | 'globe' | 'clock';
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  config: ConfigField[];
};

export type ConfigField = {
  id: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'boolean' | 'string-list';
  placeholder?: string;
  help?: string;
  options?: { label: string; value: string }[];
  defaultValue?: ConfigValue;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  showWhen?: { field: string; equals: string | number | boolean };
};

export type BlockNodeData = {
  blockType: string;
  label: string;
  status?: 'idle' | 'running' | 'success' | 'error';
  statusMessage?: string;
  statusDetails?: string;
  config?: Record<string, ConfigValue>;
  [key: string]: unknown;
};
