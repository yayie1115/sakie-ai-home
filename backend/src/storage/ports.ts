export type { CloudMessageStore, LocalArchivePort, DeviceAuthPort, MemorySearchPort, ModelCallLedger, BudgetPort, ContextAssemblyPort } from '@sakie/contracts';
/** Cloud orders turns and keeps a durable spool; Windows owns the full archive. */
export interface StorageResponsibilities { role: 'cloud' | 'windows'; fullArchive: boolean; ordersChat: boolean; }
export const storageResponsibilities: Readonly<Record<'cloud' | 'windows', StorageResponsibilities>> = {
  cloud: { role: 'cloud', fullArchive: false, ordersChat: true },
  windows: { role: 'windows', fullArchive: true, ordersChat: false },
};
