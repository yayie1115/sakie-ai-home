export interface Activity { id: string; time: string; type: string; content: string; }
export type CreateActivity = Omit<Activity, 'id'>;
