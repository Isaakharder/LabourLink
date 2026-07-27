import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does not forward rejected promises from async handlers to error
// middleware — an unhandled rejection just crashes the process (Node 15+
// terminates on unhandled rejections). Every async route must be wrapped in
// this so DB/network failures become a clean 500 instead of taking the
// whole server down.
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
