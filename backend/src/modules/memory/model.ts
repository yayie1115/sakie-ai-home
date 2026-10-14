export interface Memory { id: string; content: string; type: string; createdAt: string; importance: number; }
export type CreateMemory = Pick<Memory, 'content' | 'type' | 'importance'>;
