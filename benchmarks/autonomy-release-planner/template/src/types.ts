export interface ReleaseItem {
  id: string;
  title: string;
  priority: number;
  depends_on?: string[];
}

export interface BlockedItem {
  id: string;
  blocked_by: string[];
}

export interface ReleasePlan {
  next: string[];
  blocked: BlockedItem[];
  order: string[];
}
