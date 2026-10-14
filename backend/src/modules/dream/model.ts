export interface Dream { id: string; date: string; content: string; source: 'ai' | 'user'; }
export type CreateDream = Omit<Dream, 'id'>;
