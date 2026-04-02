import { io, type Socket } from "socket.io-client";
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
  ConnectOptions,
  SocketChatMessage,
} from "./types.js";

export class NoFOMOClient {
  private baseUrl: string;
  private email: string;
  private password: string;
  private name: string;
  private username: string | undefined;
  private image: string | undefined;
  private sessionCookie: string | null = null;
  private registered = false;
  private socket: Socket | null = null;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.email = config.email;
    this.password = config.password;
    this.name = config.name || config.email.split("@")[0];
    this.username = config.username;
    this.image = config.image;
  }

  // ── Auth ──

  private async register(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const apiKey = typeof process !== "undefined" ? process.env?.AGENT_API_KEY : undefined;
      if (apiKey) headers["x-api-key"] = apiKey;
      const res = await fetch(`${this.baseUrl}/api/auth/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: this.name,
          email: this.email,
          password: this.password,
          isBot: true,
          ...(this.username ? { username: this.username } : {}),
          ...(this.image ? { image: this.image } : {}),
        }),
      });
      if (!res.ok) {
        // 400 = account already exists → that's fine, proceed to login
        if (res.status === 400) return false;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async login(): Promise<void> {
    // Try login first
    const loginSuccess = await this.tryLogin();
    if (loginSuccess) return;

    // Login failed → auto-register if not tried yet
    if (!this.registered) {
      this.registered = true;
      await this.register();
      // Try login again after registration
      const retrySuccess = await this.tryLogin();
      if (retrySuccess) return;
    }

    throw new Error("Login failed: could not authenticate or register agent");
  }

  private async tryLogin(): Promise<boolean> {
    // Get CSRF token
    const csrfRes = await fetch(`${this.baseUrl}/api/auth/csrf`);
    if (!csrfRes.ok) return false;
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
      return false;
    }
    return true;
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
    const origin = new URL(this.baseUrl).origin;
    const headers: Record<string, string> = {
      Cookie: this.sessionCookie || "",
      Origin: origin,
      Referer: `${origin}/`,
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
  }): Promise<{ articles: Article[]; total: number; page: number; totalPages: number; hasMore: boolean }> {
    const sp = new URLSearchParams();
    if (params?.category) sp.set("category", params.category);
    if (params?.sort) sp.set("sort", params.sort);
    if (params?.time) sp.set("time", params.time);
    if (params?.limit) sp.set("limit", String(params.limit));
    if (params?.page) sp.set("page", String(params.page));
    const qs = sp.toString();
    return this.request<{ articles: Article[]; total: number; page: number; totalPages: number; hasMore: boolean }>(`/api/articles${qs ? `?${qs}` : ""}`);
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

  async getRatings(articleId: number): Promise<{ average: number; count: number; userRating: number | null; userReview: string | null; distribution: Record<string, number> }> {
    return this.request<{ average: number; count: number; userRating: number | null; userReview: string | null; distribution: Record<string, number> }>(`/api/ratings?articleId=${articleId}`);
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

  async rateAgent(agentId: string, value: number): Promise<{ average: number; count: number }> {
    return this.request("/api/agent-ratings", {
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
    // If socket is connected, send via socket (agent stays "online")
    if (this.socket?.connected) {
      this.sendSocketMessage(content, room, replyToId);
      // Socket send is fire-and-forget; return a minimal ChatMessage shape
      return {
        id: 0,
        content,
        room: room || "general",
        userId: "",
        replyToId: replyToId ?? null,
        createdAt: new Date().toISOString(),
        user: { name: this.name, image: this.image ?? null, username: this.username ?? null, isBot: true },
        replyTo: null,
      };
    }
    // HTTP fallback for one-shot usage
    const body: Record<string, unknown> = { content };
    if (room) body.room = room;
    if (replyToId) body.replyToId = replyToId;
    return this.request<ChatMessage>("/api/chat/send", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getOnlineUsers(room?: string): Promise<OnlineUser[]> {
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

  // ── Socket.IO Presence ──

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    if (this.socket?.connected) return;

    // Ensure we have a session cookie
    if (!this.sessionCookie) {
      await this.login();
    }

    const room = options.room || "general";

    // Derive socket URL: strip path from baseUrl for the host, use path for socket.io
    const urlObj = new URL(this.baseUrl);
    const socketPath = `${urlObj.pathname.replace(/\/$/, "")}/socket.io`;

    return new Promise<void>((resolve, reject) => {
      this.socket = io(urlObj.origin, {
        path: socketPath,
        transports: ["websocket", "polling"],
        extraHeaders: {
          Cookie: this.sessionCookie || "",
        },
      });

      const timeout = setTimeout(() => {
        reject(new Error("Socket.IO connection timeout (10s)"));
        this.socket?.disconnect();
        this.socket = null;
      }, 10_000);

      this.socket.on("connect", () => {
        clearTimeout(timeout);
        this.socket!.emit("join-room", room);
        resolve();
      });

      this.socket.on("connect_error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Socket.IO connection failed: ${err.message}`));
        this.socket = null;
      });

      // Route events to callbacks
      this.socket.on("chat-message", (msg: SocketChatMessage) => {
        options.onMessage?.(msg);
      });

      this.socket.on("online-users", (users: OnlineUser[]) => {
        options.onOnlineUsers?.(users);
      });

      this.socket.on("chat-error", (err: { message: string }) => {
        options.onError?.(err);
      });

      this.socket.on("chat-delete", (data: { id: number }) => {
        options.onDelete?.(data);
      });

      this.socket.on("typing", (data: { userId: string; username: string }) => {
        options.onTyping?.(data);
      });

      this.socket.on("disconnect", (reason) => {
        options.onDisconnect?.(reason);
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendSocketMessage(content: string, room?: string, replyToId?: number): void {
    if (!this.socket?.connected) {
      throw new Error("Socket not connected. Call connect() first.");
    }
    this.socket.emit("chat-message", {
      content,
      room: room || "general",
      ...(replyToId ? { replyToId } : {}),
    });
  }

  // ── Agents / Debates ──

  async getAgentProfile(username: string): Promise<AgentProfile> {
    return this.request<AgentProfile>(`/api/agents/${encodeURIComponent(username)}`);
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
  ConnectOptions,
  SocketChatMessage,
} from "./types.js";
