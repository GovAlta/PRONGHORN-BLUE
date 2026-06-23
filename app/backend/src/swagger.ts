/**
 * OpenAPI/Swagger Configuration
 * Generates API documentation for APIM integration
 */
import swaggerJsdoc from "swagger-jsdoc";
import { OpenAPIV3 } from "openapi-types";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Pronghorn API",
      version: "1.0.0",
      description: "Pronghorn API - Azure Container Apps backend for project management, AI chat, and collaboration",
      contact: {
        name: "Pronghorn Team",
        email: "admin@pronghorn.dev",
      },
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    servers: [
      {
        url: "/api/v1",
        description: "API v1",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT Authorization header using the Bearer scheme",
        },
        apimSubscriptionKey: {
          type: "apiKey",
          in: "header",
          name: "Ocp-Apim-Subscription-Key",
          description: "Azure API Management subscription key",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            message: { type: "string" },
            code: { type: "string" },
            details: { type: "object" },
          },
          required: ["error", "message"],
        },
        Project: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            description: { type: "string" },
            visibility: { type: "string", enum: ["private", "public", "shared"] },
            user_id: { type: "string", format: "uuid" },
            settings: { type: "object" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        Artifact: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            project_id: { type: "string", format: "uuid" },
            name: { type: "string" },
            type: { type: "string" },
            content: { type: "string" },
            metadata: { type: "object" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        CanvasNode: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            project_id: { type: "string", format: "uuid" },
            type: { type: "string" },
            position: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
              },
            },
            data: { type: "object" },
            layer_id: { type: "string", format: "uuid" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        ChatMessage: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["user", "assistant", "system"] },
            content: { type: "string" },
          },
        },
        AuthCredentials: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
            name: { type: "string" },
          },
        },
        AuthResponse: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                email: { type: "string", format: "email" },
                name: { type: "string" },
                role: { type: "string" },
              },
            },
            token: { type: "string" },
          },
        },
        HealthCheck: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
            timestamp: { type: "string", format: "date-time" },
            service: { type: "string" },
            version: { type: "string" },
          },
        },
      },
      responses: {
        BadRequest: {
          description: "Bad Request",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        Unauthorized: {
          description: "Unauthorized - Invalid or missing authentication",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        Forbidden: {
          description: "Forbidden - Insufficient permissions",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        NotFound: {
          description: "Resource not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        InternalError: {
          description: "Internal server error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Health", description: "Health check endpoints" },
      { name: "Auth", description: "Authentication endpoints" },
      { name: "Projects", description: "Project management" },
      { name: "Artifacts", description: "Project artifacts (documents, files)" },
      { name: "Canvas", description: "Visual canvas nodes and edges" },
      { name: "Chat", description: "AI chat streaming" },
      { name: "Database", description: "Database schema management" },
      { name: "Deployment", description: "Deployment management" },
      { name: "Audit", description: "Project auditing" },
      { name: "Collaboration", description: "Real-time collaboration" },
      { name: "RPC", description: "PostgreSQL function calls" },
      { name: "Functions", description: "Edge Function replacements" },
    ],
  },
  apis: ["./src/routes/*.ts", "./dist/routes/*.js"],
};

export const swaggerSpec = swaggerJsdoc(options) as OpenAPIV3.Document;

/**
 * Export OpenAPI spec as JSON for APIM import
 */
export function getOpenApiSpec(): OpenAPIV3.Document {
  return swaggerSpec;
}
