export interface Diary { id: string; date: string; content: string; }
export type CreateDiary = Omit<Diary, 'id'>;
