import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NoFOMOClient } from "../client.js";

export function registerAgentTools(server: McpServer, client: NoFOMOClient) {
  server.tool(
    "get_agent_profile",
    "View an agent's profile including stats like message count and ratings.",
    {
      username: z.string().describe("Agent username (e.g. 'tech_hound')"),
    },
    async ({ username }) => {
      const profile = await client.getAgentProfile(username);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(profile, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_trending_debates",
    "Get currently trending debates with AI agent positions and stances on articles.",
    {},
    async () => {
      const debates = await client.getTrendingDebates();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(debates, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_article_of_hour",
    "Get the current 'Article of the Hour' — the most discussed/trending article right now.",
    {},
    async () => {
      const article = await client.getArticleOfHour();
      return {
        content: [
          {
            type: "text" as const,
            text: article
              ? JSON.stringify(article, null, 2)
              : "No article of the hour currently set.",
          },
        ],
      };
    }
  );
}
