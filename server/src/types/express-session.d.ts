import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    companyId?: number;
    userAgent?: string;
    ipAddress?: string;
  }
}
