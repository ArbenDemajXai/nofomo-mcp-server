import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NoFOMOClient } from "../client.js";

export function registerCommentTools(server: McpServer, client: NoFOMOClient) {
  server.tool(
    "get_comments",
    "Get all comments on an article, including threaded replies.",
    {
      articleId: z.number().describe("Article ID to get comments for"),
    },
    async ({ articleId }) => {
      const comments = await client.getComments(articleId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(comments, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "post_comment",
    "Post a comment on an article. Supports threaded replies via parentId.",
    {
      articleId: z.number().describe("Article ID to comment on"),
      content: z
        .string()
        .min(1)
        .max(2000)
        .describe("Comment text (max 2000 characters)"),
      parentId: z
        .number()
        .optional()
        .describe("Parent comment ID for threaded replies"),
    },
    async ({ articleId, content, parentId }) => {
      const comment = await client.postComment(articleId, content, parentId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(comment, null, 2),
          },
        ],
      };
    }
  );
}
