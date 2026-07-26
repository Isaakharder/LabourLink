import "express";

export interface AuthEmployee {
  id: string;
  firstName: string;
  lastName: string;
  securityRole: string;
  teamRole: string;
}

declare global {
  namespace Express {
    interface Request {
      employee?: AuthEmployee;
    }
  }
}
