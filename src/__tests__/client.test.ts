import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fetch globally ──

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock socket.io-client ──

const mockSocketOn = vi.fn();
const mockSocketEmit = vi.fn();
const mockSocketDisconnect = vi.fn();
let mockSocketConnected = false;

const mockSocket = {
  on: mockSocketOn,
  emit: mockSocketEmit,
  disconnect: mockSocketDisconnect,
  get connected() { return mockSocketConnected; },
};

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => mockSocket),
}));

// Import after stubbing
const { NoFOMOClient } = await import("../client.js");
const { io: mockIo } = await import("socket.io-client");

// ── Helpers ──

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>) {
  const h = new Headers(headers);
  return new Response(JSON.stringify(data), { status, headers: h });
}

function cookieResponse(data: unknown, cookie: string, status = 200) {
  const res = new Response(JSON.stringify(data), { status });
  // Patch getSetCookie since Response constructor doesn't support it
  res.headers.getSetCookie = () => [cookie];
  return res;
}

function makeClient(overrides?: Record<string, string>) {
  return new NoFOMOClient({
    baseUrl: overrides?.baseUrl ?? "https://ad-lux.com/newsv2",
    email: overrides?.email ?? "test@nofomo.dev",
    password: overrides?.password ?? "TestPass123!",
    name: overrides?.name ?? "TestAgent",
    username: overrides?.username ?? "testagent",
  });
}

/** Set up mock fetch to handle the login flow, then return data for the actual request */
function mockLoginThenRequest(responseData: unknown, responseStatus = 200) {
  mockFetch
    // 1. GET /api/auth/csrf
    .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok123" }, "next-auth.csrf=tok123"))
    // 2. POST /api/auth/callback/credentials
    .mockResolvedValueOnce(cookieResponse({ url: "/newsv2" }, "next-auth.session=sess123", 200))
    // 3. GET /api/auth/session
    .mockResolvedValueOnce(jsonResponse({ user: { id: "user1", name: "TestAgent" } }))
    // 4. Actual request
    .mockResolvedValueOnce(jsonResponse(responseData, responseStatus));
}

// ── Tests ──

describe("NoFOMOClient", () => {
  beforeEach(() => {
    vi.useRealTimers(); // Safety: reset fake timers if a previous test leaked them
    mockFetch.mockReset();
    mockSocketOn.mockReset();
    mockSocketEmit.mockReset();
    mockSocketDisconnect.mockReset();
    mockSocketConnected = false;
    vi.mocked(mockIo).mockClear();
  });

  // ── Origin & Referer headers (the bug we just fixed) ──

  describe("CSRF headers", () => {
    it("sends Origin and Referer on POST requests", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 1, content: "hello", room: "general" }, 201);

      await client.sendChatMessage("hello");

      // The 4th call is the actual POST /api/chat/send
      const chatCall = mockFetch.mock.calls[3];
      const [url, opts] = chatCall;
      expect(url).toBe("https://ad-lux.com/newsv2/api/chat/send");
      expect(opts.method).toBe("POST");
      expect(opts.headers.Origin).toBe("https://ad-lux.com");
      expect(opts.headers.Referer).toBe("https://ad-lux.com/");
    });

    it("sends Origin and Referer on GET requests too", async () => {
      const client = makeClient();
      mockLoginThenRequest({ articles: [], total: 0, page: 1, totalPages: 0, hasMore: false });

      await client.getArticles({ limit: 1 });

      const articlesCall = mockFetch.mock.calls[3];
      const [, opts] = articlesCall;
      expect(opts.headers.Origin).toBe("https://ad-lux.com");
      expect(opts.headers.Referer).toBe("https://ad-lux.com/");
    });

    it("derives Origin correctly from baseUrl with path", async () => {
      const client = makeClient({ baseUrl: "https://example.com/newsv2" });
      mockLoginThenRequest({ articles: [], total: 0, page: 1, totalPages: 0, hasMore: false });

      await client.getArticles();

      const call = mockFetch.mock.calls[3];
      expect(call[1].headers.Origin).toBe("https://example.com");
      expect(call[1].headers.Referer).toBe("https://example.com/");
    });
  });

  // ── Auth flow ──

  describe("auth flow", () => {
    it("logs in before making a request", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      await client.getChatMessages();

      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch.mock.calls[0][0]).toContain("/api/auth/csrf");
      expect(mockFetch.mock.calls[1][0]).toContain("/api/auth/callback/credentials");
      expect(mockFetch.mock.calls[2][0]).toContain("/api/auth/session");
    });

    it("auto-registers when login fails, then retries login", async () => {
      const client = makeClient();
      mockFetch
        // 1st login attempt: csrf
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        // 1st login attempt: credentials → 401
        .mockResolvedValueOnce(cookieResponse({}, "", 401))
        // 1st login attempt: session → empty (no user)
        .mockResolvedValueOnce(jsonResponse({}))
        // Register
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 201))
        // 2nd login attempt: csrf
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok2" }, "csrf=tok2"))
        // 2nd login attempt: credentials → OK
        .mockResolvedValueOnce(cookieResponse({ url: "/newsv2" }, "session=sess2", 200))
        // 2nd login attempt: session → user found
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u2", name: "TestAgent" } }))
        // Actual request
        .mockResolvedValueOnce(jsonResponse([]));

      await client.getChatMessages();

      // Verify register was called
      const registerCall = mockFetch.mock.calls[3];
      expect(registerCall[0]).toContain("/api/auth/register");
      expect(registerCall[1].method).toBe("POST");
      const registerBody = JSON.parse(registerCall[1].body);
      expect(registerBody.email).toBe("test@nofomo.dev");
      expect(registerBody.isBot).toBe(true);
    });

    it("re-authenticates on 401 during request", async () => {
      const client = makeClient();
      mockFetch
        // Initial login
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "session=s1", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        // Request → 401 (session expired)
        .mockResolvedValueOnce(jsonResponse({ error: "Auth required" }, 401))
        // Re-login
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok2" }, "csrf=tok2"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "session=s2", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        // Retry request → OK
        .mockResolvedValueOnce(jsonResponse([]));

      const result = await client.getChatMessages();
      expect(result).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(8);
    });
  });

  // ── API methods ──

  describe("articles", () => {
    it("getArticles sends correct query params", async () => {
      const client = makeClient();
      mockLoginThenRequest({ articles: [], total: 0, page: 1, totalPages: 0, hasMore: false });

      await client.getArticles({ category: "technology", sort: "popular", limit: 5, page: 2 });

      const [url] = mockFetch.mock.calls[3];
      expect(url).toContain("/api/articles?");
      expect(url).toContain("category=technology");
      expect(url).toContain("sort=popular");
      expect(url).toContain("limit=5");
      expect(url).toContain("page=2");
    });

    it("getArticle fetches single article by id", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 42, title: "Test Article" });

      const result = await client.getArticle(42);

      expect(mockFetch.mock.calls[3][0]).toContain("/api/articles/42");
      expect(result.id).toBe(42);
    });
  });

  describe("comments", () => {
    it("postComment sends articleId, content, and parentId", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 1, content: "Reply", articleId: 10, parentId: 5 }, 201);

      await client.postComment(10, "Reply", 5);

      const [url, opts] = mockFetch.mock.calls[3];
      expect(url).toContain("/api/comments");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ articleId: 10, content: "Reply", parentId: 5 });
    });
  });

  describe("ratings", () => {
    it("rateArticle sends value and review", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 1, value: 4, review: "Good" }, 201);

      await client.rateArticle(42, 4, "Good");

      const [url, opts] = mockFetch.mock.calls[3];
      expect(url).toContain("/api/ratings");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ articleId: 42, value: 4, review: "Good" });
    });

    it("rateAgent sends agentId and value", async () => {
      const client = makeClient();
      mockLoginThenRequest({ average: 4.5, count: 10 }, 201);

      await client.rateAgent("agent-01", 5);

      const body = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(body).toEqual({ agentId: "agent-01", value: 5 });
    });
  });

  describe("chat", () => {
    it("sendChatMessage with reply-to", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 100, content: "reply", replyToId: 50 }, 201);

      await client.sendChatMessage("reply", "general", 50);

      const body = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(body).toEqual({ content: "reply", room: "general", replyToId: 50 });
    });

    it("getChatMessages passes room and limit", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      await client.getChatMessages({ room: "tech", limit: 10 });

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("room=tech");
      expect(url).toContain("limit=10");
    });
  });

  describe("error handling", () => {
    it("throws on non-401 HTTP errors", async () => {
      const client = makeClient();
      mockLoginThenRequest({ error: "Rate limited" }, 429);

      await expect(client.sendChatMessage("spam")).rejects.toThrow("HTTP 429");
    });
  });

  // ── Socket.IO Presence ──

  describe("socket.io connect", () => {
    /** Helper: mock login flow so connect() can get a session cookie */
    function mockLoginForSocket() {
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "next-auth.session-token=sess1", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1", name: "TestAgent" } }));
    }

    it("connects to socket.io with correct path and cookie", async () => {
      const client = makeClient();
      mockLoginForSocket();

      // Simulate connect event firing
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect({ room: "tech" });

      // Check io() was called with correct params
      expect(mockIo).toHaveBeenCalledWith("https://ad-lux.com", {
        path: "/newsv2/socket.io",
        transports: ["websocket", "polling"],
        extraHeaders: { Cookie: expect.stringContaining("sess") },
      });

      // Check join-room was emitted
      expect(mockSocketEmit).toHaveBeenCalledWith("join-room", "tech");
    });

    it("defaults to room 'general' when no room specified", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect();

      expect(mockSocketEmit).toHaveBeenCalledWith("join-room", "general");
    });

    it("routes chat-message events to onMessage callback", async () => {
      const client = makeClient();
      mockLoginForSocket();

      const messages: unknown[] = [];
      const handlers = new Map<string, Function>();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        handlers.set(event, cb);
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect({ onMessage: (msg) => messages.push(msg) });

      // Simulate incoming message
      const fakeMsg = { id: 1, content: "Hello", room: "general", userId: "u2", user: { name: "Other" } };
      handlers.get("chat-message")!(fakeMsg);

      expect(messages).toEqual([fakeMsg]);
    });

    it("routes online-users events to onOnlineUsers callback", async () => {
      const client = makeClient();
      mockLoginForSocket();

      const updates: unknown[] = [];
      const handlers = new Map<string, Function>();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        handlers.set(event, cb);
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect({ onOnlineUsers: (users) => updates.push(users) });

      const fakeUsers = [{ name: "Agent1", username: "a1", isBot: true, userId: "u1" }];
      handlers.get("online-users")!(fakeUsers);

      expect(updates).toEqual([fakeUsers]);
    });

    it("rejects on connect_error", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect_error") setTimeout(() => cb(new Error("refused")), 0);
      });

      await expect(client.connect()).rejects.toThrow("Socket.IO connection failed: refused");
    });

    it("disconnect() cleans up the socket", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect();
      client.disconnect();

      expect(mockSocketDisconnect).toHaveBeenCalled();
      expect(client.isConnected).toBe(false);
    });

    it("sendSocketMessage emits chat-message on connected socket", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      client.sendSocketMessage("Hi!", "general", 42);

      expect(mockSocketEmit).toHaveBeenCalledWith("chat-message", {
        content: "Hi!",
        room: "general",
        replyToId: 42,
      });
    });

    it("sendSocketMessage throws when socket not connected", () => {
      const client = makeClient();
      expect(() => client.sendSocketMessage("test")).toThrow("Socket not connected");
    });

    it("sendChatMessage uses socket when connected (dual-mode)", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      const result = await client.sendChatMessage("via socket", "general");

      // Should emit on socket, not HTTP
      expect(mockSocketEmit).toHaveBeenCalledWith("chat-message", {
        content: "via socket",
        room: "general",
      });
      expect(result.content).toBe("via socket");
      // No additional fetch calls beyond the login flow (3 calls)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("sendChatMessage falls back to HTTP when socket not connected", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 1, content: "via http", room: "general" }, 201);

      const result = await client.sendChatMessage("via http", "general");

      expect(result.content).toBe("via http");
      // Should use HTTP (4 calls: login + request)
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("connect() is idempotent when already connected", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      // Second connect should return immediately without creating a new socket
      await client.connect();

      // io() should only be called once
      expect(mockIo).toHaveBeenCalledTimes(1);
    });

    it("disconnect() is safe to call when not connected", () => {
      const client = makeClient();
      // Should not throw
      client.disconnect();
      expect(client.isConnected).toBe(false);
    });

    it("disconnect() is safe to call multiple times", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect();
      client.disconnect();
      client.disconnect(); // second call should not throw

      expect(mockSocketDisconnect).toHaveBeenCalledTimes(1);
    });

    it("routes chat-error events to onError callback", async () => {
      const client = makeClient();
      mockLoginForSocket();

      const errors: unknown[] = [];
      const handlers = new Map<string, Function>();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        handlers.set(event, cb);
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect({ onError: (err) => errors.push(err) });

      handlers.get("chat-error")!({ message: "Rate limited" });
      expect(errors).toEqual([{ message: "Rate limited" }]);
    });

    it("routes chat-delete events to onDelete callback", async () => {
      const client = makeClient();
      mockLoginForSocket();

      const deletes: unknown[] = [];
      const handlers = new Map<string, Function>();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        handlers.set(event, cb);
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect({ onDelete: (data) => deletes.push(data) });

      handlers.get("chat-delete")!({ id: 42 });
      expect(deletes).toEqual([{ id: 42 }]);
    });

    it("routes typing events to onTyping callback", async () => {
      const client = makeClient();
      mockLoginForSocket();

      const typings: unknown[] = [];
      const handlers = new Map<string, Function>();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        handlers.set(event, cb);
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect({ onTyping: (data) => typings.push(data) });

      handlers.get("typing")!({ userId: "u1", username: "chad" });
      expect(typings).toEqual([{ userId: "u1", username: "chad" }]);
    });

    it("routes disconnect events to onDisconnect callback", async () => {
      const client = makeClient();
      mockLoginForSocket();

      const reasons: string[] = [];
      const handlers = new Map<string, Function>();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        handlers.set(event, cb);
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect({ onDisconnect: (reason) => reasons.push(reason) });

      handlers.get("disconnect")!("io server disconnect");
      expect(reasons).toEqual(["io server disconnect"]);
    });

    it("sendSocketMessage omits replyToId when not provided", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      client.sendSocketMessage("Hello!", "general");

      expect(mockSocketEmit).toHaveBeenCalledWith("chat-message", {
        content: "Hello!",
        room: "general",
      });
    });

    it("sendSocketMessage defaults room to 'general'", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      client.sendSocketMessage("Hello!");

      expect(mockSocketEmit).toHaveBeenCalledWith("chat-message", {
        content: "Hello!",
        room: "general",
      });
    });

    it("sendChatMessage via socket returns correct ChatMessage shape", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      const result = await client.sendChatMessage("test msg", "tech", 99);

      expect(result.content).toBe("test msg");
      expect(result.room).toBe("tech");
      expect(result.replyToId).toBe(99);
      expect(result.user.name).toBe("TestAgent");
      expect(result.user.username).toBe("testagent");
      expect(result.user.isBot).toBe(true);
      expect(result.createdAt).toBeTruthy();
    });

    it("sendChatMessage via socket with no replyToId sets null", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      const result = await client.sendChatMessage("test");

      expect(result.replyToId).toBeNull();
      expect(result.room).toBe("general");
    });
  });

  // ── getOnlineUsers ──

  describe("getOnlineUsers", () => {
    it("deduplicates users from recent messages", async () => {
      const client = makeClient();
      const messages = [
        { id: 1, content: "hi", room: "general", userId: "u1", user: { name: "Alice", username: "alice", isBot: false }, replyToId: null, createdAt: "", replyTo: null },
        { id: 2, content: "hello", room: "general", userId: "u2", user: { name: "Bob", username: "bob", isBot: true }, replyToId: null, createdAt: "", replyTo: null },
        { id: 3, content: "again", room: "general", userId: "u1", user: { name: "Alice", username: "alice", isBot: false }, replyToId: null, createdAt: "", replyTo: null },
      ];
      mockLoginThenRequest(messages);

      const users = await client.getOnlineUsers();

      expect(users).toHaveLength(2);
      expect(users[0].name).toBe("Alice");
      expect(users[0].username).toBe("alice");
      expect(users[1].name).toBe("Bob");
      expect(users[1].isBot).toBe(true);
    });

    it("returns empty array when no messages", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      const users = await client.getOnlineUsers();
      expect(users).toEqual([]);
    });

    it("passes room parameter to getChatMessages", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      await client.getOnlineUsers("tech");

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("room=tech");
    });
  });

  // ── Remaining API methods ──

  describe("comments", () => {
    it("getComments fetches by articleId", async () => {
      const client = makeClient();
      mockLoginThenRequest([{ id: 1, content: "nice" }]);

      await client.getComments(42);

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("/api/comments?articleId=42");
    });

    it("postComment without parentId omits it from body", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 1, content: "Top comment", articleId: 10 }, 201);

      await client.postComment(10, "Top comment");

      const body = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(body).toEqual({ articleId: 10, content: "Top comment" });
      expect(body.parentId).toBeUndefined();
    });
  });

  describe("ratings", () => {
    it("getRatings fetches by articleId", async () => {
      const client = makeClient();
      mockLoginThenRequest({ average: 4.2, count: 50, userRating: null, userReview: null, distribution: {} });

      const result = await client.getRatings(42);

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("/api/ratings?articleId=42");
      expect(result.average).toBe(4.2);
    });
  });

  describe("agents / debates", () => {
    it("getAgentProfile encodes username", async () => {
      const client = makeClient();
      mockLoginThenRequest({ agent: { id: "a1", name: "Test" }, stats: {} });

      await client.getAgentProfile("tech hound");

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("/api/agents/tech%20hound");
    });

    it("getTrendingDebates calls correct endpoint", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      await client.getTrendingDebates();

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("/api/trending-debates");
    });

    it("getArticleOfHour calls correct endpoint", async () => {
      const client = makeClient();
      mockLoginThenRequest(null);

      await client.getArticleOfHour();

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("/api/article-of-hour");
    });
  });

  // ── Constructor / config ──

  describe("constructor", () => {
    it("strips trailing slash from baseUrl", async () => {
      const client = makeClient({ baseUrl: "https://example.com/newsv2/" });
      mockLoginThenRequest([]);

      await client.getChatMessages();

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("https://example.com/newsv2/api/chat");
      expect(url).not.toContain("newsv2//api");
    });

    it("defaults name to email prefix when not provided", async () => {
      const client = new NoFOMOClient({
        baseUrl: "https://example.com/newsv2",
        email: "agent007@nofomo.dev",
        password: "pass",
      });
      // Register to see the name
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t1" }, "c=t1"))
        .mockResolvedValueOnce(cookieResponse({}, "", 401))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 201))
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t2" }, "c=t2"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s2", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockResolvedValueOnce(jsonResponse([]));

      await client.getChatMessages();

      const registerCall = mockFetch.mock.calls[3];
      const body = JSON.parse(registerCall[1].body);
      expect(body.name).toBe("agent007");
    });
  });

  // ── Chat edge cases ──

  describe("chat edge cases", () => {
    it("sendChatMessage via HTTP without optional params", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 1, content: "hello", room: "general" }, 201);

      await client.sendChatMessage("hello");

      const body = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(body).toEqual({ content: "hello" });
      expect(body.room).toBeUndefined();
      expect(body.replyToId).toBeUndefined();
    });

    it("getChatMessages without params sends no query string", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      await client.getChatMessages();

      const url = mockFetch.mock.calls[3][0];
      expect(url).toBe("https://ad-lux.com/newsv2/api/chat");
      expect(url).not.toContain("?");
    });

    it("getArticles without params sends no query string", async () => {
      const client = makeClient();
      mockLoginThenRequest({ articles: [], total: 0, page: 1, totalPages: 0, hasMore: false });

      await client.getArticles();

      const url = mockFetch.mock.calls[3][0];
      expect(url).toBe("https://ad-lux.com/newsv2/api/articles");
    });
  });

  // ── Auth edge cases ──

  describe("auth edge cases", () => {
    it("throws when login and registration both fail", async () => {
      const client = makeClient();
      mockFetch
        // 1st login: csrf
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        // 1st login: credentials → fail
        .mockResolvedValueOnce(cookieResponse({}, "", 200))
        // 1st login: session → no user
        .mockResolvedValueOnce(jsonResponse({}))
        // Register → fail
        .mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500))
        // 2nd login: csrf
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok2" }, "csrf=tok2"))
        // 2nd login: credentials → fail
        .mockResolvedValueOnce(cookieResponse({}, "", 200))
        // 2nd login: session → still no user
        .mockResolvedValueOnce(jsonResponse({}));

      await expect(client.getChatMessages()).rejects.toThrow("Login failed");
    });

    it("does not re-register after first registration attempt", async () => {
      const client = makeClient();

      // 1st request: login fails → register → login succeeds
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t1" }, "c=t1"))
        .mockResolvedValueOnce(cookieResponse({}, "", 200))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 201)) // register
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t2" }, "c=t2"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s2", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockResolvedValueOnce(jsonResponse([])); // actual request

      await client.getChatMessages();
      const firstCallCount = mockFetch.mock.calls.length;

      // 2nd request: session expires → 401 → re-login (should NOT register again)
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "Auth required" }, 401)) // actual request fails
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t3" }, "c=t3"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s3", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockResolvedValueOnce(jsonResponse([])); // retry

      await client.getChatMessages();

      // Verify no register call in the second round
      const laterCalls = mockFetch.mock.calls.slice(firstCallCount);
      const registerCalls = laterCalls.filter((call: any[]) => call[0]?.includes("/api/auth/register"));
      expect(registerCalls.length).toBe(0);
    });

    it("register sends isBot:true and optional username/image", async () => {
      const client = new NoFOMOClient({
        baseUrl: "https://ad-lux.com/newsv2",
        email: "bot@test.com",
        password: "pass123",
        name: "MyBot",
        username: "mybot",
        image: "https://example.com/avatar.png",
      });

      mockFetch
        // 1st login: csrf
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t" }, "c=t"))
        // 1st login: credentials → fail (no user)
        .mockResolvedValueOnce(cookieResponse({}, "", 200))
        .mockResolvedValueOnce(jsonResponse({}))
        // Register
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 201))
        // 2nd login
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t2" }, "c=t2"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockResolvedValueOnce(jsonResponse([]));

      await client.getChatMessages();

      const registerBody = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(registerBody.isBot).toBe(true);
      expect(registerBody.username).toBe("mybot");
      expect(registerBody.image).toBe("https://example.com/avatar.png");
      expect(registerBody.name).toBe("MyBot");
    });
  });

  // ── Socket.IO Timeout & Reconnect ──

  describe("socket.io timeout and reconnect", () => {
    function mockLoginForSocket() {
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "next-auth.session-token=sess1", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1", name: "TestAgent" } }));
    }

    it("can reconnect after disconnect()", async () => {
      const client = makeClient();

      // First connection
      mockLoginForSocket();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      expect(client.isConnected).toBe(true);

      client.disconnect();
      expect(client.isConnected).toBe(false);

      // Second connection — should work (socket was nulled)
      vi.mocked(mockIo).mockClear();
      mockSocketOn.mockReset();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      // No re-login needed — session cookie still valid
      await client.connect({ room: "tech" });

      expect(mockIo).toHaveBeenCalledTimes(1);
      expect(mockSocketEmit).toHaveBeenCalledWith("join-room", "tech");
    });

    it("connect() authenticates if no session exists", async () => {
      const client = makeClient();
      mockLoginForSocket();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect();

      // Should have called login (3 fetch calls)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  // ── Cookie Handling ──

  describe("cookie merging", () => {
    it("mergeCookies deduplicates by key (incoming overrides existing)", async () => {
      const client = makeClient();
      mockFetch
        // csrf
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=old_value; next-auth.session-token=old_sess"))
        // login — returns new session, overwrites old
        .mockResolvedValueOnce((() => {
          const res = new Response(JSON.stringify({ url: "/" }), { status: 200 });
          res.headers.getSetCookie = () => ["next-auth.session-token=new_sess"];
          return res;
        })())
        // session verify
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        // actual request
        .mockResolvedValueOnce(jsonResponse([]));

      await client.getChatMessages();

      // Cookie sent to API should have the NEW session token
      const apiCall = mockFetch.mock.calls[3];
      const cookie = apiCall[1].headers.Cookie;
      expect(cookie).toContain("next-auth.session-token=new_sess");
      expect(cookie).not.toContain("old_sess");
    });
  });

  // ── Request Content-Type ──

  describe("request headers", () => {
    it("sets Content-Type: application/json when body is a string", async () => {
      const client = makeClient();
      mockLoginThenRequest({ id: 1, content: "hi" }, 201);

      await client.postComment(10, "hi");

      const opts = mockFetch.mock.calls[3][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("does not set Content-Type on GET requests without body", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      await client.getChatMessages();

      const opts = mockFetch.mock.calls[3][1];
      expect(opts.headers["Content-Type"]).toBeUndefined();
    });
  });

  // ── Security Boundaries ──

  describe("security boundaries", () => {
    it("encodes special characters in agent profile username", async () => {
      const client = makeClient();
      mockLoginThenRequest({ agent: { id: "a1" }, stats: {} });

      // Username with special chars that could be path traversal
      await client.getAgentProfile("../admin");

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("/api/agents/..%2Fadmin");
      expect(url).not.toContain("/../");
    });

    it("encodes unicode in agent profile username", async () => {
      const client = makeClient();
      mockLoginThenRequest({ agent: { id: "a1" }, stats: {} });

      await client.getAgentProfile("tëst_üser");

      const url = mockFetch.mock.calls[3][0];
      // Should be URL-encoded, not raw unicode in path
      expect(url).toContain("/api/agents/");
      expect(url).toContain("t%C3%ABst_%C3%BCser");
    });

    it("passes long content through without client-side truncation", async () => {
      const client = makeClient();
      const longContent = "A".repeat(1000);
      mockLoginThenRequest({ id: 1, content: longContent }, 201);

      await client.sendChatMessage(longContent);

      const body = JSON.parse(mockFetch.mock.calls[3][1].body);
      // Client doesn't truncate — that's the server's job (max 500 chars enforced server-side)
      expect(body.content).toBe(longContent);
    });

    it("does not leak session cookie in error messages", async () => {
      const client = makeClient();
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "session=SECRETTOKEN123", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockResolvedValueOnce(jsonResponse({ error: "Forbidden" }, 403));

      try {
        await client.getArticles();
      } catch (e: any) {
        expect(e.message).not.toContain("SECRETTOKEN123");
      }
    });

    it("handles null/undefined room safely in getChatMessages", async () => {
      const client = makeClient();
      mockLoginThenRequest([]);

      await client.getChatMessages({ room: undefined, limit: undefined });

      const url = mockFetch.mock.calls[3][0];
      expect(url).toBe("https://ad-lux.com/newsv2/api/chat");
    });
  });

  // ── Error Handling Edge Cases ──

  describe("error handling edge cases", () => {
    it("includes HTTP status in error message", async () => {
      const client = makeClient();
      mockLoginThenRequest({ error: "Rate limited" }, 429);

      await expect(client.sendChatMessage("spam")).rejects.toThrow("429");
    });

    it("handles server returning non-JSON on error gracefully", async () => {
      const client = makeClient();
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t" }, "c=t"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        // Server returns HTML error page
        .mockResolvedValueOnce(new Response("<html>500 Internal Server Error</html>", { status: 500 }));

      await expect(client.getArticles()).rejects.toThrow("HTTP 500");
    });

    it("handles network fetch failures", async () => {
      const client = makeClient();
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t" }, "c=t"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

      await expect(client.getArticles()).rejects.toThrow("ECONNREFUSED");
    });

    it("handles CSRF endpoint failure", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response("", { status: 500 }));

      await expect(client.getChatMessages()).rejects.toThrow();
    });
  });

  // ── getArticles edge cases ──

  describe("getArticles edge cases", () => {
    it("passes time filter parameter", async () => {
      const client = makeClient();
      mockLoginThenRequest({ articles: [], total: 0, page: 1, totalPages: 0, hasMore: false });

      await client.getArticles({ time: "24h" });

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("time=24h");
    });

    it("does not send limit=0 (falsy but valid)", async () => {
      const client = makeClient();
      mockLoginThenRequest({ articles: [], total: 0, page: 1, totalPages: 0, hasMore: false });

      // limit=0 is falsy, so the client skips it (by design)
      await client.getArticles({ limit: 0 });

      const url = mockFetch.mock.calls[3][0];
      expect(url).not.toContain("limit=");
    });

    it("handles multiple params combined", async () => {
      const client = makeClient();
      mockLoginThenRequest({ articles: [], total: 0, page: 1, totalPages: 0, hasMore: false });

      await client.getArticles({ category: "science", sort: "discussed", time: "7d", limit: 3, page: 2 });

      const url = mockFetch.mock.calls[3][0];
      expect(url).toContain("category=science");
      expect(url).toContain("sort=discussed");
      expect(url).toContain("time=7d");
      expect(url).toContain("limit=3");
      expect(url).toContain("page=2");
    });
  });

  // ── Socket.IO event edge cases ──

  describe("socket.io event edge cases", () => {
    function mockLoginForSocket() {
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "next-auth.session-token=sess1", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1", name: "TestAgent" } }));
    }

    it("does not crash when callbacks are not provided", async () => {
      const client = makeClient();
      mockLoginForSocket();

      const handlers = new Map<string, Function>();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        handlers.set(event, cb);
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      // Connect with NO callbacks at all
      await client.connect({});

      // Fire all events — none should throw
      handlers.get("chat-message")?.({ id: 1, content: "hi" });
      handlers.get("online-users")?.([]);
      handlers.get("chat-error")?.({ message: "err" });
      handlers.get("chat-delete")?.({ id: 1 });
      handlers.get("typing")?.({ userId: "u1", username: "test" });
      handlers.get("disconnect")?.("transport close");
      // No assertions needed — just verifying no exceptions
    });

    it("connect_error rejects the connect promise", async () => {
      const client = makeClient();
      mockLoginForSocket();

      // Use the proven pattern: fire connect_error via setTimeout
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect_error") setTimeout(() => cb(new Error("connection refused")), 0);
      });

      await expect(client.connect()).rejects.toThrow("Socket.IO connection failed: connection refused");
    });

    it("sendSocketMessage with empty content still emits", async () => {
      const client = makeClient();
      mockLoginForSocket();

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      // Empty string is technically valid — server validates
      client.sendSocketMessage("", "general");

      expect(mockSocketEmit).toHaveBeenCalledWith("chat-message", {
        content: "",
        room: "general",
      });
    });
  });

  // ── getOnlineUsers edge cases ──

  describe("getOnlineUsers edge cases", () => {
    it("handles messages with missing user fields gracefully", async () => {
      const client = makeClient();
      const messages = [
        { id: 1, content: "hi", room: "general", userId: "u1", user: { name: "Alice", username: null, isBot: false }, replyToId: null, createdAt: "", replyTo: null },
      ];
      mockLoginThenRequest(messages);

      const users = await client.getOnlineUsers();
      expect(users).toHaveLength(1);
      expect(users[0].username).toBeNull();
    });

    it("preserves first-seen user when duplicate userIds appear", async () => {
      const client = makeClient();
      const messages = [
        { id: 1, content: "first", room: "general", userId: "u1", user: { name: "Alice v1", username: "alice", isBot: false }, replyToId: null, createdAt: "", replyTo: null },
        { id: 2, content: "second", room: "general", userId: "u1", user: { name: "Alice v2", username: "alice_new", isBot: false }, replyToId: null, createdAt: "", replyTo: null },
      ];
      mockLoginThenRequest(messages);

      const users = await client.getOnlineUsers();
      expect(users).toHaveLength(1);
      // First occurrence wins
      expect(users[0].name).toBe("Alice v1");
    });
  });

  // ── Dual-mode sendChatMessage edge cases ──

  describe("dual-mode sendChatMessage", () => {
    function mockLoginForSocket() {
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "tok1" }, "csrf=tok1"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "next-auth.session-token=sess1", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1", name: "TestAgent" } }));
    }

    it("via socket: user.image reflects client config", async () => {
      const client = new NoFOMOClient({
        baseUrl: "https://ad-lux.com/newsv2",
        email: "test@nofomo.dev",
        password: "TestPass123!",
        name: "TestAgent",
        username: "testagent",
        image: "https://example.com/avatar.png",
      });

      mockLoginForSocket();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      const result = await client.sendChatMessage("hello");

      expect(result.user.image).toBe("https://example.com/avatar.png");
    });

    it("via socket: user.image is null when not configured", async () => {
      const client = makeClient();
      mockLoginForSocket();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      const result = await client.sendChatMessage("hello");

      expect(result.user.image).toBeNull();
    });

    it("via socket: returns id=0 (placeholder) and valid ISO timestamp", async () => {
      const client = makeClient();
      mockLoginForSocket();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();
      const before = new Date().toISOString();
      const result = await client.sendChatMessage("test");
      const after = new Date().toISOString();

      expect(result.id).toBe(0);
      expect(result.createdAt >= before).toBe(true);
      expect(result.createdAt <= after).toBe(true);
    });

    it("HTTP fallback after socket disconnects mid-session", async () => {
      const client = makeClient();
      mockLoginForSocket();
      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });
      mockSocketConnected = true;

      await client.connect();

      // Socket disconnects unexpectedly
      mockSocketConnected = false;
      client.disconnect();

      // Now sendChatMessage should fall back to HTTP
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 99, content: "via http", room: "general" }, 201));

      const result = await client.sendChatMessage("via http");
      expect(result.id).toBe(99);
      expect(result.content).toBe("via http");
    });
  });

  // ── Rate limiting resilience ──

  describe("rate limiting", () => {
    it("surfaces 429 errors clearly", async () => {
      const client = makeClient();
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t" }, "c=t"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));

      try {
        await client.sendChatMessage("spam");
        expect(true).toBe(false); // should not reach
      } catch (e: any) {
        expect(e.message).toContain("429");
      }
    });

    it("does not retry on 429 (no infinite loop)", async () => {
      const client = makeClient();
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t" }, "c=t"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=s", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1" } }))
        .mockResolvedValueOnce(new Response("Rate limited", { status: 429 }));

      await expect(client.sendChatMessage("test")).rejects.toThrow();
      // Only 4 calls — no retry loop
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  // ── Constructor validation ──

  describe("constructor edge cases", () => {
    it("handles baseUrl with multiple path segments", async () => {
      const client = makeClient({ baseUrl: "https://cdn.example.com/app/v2/newsv2" });
      mockLoginThenRequest([]);

      await client.getChatMessages();

      const url = mockFetch.mock.calls[3][0];
      expect(url).toBe("https://cdn.example.com/app/v2/newsv2/api/chat");
    });

    it("derives correct socket.io path from deep baseUrl", async () => {
      const client = makeClient({ baseUrl: "https://example.com/app/newsv2" });
      mockFetch
        .mockResolvedValueOnce(cookieResponse({ csrfToken: "t" }, "c=t"))
        .mockResolvedValueOnce(cookieResponse({ url: "/" }, "s=sess", 200))
        .mockResolvedValueOnce(jsonResponse({ user: { id: "u1", name: "Test" } }));

      mockSocketOn.mockImplementation((event: string, cb: Function) => {
        if (event === "connect") setTimeout(() => cb(), 0);
      });

      await client.connect();

      expect(mockIo).toHaveBeenCalledWith("https://example.com", {
        path: "/app/newsv2/socket.io",
        transports: ["websocket", "polling"],
        extraHeaders: expect.any(Object),
      });
    });
  });
});
