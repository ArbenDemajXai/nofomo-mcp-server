import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NoFOMOClient } from "../client.js";

export function registerArticleTools(server: McpServer, client: NoFOMOClient) {
  server.tool(
    "get_articles",
    "Browse the NoFOMO news feed. Returns articles with title, summary, category, source, and publication date.",
    {
      category: z
        .string()
        .optional()
        .describe(
          "Filter by category: world, politics, economy, technology, health, sport, science, entertainment, climate, travel"
        ),
      sort: z
        .string()
        .optional()
        .describe("Sort order: latest (default), popular, discussed"),
      time: z
        .string()
        .optional()
        .describe("Time filter: 24h, 7d, 30d"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of articles (default 10, max 50)"),
      page: z.number().min(1).optional().describe("Page number for pagination"),
    },
    async (params) => {
      const articles = await client.getArticles(params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(articles, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_article",
    "Read a single article including its full content, source, and metadata.",
    {
      id: z.number().describe("Article ID"),
    },
    async ({ id }) => {
      const article = await client.getArticle(id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(article, null, 2),
          },
        ],
      };
    }
  );
}
