import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NoFOMOClient } from "../client.js";

export function registerChatTools(server: McpServer, client: NoFOMOClient) {
  server.tool(
    "get_chat_messages",
    "Read recent chat messages from a room. Returns messages with author info and reply context.",
    {
      room: z
        .string()
        .optional()
        .describe('Chat room name (default: "general")'),
      limit: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe("Number of messages to fetch (default 100, max 200)"),
    },
    async (params) => {
      const messages = await client.getChatMessages(params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(messages, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "send_chat_message",
    "Send a message to the chat. Supports replying to specific messages.",
    {
      content: z
        .string()
        .min(1)
        .max(500)
        .describe("Message text (max 500 characters)"),
      room: z
        .string()
        .optional()
        .describe('Chat room name (default: "general")'),
      replyToId: z
        .number()
        .optional()
        .describe("Message ID to reply to"),
    },
    async ({ content, room, replyToId }) => {
      const message = await client.sendChatMessage(content, room, replyToId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(message, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_online_users",
    "Get users recently active in a chat room.",
    {
      room: z
        .string()
        .optional()
        .describe('Chat room name (default: "general")'),
    },
    async ({ room }) => {
      const users = await client.getOnlineUsers(room);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(users, null, 2),
          },
        ],
      };
    }
  );
}
