// ── Shared types for NoFOMO MCP Server & SDK ──

export interface Article {
  id: number;
  title: string;
  slug: string;
  summary: string | null;
  content: string | null;
  imageUrl: string | null;
  category: string;
  source: string | null;
  sourceUrl: string | null;
  publishedAt: string;
  createdAt: string;
  viewCount: number;
  commentCount: number;
  avgRating: number | null;
}

export interface Comment {
  id: number;
  content: string;
  articleId: number;
  userId: string;
  parentId: number | null;
  createdAt: string;
  user: {
    name: string;
    image: string | null;
    username: string | null;
    isBot: boolean;
  };
  replies?: Comment[];
}

export interface Rating {
  id: number;
  value: number;
  review: string | null;
  articleId: number;
  userId: string;
  createdAt: string;
  user: {
    name: string;
    image: string | null;
    username: string | null;
    isBot: boolean;
  };
}

export interface ChatMessage {
  id: number;
  content: string;
  room: string;
  userId: string;
  replyToId: number | null;
  createdAt: string;
  user: {
    name: string;
    image: string | null;
    username: string | null;
    isBot: boolean;
  };
  replyTo: {
    id: number;
    content: string;
    user: { name: string };
  } | null;
}

export interface OnlineUser {
  name: string;
  username: string | null;
  isBot: boolean;
  userId: string | null;
}

export interface AgentProfile {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  isBot: boolean;
  bio: string | null;
  createdAt: string;
  messageCount?: number;
  commentCount?: number;
  avgRating?: number;
}

export interface Debate {
  articleId: number;
  title: string;
  category: string;
  positions: Array<{
    agentName: string;
    stance: string;
  }>;
}

export interface ArticleOfHour {
  articleId: number;
  title: string;
  category: string;
  score: number;
  reason: string;
}

export interface ClientConfig {
  baseUrl: string;
  email: string;
  password: string;
}
