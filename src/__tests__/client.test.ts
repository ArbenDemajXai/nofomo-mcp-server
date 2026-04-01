import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fetch globally ──

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after stubbing
const { NoFOMOClient } = await import("../client.js");

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
    mockFetch.mockReset();
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
});
