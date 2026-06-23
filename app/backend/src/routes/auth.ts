/**
 * Auth Routes - Authentication (JWT-based)
 * Supports email/password, Google OAuth, and Azure AD OAuth
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication endpoints
 */
import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Errors } from "../middleware/errorHandler";
import { logger } from "../utils/logger";
import db from "../utils/database";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

const router = Router();

// OAuth Configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const AZURE_AD_CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const AZURE_AD_CLIENT_SECRET = process.env.AZURE_AD_CLIENT_SECRET;
const AZURE_AD_TENANT_ID = process.env.AZURE_AD_TENANT_ID || "common";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// Number of bcrypt salt rounds. 12 is a sensible default for interactive logins.
const BCRYPT_SALT_ROUNDS = 12;

/**
 * Hash a plaintext password using bcrypt (salted, adaptive).
 * @param password - The plaintext password to hash.
 * @returns A bcrypt hash string safe to persist.
 * @example const hash = await hashPassword('s3cret');
 */
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored hash.
 * Supports transparent verification of legacy unsalted SHA-256 hashes
 * (64-char hex) so pre-existing accounts are not locked out; callers should
 * re-hash with bcrypt on a successful legacy match.
 * @param password - The plaintext password supplied by the user.
 * @param storedHash - The hash currently persisted for the user.
 * @returns Object indicating whether the password matched and whether the
 *   stored hash is a legacy format that should be upgraded.
 */
async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<{ valid: boolean; legacy: boolean }> {
  if (!storedHash) return { valid: false, legacy: false };

  // Legacy unsalted SHA-256 hashes are 64 lowercase hex characters.
  const isLegacySha256 = /^[a-f0-9]{64}$/.test(storedHash);
  if (isLegacySha256) {
    // SHA-256 is intentionally used here ONLY to verify a pre-existing legacy
    // hash so the account is not locked out; on a successful match the caller
    // immediately re-hashes the password with bcrypt (see the login handler).
    // No new password is ever stored with SHA-256.
    // codeql[js/insufficient-password-hash]
    const legacyHash = crypto
      .createHash("sha256")
      .update(password)
      .digest("hex");
    const valid = crypto.timingSafeEqual(
      Buffer.from(legacyHash),
      Buffer.from(storedHash),
    );
    return { valid, legacy: valid };
  }

  const valid = await bcrypt.compare(password, storedHash);
  return { valid, legacy: false };
}

function generateToken(user: {
  id: string;
  email: string;
  role?: string;
  name?: string;
}): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Errors.internal("JWT_SECRET not configured");
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    secret,
    { expiresIn: "7d" },
  );
}

// Generate a random state for OAuth CSRF protection
function generateOAuthState(): string {
  return crypto.randomBytes(32).toString("hex");
}

// Create or update user from OAuth provider
async function upsertOAuthUser(profile: {
  email: string;
  name?: string;
  provider: string;
  providerId: string;
  avatar?: string;
}): Promise<{ id: string; email: string; name?: string; role?: string }> {
  // Check if user exists
  const { rows: existing } = await db.query(
    "SELECT id, email, role, (raw_user_meta_data->>'name') as name FROM auth.users WHERE email = $1",
    [profile.email.toLowerCase()],
  );

  if (existing.length > 0) {
    // Update existing user with OAuth info
    await db.query(
      `UPDATE auth.users SET 
        raw_user_meta_data = raw_user_meta_data || $1::jsonb,
        updated_at = NOW()
       WHERE id = $2`,
      [
        JSON.stringify({
          name: profile.name || existing[0].name,
          avatar_url: profile.avatar,
          [`${profile.provider}_id`]: profile.providerId,
        }),
        existing[0].id,
      ],
    );
    return existing[0];
  }

  // Create new user
  const id = uuidv4();
  const userMetadata = {
    name: profile.name || profile.email.split("@")[0],
    avatar_url: profile.avatar,
    [`${profile.provider}_id`]: profile.providerId,
  };

  const { rows } = await db.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW()) 
     RETURNING id, email, (raw_user_meta_data->>'name') as name, role`,
    [id, profile.email.toLowerCase(), JSON.stringify(userMetadata)],
  );

  return rows[0];
}

/**
 * @swagger
 * /auth/signup:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AuthCredentials'
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       409:
 *         description: User already exists
 */
router.post("/signup", async (req: Request, res: Response) => {
  const { email, password, name } = req.body;

  if (!email || !password) {
    throw Errors.badRequest("Email and password are required");
  }

  // Check if user exists
  const { rows: existing } = await db.query(
    "SELECT id FROM auth.users WHERE email = $1",
    [email.toLowerCase()],
  );

  if (existing.length > 0) {
    throw Errors.conflict("User with this email already exists");
  }

  const id = uuidv4();
  const passwordHash = await hashPassword(password);
  const userMetadata = { name: name || email.split("@")[0] };

  const { rows } = await db.query(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW()) 
     RETURNING id, email, (raw_user_meta_data->>'name') as name`,
    [id, email.toLowerCase(), passwordHash, JSON.stringify(userMetadata)],
  );

  const user = rows[0];
  const token = generateToken(user);

  logger.info(`User registered: ${email}`);
  res.status(201).json({ user, token });
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Authenticate user and get JWT token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw Errors.badRequest("Email and password are required");
  }

  const { rows } = await db.query(
    "SELECT id, email, encrypted_password, role, (raw_user_meta_data->>'name') as name FROM auth.users WHERE email = $1",
    [email.toLowerCase()],
  );

  if (rows.length === 0) {
    throw Errors.unauthorized("Invalid email or password");
  }

  const user = rows[0];
  const { valid, legacy } = await verifyPassword(
    password,
    user.encrypted_password,
  );

  if (!valid) {
    throw Errors.unauthorized("Invalid email or password");
  }

  // Transparently upgrade legacy unsalted SHA-256 hashes to bcrypt on login.
  if (legacy) {
    const upgradedHash = await hashPassword(password);
    await db.query(
      "UPDATE auth.users SET encrypted_password = $1, updated_at = NOW() WHERE id = $2",
      [upgradedHash, user.id],
    );
  }

  const token = generateToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  logger.info(`User logged in: ${email}`);
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token,
  });
});

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh JWT token
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token refreshed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post("/refresh", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw Errors.unauthorized("No token provided");
  }

  const token = authHeader.split(" ")[1];
  const secret = process.env.JWT_SECRET;
  if (!secret) throw Errors.internal("JWT_SECRET not configured");

  try {
    const decoded = jwt.verify(token, secret, { ignoreExpiration: true }) as {
      sub: string;
    };

    // Verify user still exists
    const { rows } = await db.query(
      "SELECT id, email, role FROM auth.users WHERE id = $1",
      [decoded.sub],
    );

    if (rows.length === 0) {
      throw Errors.unauthorized("User not found");
    }

    const newToken = generateToken(rows[0]);
    res.json({ token: newToken });
  } catch (error) {
    throw Errors.unauthorized("Invalid token");
  }
});

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout (client-side token invalidation)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
router.post("/logout", (_req: Request, res: Response) => {
  // JWT tokens are stateless - logout is handled client-side
  res.json({ message: "Logged out successfully" });
});

// ============================================================================
// OAuth Routes - Google
// ============================================================================

/**
 * @swagger
 * /auth/oauth/google:
 *   get:
 *     summary: Initiate Google OAuth login
 *     tags: [Auth]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: redirectTo
 *         schema:
 *           type: string
 *         description: URL to redirect after authentication
 *     responses:
 *       302:
 *         description: Redirect to Google OAuth
 */
router.get("/oauth/google", (req: Request, res: Response) => {
  if (!GOOGLE_CLIENT_ID) {
    throw Errors.internal("Google OAuth not configured");
  }

  const redirectTo = (req.query.redirectTo as string) || "/dashboard";
  const state = Buffer.from(
    JSON.stringify({
      csrf: generateOAuthState(),
      redirectTo,
    }),
  ).toString("base64");

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${req.protocol}://${req.get("host")}/api/v1/auth/oauth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "offline",
    prompt: "select_account",
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

/**
 * @swagger
 * /auth/oauth/google/callback:
 *   get:
 *     summary: Google OAuth callback
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirect to frontend with token
 */
router.get("/oauth/google/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.redirect(
      `${FRONTEND_URL}/auth?error=oauth_failed&message=Missing+code+or+state`,
    );
  }

  try {
    // Parse state to get redirect URL
    const stateData = JSON.parse(
      Buffer.from(state as string, "base64").toString(),
    );
    const redirectTo = stateData.redirectTo || "/dashboard";

    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID!,
        client_secret: GOOGLE_CLIENT_SECRET!,
        code: code as string,
        grant_type: "authorization_code",
        redirect_uri: `${req.protocol}://${req.get("host")}/api/v1/auth/oauth/google/callback`,
      }),
    });

    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
    };

    if (!tokens.access_token) {
      logger.error("Google OAuth token exchange failed:", tokens);
      return res.redirect(
        `${FRONTEND_URL}/auth?error=oauth_failed&message=Token+exchange+failed`,
      );
    }

    // Get user info
    const userInfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    );

    const userInfo = (await userInfoResponse.json()) as {
      email?: string;
      name?: string;
      sub?: string;
      picture?: string;
    };

    if (!userInfo.email) {
      return res.redirect(
        `${FRONTEND_URL}/auth?error=oauth_failed&message=No+email+in+profile`,
      );
    }

    // Create or update user
    const user = await upsertOAuthUser({
      email: userInfo.email,
      name: userInfo.name,
      provider: "google",
      providerId: userInfo.sub || "",
      avatar: userInfo.picture,
    });

    // Generate JWT token
    const token = generateToken(user);

    logger.info(`User logged in via Google: ${userInfo.email}`);

    // Redirect to frontend with token
    res.redirect(
      `${FRONTEND_URL}/auth/callback?token=${token}&redirectTo=${encodeURIComponent(redirectTo)}`,
    );
  } catch (error: any) {
    logger.error("Google OAuth error:", error);
    res.redirect(
      `${FRONTEND_URL}/auth?error=oauth_failed&message=${encodeURIComponent(error.message)}`,
    );
  }
});

// ============================================================================
// OAuth Routes - Azure AD
// ============================================================================

/**
 * @swagger
 * /auth/oauth/azure:
 *   get:
 *     summary: Initiate Azure AD OAuth login
 *     tags: [Auth]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: redirectTo
 *         schema:
 *           type: string
 *         description: URL to redirect after authentication
 *     responses:
 *       302:
 *         description: Redirect to Azure AD OAuth
 */
router.get("/oauth/azure", (req: Request, res: Response) => {
  if (!AZURE_AD_CLIENT_ID) {
    throw Errors.internal("Azure AD OAuth not configured");
  }

  const redirectTo = (req.query.redirectTo as string) || "/dashboard";
  const state = Buffer.from(
    JSON.stringify({
      csrf: generateOAuthState(),
      redirectTo,
    }),
  ).toString("base64");

  const params = new URLSearchParams({
    client_id: AZURE_AD_CLIENT_ID,
    redirect_uri: `${req.protocol}://${req.get("host")}/api/v1/auth/oauth/azure/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    response_mode: "query",
  });

  res.redirect(
    `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/oauth2/v2.0/authorize?${params}`,
  );
});

/**
 * @swagger
 * /auth/oauth/azure/callback:
 *   get:
 *     summary: Azure AD OAuth callback
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirect to frontend with token
 */
router.get("/oauth/azure/callback", async (req: Request, res: Response) => {
  // The OAuth 2.0 authorization-code flow REQUIRES the provider to return the
  // `code` (and `state`) on the GET callback URL — this is mandated by the spec
  // and cannot be moved to a POST body. The code is single-use, short-lived,
  // and immediately exchanged server-side over TLS, so reading it from the
  // query string here is safe and unavoidable.
  // codeql[js/sensitive-get-query]
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    // Do not log or reflect provider-supplied OAuth error fields (both the
    // error code and description are attacker-influenceable query params). A
    // static message avoids clear-text logging of request-derived data.
    logger.error("Azure OAuth provider returned an error on callback");
    return res.redirect(
      `${FRONTEND_URL}/auth?error=oauth_failed&message=${encodeURIComponent("OAuth failed")}`,
    );
  }

  if (!code || !state) {
    return res.redirect(
      `${FRONTEND_URL}/auth?error=oauth_failed&message=Missing+code+or+state`,
    );
  }

  try {
    // Parse state to get redirect URL
    const stateData = JSON.parse(
      Buffer.from(state as string, "base64").toString(),
    );
    const redirectTo = stateData.redirectTo || "/dashboard";

    // Exchange code for tokens
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: AZURE_AD_CLIENT_ID!,
          client_secret: AZURE_AD_CLIENT_SECRET!,
          code: code as string,
          grant_type: "authorization_code",
          redirect_uri: `${req.protocol}://${req.get("host")}/api/v1/auth/oauth/azure/callback`,
          scope: "openid email profile",
        }),
      },
    );

    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
    };

    if (!tokens.access_token) {
      logger.error("Azure OAuth token exchange failed:", tokens);
      return res.redirect(
        `${FRONTEND_URL}/auth?error=oauth_failed&message=Token+exchange+failed`,
      );
    }

    // Get user info from Microsoft Graph
    const userInfoResponse = await fetch(
      "https://graph.microsoft.com/v1.0/me",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    );

    const userInfo = (await userInfoResponse.json()) as {
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
      id?: string;
    };

    // Azure may provide email in different fields
    const email = userInfo.mail || userInfo.userPrincipalName;

    if (!email) {
      return res.redirect(
        `${FRONTEND_URL}/auth?error=oauth_failed&message=No+email+in+profile`,
      );
    }

    // Create or update user
    const user = await upsertOAuthUser({
      email: email,
      name: userInfo.displayName,
      provider: "azure",
      providerId: userInfo.id || "",
    });

    // Generate JWT token
    const token = generateToken(user);

    logger.info(`User logged in via Azure AD: ${email}`);

    // Redirect to frontend with token
    res.redirect(
      `${FRONTEND_URL}/auth/callback?token=${token}&redirectTo=${encodeURIComponent(redirectTo)}`,
    );
  } catch (error: any) {
    logger.error("Azure OAuth error:", error);
    res.redirect(
      `${FRONTEND_URL}/auth?error=oauth_failed&message=${encodeURIComponent(error.message)}`,
    );
  }
});

// ============================================================================
// Password Reset - Using existing Azure AD auth schema
// ============================================================================

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Request password reset email
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Reset email sent (or user not found, same response for security)
 */
router.post("/reset-password", async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    throw Errors.badRequest("Email is required");
  }

  // Check if user exists (but don't reveal if not)
  const { rows } = await db.query(
    "SELECT id, email FROM auth.users WHERE email = $1",
    [email.toLowerCase()],
  );

  if (rows.length > 0) {
    const userId = rows[0].id;

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    const tokenId = uuidv4();

    // Store in auth.one_time_tokens
    // First, delete any existing recovery tokens for this user
    await db.query(
      "DELETE FROM auth.one_time_tokens WHERE user_id = $1 AND token_type = 'recovery_token'",
      [userId],
    );

    // Insert new recovery token
    await db.query(
      `INSERT INTO auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
       VALUES ($1, $2, 'recovery_token', $3, $4, NOW(), NOW())`,
      [tokenId, userId, tokenHash, email.toLowerCase()],
    );

    // Also update recovery_token in auth.users for compatibility
    await db.query(
      "UPDATE auth.users SET recovery_token = $1, recovery_sent_at = NOW(), updated_at = NOW() WHERE id = $2",
      [resetToken, userId],
    );

    // TODO: Send email with reset link
    // For now, log the reset link (in production, send via email service)
    const resetLink = `${FRONTEND_URL}/auth?recovery=true&token=${resetToken}`;
    logger.info(
      `Password reset requested for ${email}. Reset link: ${resetLink}`,
    );
  }

  // Always return success to prevent email enumeration
  res.json({
    message:
      "If an account exists with that email, a password reset link has been sent.",
  });
});

/**
 * @swagger
 * /auth/update-password:
 *   post:
 *     summary: Update password with reset token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - password
 *             properties:
 *               token:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password updated successfully
 *       400:
 *         description: Invalid or expired token
 */
router.post("/update-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;

  if (!token || !password) {
    throw Errors.badRequest("Token and password are required");
  }

  // Hash the token to compare with stored hash
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  // Find valid reset token in auth.one_time_tokens (expires after 1 hour)
  const { rows } = await db.query(
    `SELECT user_id FROM auth.one_time_tokens 
     WHERE token_hash = $1 
     AND token_type = 'recovery_token'
     AND created_at > NOW() - INTERVAL '1 hour'`,
    [tokenHash],
  );

  // Also check auth.users.recovery_token as fallback
  let userId: string | null = null;

  if (rows.length > 0) {
    userId = rows[0].user_id;
  } else {
    // Fallback: check recovery_token column in auth.users
    const { rows: userRows } = await db.query(
      `SELECT id FROM auth.users 
       WHERE recovery_token = $1 
       AND recovery_sent_at > NOW() - INTERVAL '1 hour'`,
      [token],
    );
    if (userRows.length > 0) {
      userId = userRows[0].id;
    }
  }

  if (!userId) {
    throw Errors.badRequest("Invalid or expired reset token");
  }

  const passwordHash = await hashPassword(password);

  // Update password
  await db.query(
    `UPDATE auth.users SET 
      encrypted_password = $1, 
      recovery_token = NULL, 
      recovery_sent_at = NULL,
      updated_at = NOW() 
     WHERE id = $2`,
    [passwordHash, userId],
  );

  // Delete used token from one_time_tokens
  await db.query(
    "DELETE FROM auth.one_time_tokens WHERE user_id = $1 AND token_type = 'recovery_token'",
    [userId],
  );

  logger.info(`Password updated for user ${userId}`);
  res.json({ message: "Password updated successfully" });
});

export default router;
