import { Response } from "express";

export type ApiSuccess<T> = { success: true; data: T };
export type ApiError = { success: false; error: string; code?: string };

export function success<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data } satisfies ApiSuccess<T>);
}

export function error(
  res: Response,
  message: string,
  status = 400,
  code?: string
) {
  return res
    .status(status)
    .json({ success: false, error: message, code } satisfies ApiError);
}
