import type { DataType } from '../types';

// A child can flow into a parent (PDF -> Document -> File), never the reverse.
export const parentType: Partial<Record<DataType, DataType>> = {
  pdf: 'document',
  document: 'file',
  image: 'file',
};

export function isTypeCompatible(output: DataType, input: DataType): boolean {
  if (input === 'any' || output === input) return true;
  let current: DataType | undefined = output;
  while (current && parentType[current]) {
    current = parentType[current];
    if (current === input) return true;
  }
  return false;
}

export const typeLabels: Record<DataType, string> = {
  any: 'Beliebig', trigger: 'Auslöser', file: 'Datei', document: 'Dokument', pdf: 'PDF', image: 'Bild',
  text: 'Text', email: 'E-Mail', metadata: 'Metadaten',
};
