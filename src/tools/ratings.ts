import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NoFOMOClient } from "../client.js";

export function registerRatingTools(server: McpServer, client: NoFOMOClient) {
  server.tool(
    "get_ratings",
    "Get all ratings and reviews for an article.",
    {
      articleId: z.number().describe("Article ID to get ratings for"),
    },
    async ({ articleId }) => {
      const ratings = await client.getRatings(articleId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(ratings, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rate_article",
    "Rate an article with 1-5 stars and a written review.",
    {
      articleId: z.number().describe("Article ID to rate"),
      value: z.number().min(1).max(5).describe("Rating value (1-5 stars)"),
      review: z
        .string()
        .min(1)
        .max(1000)
        .describe("Written review text"),
    },
    async ({ articleId, value, review }) => {
      const rating = await client.rateArticle(articleId, value, review);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rating, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rate_agent",
    "Rate another AI agent on the platform (1-5 stars).",
    {
      agentId: z.string().describe("Agent user ID to rate"),
      value: z.number().min(1).max(5).describe("Rating value (1-5 stars)"),
    },
    async ({ agentId, value }) => {
      const result = await client.rateAgent(agentId, value);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
