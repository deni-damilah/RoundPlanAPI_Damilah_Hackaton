const express = require("express");
require("dotenv").config();
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");

const app = express();

app.use(express.json());

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

function getModelCandidates(primaryModel) {
  const fallbackModels = (process.env.ANTHROPIC_FALLBACK_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set([primaryModel, ...fallbackModels])];
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "RoundPlan API",
      version: "1.0.0",
      description: "API server with Claude-backed /ask endpoint"
    },
    servers: [
      {
        url: "http://localhost:3000"
      }
    ],
    components: {
      schemas: {
        AskRequest: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: {
              type: "string",
              example: "Explain REST APIs in 3 bullet points."
            }
          }
        },
        AskSuccessResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: true },
            model: { type: "string", example: "claude-3-5-sonnet-latest" },
            response: { type: "string", example: "1) ... 2) ... 3) ..." }
          }
        },
        ErrorResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: false },
            error: { type: "string", example: "Invalid request body." },
            details: { type: "string", example: "Additional error details." }
          }
        }
      }
    }
  },
  apis: [__filename]
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get("/", (req, res) => {
  res.json({ ok: true, message: "RoundPlan API running" });
});

// Health endpoint for monitoring
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", uptime: process.uptime() });
});

/**
 * @swagger
 * /anthropic/models:
 *   get:
 *     summary: List Anthropic models available to the configured API key
 *     tags:
 *       - AI
 *     responses:
 *       200:
 *         description: Available models
 *       500:
 *         description: Missing API key
 *       502:
 *         description: Upstream Anthropic error
 */
app.get("/anthropic/models", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "Missing ANTHROPIC_API_KEY environment variable."
    });
  }

  try {
    const response = await fetch(`${ANTHROPIC_API_URL}/models`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      }
    });

    const data = await parseJsonSafe(response);

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "Failed to list Anthropic models.",
        details: data?.error?.message || "Unknown upstream error.",
        status: response.status
      });
    }

    const models = Array.isArray(data?.data)
      ? data.data.map((model) => ({
          id: model?.id,
          display_name: model?.display_name
        }))
      : [];

    return res.status(200).json({
      ok: true,
      count: models.length,
      models
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Unexpected server error while listing Anthropic models.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * @swagger
 * /ask:
 *   post:
 *     summary: Send a prompt to Claude and get a generated response
 *     tags:
 *       - AI
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: "#/components/schemas/AskRequest"
 *           examples:
 *             basicPrompt:
 *               summary: Simple prompt
 *               value:
 *                 prompt: "Write a short welcome message for a project README."
 *     responses:
 *       200:
 *         description: Model response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/AskSuccessResponse"
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/ErrorResponse"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/ErrorResponse"
 *       502:
 *         description: Upstream Anthropic error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/ErrorResponse"
 */
app.post("/ask", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  const prompt = req.body?.prompt;
  const modelCandidates = getModelCandidates(model);

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "Missing ANTHROPIC_API_KEY environment variable."
    });
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({
      ok: false,
      error: "Invalid request body. Expected JSON with a non-empty 'prompt' string."
    });
  }

  try {
    const attemptErrors = [];

    for (const candidateModel of modelCandidates) {
      const anthropicResponse = await fetch(`${ANTHROPIC_API_URL}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: candidateModel,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt.trim() }]
        })
      });

      const data = await parseJsonSafe(anthropicResponse);

      if (anthropicResponse.ok) {
        const textResponse = Array.isArray(data?.content)
          ? data.content
              .filter((item) => item?.type === "text")
              .map((item) => item.text)
              .join("\n")
          : "";

        return res.status(200).json({
          ok: true,
          model: data?.model || candidateModel,
          response: textResponse
        });
      }

      const message = data?.error?.message || "Unknown upstream error.";
      const type = data?.error?.type || "unknown_error";
      attemptErrors.push({
        model: candidateModel,
        status: anthropicResponse.status,
        type,
        message
      });

      const probablyModelError = /model/i.test(type) || /model/i.test(message);
      if (!probablyModelError) {
        break;
      }
    }

    const lastError = attemptErrors[attemptErrors.length - 1];
    return res.status(502).json({
      ok: false,
      error: "Anthropic API request failed.",
      details: lastError?.message || "Unknown upstream error.",
      attempted_models: attemptErrors
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Unexpected server error while calling Anthropic.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Swagger docs available at http://localhost:${PORT}/docs`);
});

// Uncomment to test crash + automatic restart behavior:
// setInterval(() => {
//   throw new Error("Crash test");
// }, 15000);
