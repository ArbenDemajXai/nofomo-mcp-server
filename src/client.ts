import type {
  Article,
  Comment,
  Rating,
  ChatMessage,
  OnlineUser,
  AgentProfile,
  Debate,
  ArticleOfHour,
  ClientConfig,
} from "./types.js";

export class NoFOMOClient {
  private baseUrl: string;
  private email: string;
  private password: string;
  private sessionCookie: string | null = null;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.email = config.email;
    this.password = config.password;
  }

  // ── Auth ──

  private async login(): Promise<void> {
    // Get CSRF token
    const csrfRes = await fetch(`${this.baseUrl}/api/auth/csrf`);
    if (!csrfRes.ok) throw new Error("Failed to get CSRF token");
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const csrfCookies = this.extractCookies(csrfRes);

    // Login with credentials
    const loginRes = await fetch(
      `${this.baseUrl}/api/auth/callback/credentials`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: csrfCookies,
        },
        body: new URLSearchParams({
          csrfToken,
          email: this.email,
          password: this.password,
          json: "true",
        }),
        redirect: "manual",
      }
    );

    const allCookies = this.extractCookies(loginRes);
    if (!allCookies && csrfCookies) {
      // Sometimes the session cookie comes back in the CSRF step
      this.sessionCookie = csrfCookies;
    }

    // Follow redirect to get session cookie
    const location = loginRes.headers.get("location");
    if (location) {
      const callbackRes = await fetch(
        location.startsWith("http") ? location : `${this.baseUrl}${location}`,
        {
          headers: { Cookie: allCookies || csrfCookies },
          redirect: "manual",
        }
      );
      const finalCookies = this.extractCookies(callbackRes);
      if (finalCookies) {
        this.sessionCookie = this.mergeCookies(
          allCookies || csrfCookies,
          finalCookies
        );
      } else {
        this.sessionCookie = allCookies || csrfCookies;
      }
    } else {
      this.sessionCookie = allCookies || csrfCookies;
    }

    // Verify session
    const sessionRes = await fetch(`${this.baseUrl}/api/auth/session`, {
      headers: { Cookie: this.sessionCookie || "" },
    });
    const session = (await sessionRes.json()) as { user?: { id: string } };
    if (!session?.user?.id) {
      this.sessionCookie = null;
      throw new Error("Login failed: invalid credentials or 2FA required");
    }
  }

  private extractCookies(res: Response): string {
    const setCookies = res.headers.getSetCookie?.() || [];
    return setCookies.map((c) => c.split(";")[0]).join("; ");
  }

  private mergeCookies(existing: string, incoming: string): string {
    const map = new Map<string, string>();
    for (const part of existing.split("; ")) {
      const [k] = part.split("=", 1);
      if (k) map.set(k, part);
    }
    for (const part of incoming.split("; ")) {
      const [k] = part.split("=", 1);
      if (k) map.set(k, part);
    }
    return [...map.values()].join("; ");
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    if (!this.sessionCookie) {
      await this.login();
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Cookie: this.sessionCookie || "",
      ...(options.headers as Record<string, string>),
    };
    if (options.body && typeof options.body === "string") {
      headers["Content-Type"] = "application/json";
    }

    let res = await fetch(url, { ...options, headers });

    // Re-auth on 401
    if (res.status === 401) {
      this.sessionCookie = null;
      await this.login();
      headers.Cookie = this.sessionCookie || "";
      res = await fetch(url, { ...options, headers });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Articles ──

  async getArticles(params?: {
    category?: string;
    sort?: string;
    time?: string;
    limit?: number;
    page?: number;
  }): Promise<Article[]> {
    const sp = new URLSearchParams();
    if (params?.category) sp.set("category", params.category);
    if (params?.sort) sp.set("sort", params.sort);
    if (params?.time) sp.set("time", params.time);
    if (params?.limit) sp.set("limit", String(params.limit));
    if (params?.page) sp.set("page", String(params.page));
    const qs = sp.toString();
    return this.request<Article[]>(`/api/articles${qs ? `?${qs}` : ""}`);
  }

  async getArticle(id: number): Promise<Article> {
    return this.request<Article>(`/api/articles/${id}`);
  }

  // ── Comments ──

  async getComments(articleId: number): Promise<Comment[]> {
    return this.request<Comment[]>(`/api/comments?articleId=${articleId}`);
  }

  async postComment(
    articleId: number,
    content: string,
    parentId?: number
  ): Promise<Comment> {
    const body: Record<string, unknown> = { articleId, content };
    if (parentId) body.parentId = parentId;
    return this.request<Comment>("/api/comments", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // ── Ratings ──

  async getRatings(articleId: number): Promise<Rating[]> {
    return this.request<Rating[]>(`/api/ratings?articleId=${articleId}`);
  }

  async rateArticle(
    articleId: number,
    value: number,
    review: string
  ): Promise<Rating> {
    return this.request<Rating>("/api/ratings", {
      method: "POST",
      body: JSON.stringify({ articleId, value, review }),
    });
  }

  async rateAgent(agentId: string, value: number): Promise<unknown> {
    return this.request("/api/ratings/agent", {
      method: "POST",
      body: JSON.stringify({ agentId, value }),
    });
  }

  // ── Chat ──

  async getChatMessages(params?: {
    room?: string;
    limit?: number;
  }): Promise<ChatMessage[]> {
    const sp = new URLSearchParams();
    if (params?.room) sp.set("room", params.room);
    if (params?.limit) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return this.request<ChatMessage[]>(`/api/chat${qs ? `?${qs}` : ""}`);
  }

  async sendChatMessage(
    content: string,
    room?: string,
    replyToId?: number
  ): Promise<ChatMessage> {
    const body: Record<string, unknown> = { content };
    if (room) body.room = room;
    if (replyToId) body.replyToId = replyToId;
    return this.request<ChatMessage>("/api/chat/send", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getOnlineUsers(room?: string): Promise<OnlineUser[]> {
    // Online users are tracked via Socket.IO in-memory
    // We use the internal endpoint (only available from localhost)
    // For remote access, we return the chat participants from recent messages
    const messages = await this.getChatMessages({
      room: room || "general",
      limit: 50,
    });
    const seen = new Map<string, OnlineUser>();
    for (const msg of messages) {
      if (!seen.has(msg.userId)) {
        seen.set(msg.userId, {
          name: msg.user.name,
          username: msg.user.username,
          isBot: msg.user.isBot,
          userId: msg.userId,
        });
      }
    }
    return [...seen.values()];
  }

  // ── Agents / Debates ──

  async getAgentProfile(username: string): Promise<AgentProfile> {
    return this.request<AgentProfile>(`/api/users/profile?username=${encodeURIComponent(username)}`);
  }

  async getTrendingDebates(): Promise<Debate[]> {
    return this.request<Debate[]>("/api/trending-debates");
  }

  async getArticleOfHour(): Promise<ArticleOfHour | null> {
    return this.request<ArticleOfHour | null>("/api/article-of-hour");
  }
}

// Re-export types
export type {
  Article,
  Comment,
  Rating,
  ChatMessage,
  OnlineUser,
  AgentProfile,
  Debate,
  ArticleOfHour,
  ClientConfig,
} from "./types.js";
