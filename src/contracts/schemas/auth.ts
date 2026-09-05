import { z } from 'zod';

import { humanNameSchema } from './common.js';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'Email addresses must be 254 characters or fewer.')
  .pipe(z.email('Enter a valid email address.'));

/**
 * Length is the requirement that actually resists offline cracking, so the
 * minimum is 12 rather than 8. A character-class rule is deliberately omitted:
 * it pushes users toward predictable substitutions without adding entropy.
 */
export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`);

export const registerSchema = z.object({
  name: humanNameSchema,
  email: emailSchema,
  password: passwordSchema,
});

/**
 * `z.input` and `z.infer` differ wherever a schema has a `.default()` or a
 * transform: the browser form holds the *input* shape while the parsed result
 * is the *output* shape. React Hook Form needs both, so both are exported.
 */
export type RegisterFormValues = z.input<typeof registerSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
  rememberMe: z.boolean().default(true),
});

export type LoginFormValues = z.input<typeof loginSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export type ForgotPasswordFormValues = z.input<typeof forgotPasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'This reset link is invalid.'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export type ResetPasswordFormValues = z.input<typeof resetPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'This verification link is invalid.'),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
