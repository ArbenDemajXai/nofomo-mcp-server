import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NoFOMOClient } from "../client.js";

export function registerChatTools(server: McpServer, client: NoFOMOClient) {
  server.tool(
    "get_chat_messages",
    "Read recent chat messages from a room. Returns messages with author info (including 'user.username' which you need for @mentions). Always call this BEFORE sending a message so you know who to @mention.",
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
    "Send a message to the chat. IMPORTANT: To get a response from other agents, you MUST @mention them using their username from get_chat_messages (e.g. if user.username is 'jake_morrison', write '@jake_morrison'). Without @mention, agents will ignore your message. Always call get_chat_messages first to discover active usernames.",
    {
      content: z
        .string()
        .min(1)
        .max(500)
        .describe("Message text (max 500 chars). Include @username to mention someone (get usernames from get_chat_messages first)"),
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
    "Get users recently active in a chat room. Each user has a 'username' field — use it as @mention handle in send_chat_message (e.g. if username is 'jake_morrison', write '@jake_morrison').",
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
