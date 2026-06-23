/**
 * Authentication Middleware
 * 
 * Supports multiple authentication methods:
 * 1. APIM headers (X-User-Id, X-User-Email) - Used when APIM validates JWT
 * 2. Direct JWT validation - Used for local development
 * 3. Azure AD ID token validation - For direct Azure AD integration
 */
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";
import { logger } from "../utils/logger";
import db from "../utils/database";

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name?: string;
        role?: string;
      };
    }
  }
}

interface JwtPayload {
  sub: string;
  oid?: string; // Azure AD Object ID
  email?: string;
  preferred_username?: string;
  upn?: string; // v1 User Principal Name (often present when email is not)
  unique_name?: string; // v1 unique name fallback
  name?: string;
  role?: string;
}

// Azure AD tenant configuration.
// IMPORTANT: read ENTRA_* (not AZURE_*) because the @azure/identity SDK
// reserves AZURE_CLIENT_ID / AZURE_TENANT_ID for DefaultAzureCredential /
// ManagedIdentityCredential. Setting AZURE_CLIENT_ID in a container that
// only has a system-assigned MI breaks token acquisition with
// "No User Assigned or Delegated Managed Identity found for specified ClientId".
//
// Fail-fast: missing values yield an unusable JWKS URL and a redirect loop,
// so refuse to boot rather than degrade silently.
const TENANT_ID = process.env.ENTRA_TENANT_ID;
const CLIENT_ID = process.env.ENTRA_CLIENT_ID;

if (!TENANT_ID) {
  throw new Error(
    "ENTRA_TENANT_ID is required. Set it in your .env file or in the container environment. " +
    "See app/backend/.env.example for details."
  );
}
if (!CLIENT_ID) {
  throw new Error(
    "ENTRA_CLIENT_ID is required. Set it in your .env file or in the container environment. " +
    "See app/backend/.env.example for details."
  );
}

const AUTH_AUDIENCES: [string, string] = [CLIENT_ID, `api://${CLIENT_ID}`];

// JWKS client for Azure AD token validation
const jwksClient = jwksRsa({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000, // 10 minutes
});

/**
 * Get signing key from Azure AD JWKS endpoint
 */
function getSigningKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

// Per-process cache so we don't re-issue the INSERT on every authenticated
// request once a user has been seeded into auth.users.
const seededAzureUserIds = new Set<string>();

/**
 * Insert an Entra/Azure AD user into auth.users on first sight so foreign
 * keys referencing auth.users(id) resolve for every authenticated entry
 * point — APIM-injected headers, direct Azure AD JWT validation, and the
 * WebSocket handshake. When the row is newly created, also seed a
 * public.user_roles row with role='admin' so the first sign-in
 * self-provisions admin access.
 *
 * `email` is optional: APIM and most JWTs supply one, but access tokens may
 * omit it. We synthesize a deterministic, obviously-not-a-real placeholder
 * tied to the OID when nothing is provided, because auth.users.email is
 * NOT NULL.
 */
export async function seedUserIfMissing(input: { id: string; email?: string; name?: string }): Promise<void> {
  const id = input.id;
  if (!id) return;
  if (seededAzureUserIds.has(id)) return;

  const email = (input.email && input.email.trim()) || `${id}@unknown.local`;
  const normalizedEmail = email.toLowerCase();

  try {
    const inserted = await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [id, normalizedEmail, JSON.stringify({ name: input.name, azure_oid: id })]
    );
    if (inserted.rowCount && inserted.rowCount > 0) {
      await db.query(
        `INSERT INTO public.user_roles (user_id, role, created_at)
         VALUES ($1, 'admin'::public.app_role, NOW())
         ON CONFLICT (user_id, role) DO NOTHING`,
        [id]
      );
    }
    seededAzureUserIds.add(id);
  } catch (err) {
    logger.warn("Failed to seed auth.users from identity", err);
  }
}

/**
 * Wrapper that pulls identity from a validated Azure AD JWT payload and
 * forwards to {@link seedUserIfMissing}.
 */
async function ensureAzureUserSeeded(payload: JwtPayload): Promise<void> {
  const id = payload.oid || payload.sub;
  const email =
    payload.email ||
    payload.preferred_username ||
    payload.upn ||
    payload.unique_name;
  await seedUserIfMissing({ id, email, name: payload.name });
}

/**
 * APIM-aware Authentication Middleware
 * 
 * First checks for APIM headers (set by validate-jwt policy):
 * - X-User-Id: Azure AD OID or sub claim
 * - X-User-Email: User's email
 * - X-User-Name: User's display name
 * 
 * Falls back to direct JWT validation if headers are not present.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    // Check for APIM-injected headers first (fastest path)
    const apimUserId = req.headers["x-user-id"] as string;
    const apimUserEmail = req.headers["x-user-email"] as string;
    const apimUserName = req.headers["x-user-name"] as string;

    if (apimUserId && apimUserEmail) {
      // APIM has already validated the token
      req.user = {
        id: apimUserId,
        email: apimUserEmail,
        name: apimUserName || apimUserEmail.split("@")[0],
      };
      logger.debug(`Authenticated via APIM headers: ${apimUserEmail}`);
      // Seed before next() so downstream handlers can rely on the
      // auth.users row existing (FK targets, role lookups, etc.).
      seedUserIfMissing({
        id: apimUserId,
        email: apimUserEmail,
        name: apimUserName,
      }).finally(() => next());
      return;
    }

    // Fall back to direct JWT validation
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({
        error: "Unauthorized",
        message: "No authorization header provided",
      });
      return;
    }

    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid authorization header format. Use: Bearer <token>",
      });
      return;
    }

    // Try to validate as Azure AD token
    jwt.verify(
      token,
      getSigningKey,
      {
        algorithms: ["RS256"],
        issuer: [`https://login.microsoftonline.com/${TENANT_ID}/v2.0`, `https://sts.windows.net/${TENANT_ID}/`],
        audience: AUTH_AUDIENCES,
      },
      (err, decoded) => {
        if (err) {
          // Fall back to local JWT secret for development
          const jwtSecret = process.env.JWT_SECRET;
          if (jwtSecret) {
            try {
              const localDecoded = jwt.verify(token, jwtSecret) as JwtPayload;
              req.user = {
                id: localDecoded.sub,
                email: localDecoded.email || localDecoded.preferred_username || "",
                name: localDecoded.name,
                role: localDecoded.role,
              };
              logger.debug(`Authenticated via local JWT: ${req.user.email}`);
              next();
              return;
            } catch (localErr) {
              // Both validation methods failed
            }
          }

          logger.warn("JWT validation failed:", err.message);
          res.status(401).json({
            error: "Unauthorized",
            message: "Invalid or expired token",
          });
          return;
        }

        const payload = decoded as JwtPayload;
        req.user = {
          id: payload.oid || payload.sub,
          email: payload.email || payload.preferred_username || "",
          name: payload.name,
        };
        logger.debug(`Authenticated via Azure AD: ${req.user.email}`);
        ensureAzureUserSeeded(payload).finally(() => next());
      }
    );
  } catch (error) {
    logger.error("Authentication error", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Authentication failed",
    });
  }
}

/**
 * Optional auth middleware - attaches user if headers/token present but doesn't require it
 */
export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Check for APIM headers
  const apimUserId = req.headers["x-user-id"] as string;
  const apimUserEmail = req.headers["x-user-email"] as string;
  const apimUserName = req.headers["x-user-name"] as string;

  if (apimUserId && apimUserEmail) {
    req.user = {
      id: apimUserId,
      email: apimUserEmail,
      name: apimUserName || apimUserEmail.split("@")[0],
    };
    seedUserIfMissing({
      id: apimUserId,
      email: apimUserEmail,
      name: apimUserName,
    }).finally(() => next());
    return;
  }

  // Check for Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    next();
    return;
  }

  // For optional-auth routes, invalid/expired tokens must not block the request.
  // Attempt Azure AD validation first, then local JWT, and continue anonymously on failure.
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    req.user = undefined;
    next();
    return;
  }

  jwt.verify(
    token,
    getSigningKey,
    {
      algorithms: ["RS256"],
      issuer: [`https://login.microsoftonline.com/${TENANT_ID}/v2.0`, `https://sts.windows.net/${TENANT_ID}/`],
      audience: AUTH_AUDIENCES,
    },
    (azureErr, azureDecoded) => {
      if (!azureErr && azureDecoded) {
        const payload = azureDecoded as JwtPayload;
        req.user = {
          id: payload.oid || payload.sub,
          email: payload.email || payload.preferred_username || "",
          name: payload.name,
        };
        ensureAzureUserSeeded(payload).finally(() => next());
        return;
      }

      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        req.user = undefined;
        next();
        return;
      }

      try {
        const decoded = jwt.verify(token, jwtSecret) as JwtPayload;
        req.user = {
          id: decoded.sub,
          email: decoded.email || decoded.preferred_username || "",
          name: decoded.name,
          role: decoded.role,
        };
      } catch (_error) {
        req.user = undefined;
      }

      next();
    }
  );
}

/**
 * Role-based authorization middleware
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Authentication required",
      });
      return;
    }

    if (!roles.includes(req.user.role || "")) {
      res.status(403).json({
        error: "Forbidden",
        message: "Insufficient permissions",
      });
      return;
    }

    next();
  };
}
