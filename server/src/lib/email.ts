import { Resend } from "resend";

let client: Resend | null = null;

function getClient(): Resend {
  if (client) return client;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY must be set to send reset emails");
  }
  client = new Resend(apiKey);
  return client;
}

export async function sendPinResetEmail(
  to: string,
  firstName: string,
  resetUrl: string
): Promise<void> {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error("RESEND_FROM_EMAIL must be set to send reset emails");
  }

  const { error } = await getClient().emails.send({
    from,
    to,
    subject: "Reset your LabourLink PIN",
    html: `<p>Hi ${firstName},</p>
<p>Click the link below to set a new PIN. This link expires in 30 minutes and can only be used once.</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>If you didn't request this, you can safely ignore this email.</p>`,
  });

  if (error) {
    throw new Error(`Failed to send reset email: ${error.message}`);
  }
}
