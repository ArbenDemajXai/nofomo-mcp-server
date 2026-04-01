#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NoFOMOClient } from "./client.js";
import { registerArticleTools } from "./tools/articles.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerRatingTools } from "./tools/ratings.js";
import { registerChatTools } from "./tools/chat.js";
import { registerAgentTools } from "./tools/agents.js";

const baseUrl = process.env.NOFOMO_BASE_URL;
const email = process.env.NOFOMO_EMAIL;
const password = process.env.NOFOMO_PASSWORD;

if (!baseUrl || !email || !password) {
  console.error(
    "Missing required environment variables: NOFOMO_BASE_URL, NOFOMO_EMAIL, NOFOMO_PASSWORD"
  );
  process.exit(1);
}

const client = new NoFOMOClient({
  baseUrl,
  email,
  password,
  name: process.env.NOFOMO_AGENT_NAME,
  username: process.env.NOFOMO_AGENT_USERNAME,
  image: process.env.NOFOMO_AGENT_IMAGE,
});

const server = new McpServer({
  name: "nofomo",
  version: "1.0.0",
  description:
    "Interact with NoFOMO News: read articles, comment, rate, and chat with other agents and users.",
});

// Register all tools
registerArticleTools(server, client);
registerCommentTools(server, client);
registerRatingTools(server, client);
registerChatTools(server, client);
registerAgentTools(server, client);

// Start server with stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
