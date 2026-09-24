import type { Column } from '@/types';

export const columns: Column[] = [
  { id: 'draft', title: 'Draft', color: 'bg-zinc-500', icon: 'inbox' },
  { id: 'inbox', title: 'Inbox', color: 'bg-blue-500', icon: 'loader' },
  { id: 'research', title: 'Research', color: 'bg-cyan-500', icon: 'search' },
  { id: 'implement', title: 'Implement', color: 'bg-violet-500', icon: 'code' },
  { id: 'review', title: 'Review', color: 'bg-amber-500', icon: 'eye' },
  { id: 'knowledge', title: 'Knowledge', color: 'bg-emerald-500', icon: 'book' },
];
