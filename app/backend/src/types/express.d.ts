// Extend Express Request interface to include user from auth middleware
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

export {};
