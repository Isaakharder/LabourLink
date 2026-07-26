import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AuthEmployee } from "../types/express";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set");
}

export const SESSION_COOKIE = "labourlink_session";

export function signSession(employee: AuthEmployee): string {
  return jwt.sign(employee, JWT_SECRET as string, { expiresIn: "12h" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET as string) as AuthEmployee;
    req.employee = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired or invalid" });
  }
}

export function requireRole(...allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.employee) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!allowed.includes(req.employee.securityRole)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
