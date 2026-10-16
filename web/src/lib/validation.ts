import { z } from "zod"

// The same limits as the server's, so most mistakes are caught before a request is sent.

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter an email address.")
  .max(254, "Email must be at most 254 characters.")
  .regex(/^[^@]+@[^@]+$/, "Enter a valid email address.")

export const personNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(100, "Name must be at most 100 characters.")

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, "Workspace name is required.")
  .max(80, "Workspace name must be at most 80 characters.")

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(256, "Password must be at most 256 characters.")

/** The name of a version, time range or other part of a model's structure. */
export const structureNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(80, "Name must be at most 80 characters.")
